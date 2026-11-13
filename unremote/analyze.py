"""Analyzer: turn raw captured traffic plus the explorer's action log into an API map.

What it works out, without any LLM:
  - endpoint templates      /v2/shows/29418/seatmap  ->  /v2/shows/{show_id}/seatmap
  - where each value comes from (the show_id in this request came from shows[*].show_id in that response)
  - how login works (which call returns the token, which header carries it, how it refreshes)
  - which headers are constant (device id, app version) and must be replayed
  - which calls are noise (analytics, startup config) rather than user features
  - which tap on which screen triggered each call
"""
import argparse
import json
import os
import re
from collections import Counter, defaultdict

ID_SEG = re.compile(r"^(\d+|[a-z]{1,4}_[0-9a-z]{4,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,})$", re.I)
SKIP_HEADERS = {"host", "content-length", "connection", "accept-encoding", "content-type", "authorization", "user-agent",
                "cookie", "x-forwarded-for", "if-none-match", "if-modified-since"}
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NOT_LANG = {"api", "www", "cdn", "img", "app", "web", "dev", "beta", "mail", "ads", "cms", "auth", "gw", "m", "mob",
            "static", "media", "assets", "pay", "id", "sso", "ws", "rt", "edge", "stg", "qa", "uat", "prd", "eu", "us"}


def is_lang(label):
    return bool(re.fullmatch(r"[a-z]{2,3}(-[a-z]+)?", label)) and label not in NOT_LANG
ANALYTICS_HOST = re.compile(r"(analytics|intake|logging|telemetry|metrics|beacon|crash|sentry|segment|amplitude|mixpanel)", re.I)
ASSET_PATH = re.compile(r"(/data/(css|javascript|i18n)/|\.(css|js|map)$|/fonts?/)", re.I)
EMULATOR_HOST = "10.0.2.2"  # the Android emulator's name for the host machine


def leaves(obj, path="$"):
    """Yield (json_path, value) for every scalar in a JSON value. Array indices become [*]."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from leaves(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for v in obj:
            yield from leaves(v, f"{path}[*]")
    elif obj is not None:
        yield path, obj


def shape(obj, depth=0):
    """A compact type sketch of a JSON value (first element of arrays only)."""
    if depth > 5:
        return "…"
    if isinstance(obj, dict):
        return {k: shape(v, depth + 1) for k, v in obj.items()}
    if isinstance(obj, list):
        return [shape(obj[0], depth + 1)] if obj else []
    return type(obj).__name__


def interesting(v):
    s = str(v)
    return len(s) >= 3 and s.lower() not in ("true", "false", "null", "none")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    args = p.parse_args()
    flows = [json.loads(l) for l in open(os.path.join(args.run, "flows.jsonl"))]
    actions = [json.loads(l) for l in open(os.path.join(args.run, "actions.jsonl"))]
    flows.sort(key=lambda f: f["t0"])

    # 1. Hosts. Images and media are dropped. Hosts that differ only in their first label
    #    (en.wikipedia.org, af.wikipedia.org, …) become one templated host: https://{lang}.wikipedia.org.
    #    The main host is the busiest one that is not an analytics host.
    flows = [f for f in flows if not re.search(r"\.(png|jpe?g|webp|gif|svg|mp4|woff2?)$", f["path"], re.I)]
    labels = defaultdict(set)
    for f in flows:
        first, _, rest = f["host"].partition(".")
        if rest.count("."):
            labels[rest].add(first)
    # Only language-code subdomains are merged; meta. and intake-analytics. are different services.
    templated = {rest: "lang" for rest, ls in labels.items() if len([l for l in ls if is_lang(l)]) >= 2}

    def lang_label(f):
        first, _, rest = f["host"].partition(".")
        return rest in templated and is_lang(first)
    candidates = Counter((f["host"], f["port"]) for f in flows if f["method"] == "GET" and not ANALYTICS_HOST.search(f["host"]))
    host, port = (candidates or Counter((f["host"], f["port"]) for f in flows)).most_common(1)[0][0]
    multi_host = len({(f["host"], f["port"]) for f in flows}) > 1

    def origin(f):
        first, _, rest = f["host"].partition(".")
        h = "127.0.0.1" if f["host"] == EMULATOR_HOST else (f"{{lang}}.{rest}" if lang_label(f) else f["host"])
        scheme = f.get("scheme") or "https"
        default = 443 if scheme == "https" else 80
        return f"{scheme}://{h}" + ("" if f["port"] == default else f":{f['port']}")

    # 2. Path templates. A segment is a parameter if (a) it looks like an id, (b) it varies across calls that
    #    are otherwise identical, or (c) its value appeared in an earlier response (e.g. an article title
    #    taken from search results). Its name comes from the segment before it.
    resp_values = []
    for f in flows:
        resp_values.append((f["t1"], {str(v) for _, v in leaves(f.get("resp_body")) if interesting(v)}))
    from urllib.parse import unquote

    def seen_before(value, t0):
        v1, v2 = value, unquote(value).replace("_", " ")
        return any(t1 <= t0 and (v1 in vals or v2 in vals) for t1, vals in resp_values)

    variants = defaultdict(set)
    for f in flows:
        segs = f["path"].strip("/").split("/")
        f["_segs"] = segs
        for i in range(len(segs)):
            variants[(f["method"], len(segs), tuple(s if j != i else "*" for j, s in enumerate(segs)))].add(segs[i])
    for f in flows:
        segs = f["_segs"]
        f["_params"] = {}
        if lang_label(f):
            f["_params"]["lang"] = f["host"].partition(".")[0]
        tsegs = []
        dated = set()
        for i in range(len(segs) - 2):  # yyyy/mm/dd in a path
            if re.fullmatch(r"(19|20)\d\d", segs[i]) and re.fullmatch(r"\d\d", segs[i + 1]) and re.fullmatch(r"\d\d", segs[i + 2]):
                dated |= {i, i + 1, i + 2}
        for i in range(len(segs) - 1):  # mm/dd at the end (e.g. on-this-day)
            if (not dated and i == len(segs) - 2 and re.fullmatch(r"(0[1-9]|1[0-2])", segs[i])
                    and re.fullmatch(r"(0[1-9]|[12]\d|3[01])", segs[i + 1]) and not (i and segs[i - 1].isdigit())):
                dated |= {i, i + 1}
        names = {}
        if dated:
            idx = sorted(dated)
            for n, i in zip((["year", "month", "day"] if len(idx) == 3 else ["month", "day"]), idx):
                names[i] = n
        for i, s in enumerate(segs):
            if i in names:
                f["_params"][names[i]] = s
                tsegs.append("{" + names[i] + "}")
                continue
            # A varying segment is data only if some of its values came from earlier responses; otherwise the
            # variants are just different resources (/v2/cities vs /v2/movies).
            alts = variants[(f["method"], len(segs), tuple(x if j != i else "*" for j, x in enumerate(segs)))]
            data_like = len(s) > 2 and seen_before(s, f["t0"])
            # It varies like data if every value seen in this position came from some response
            # (Solar_System, Sonnestelsel), not like resource names (summary, mobile-html).
            varies = len(alts) > 1 and all(len(a) > 2 and seen_before(a, 1e18) for a in alts)
            name_like = not re.fullmatch(r"[a-z][a-z0-9-]*", s)  # titles, slugs with capitals, escapes
            if i > 0 and (ID_SEG.match(s) or (data_like and (varies or name_like))):
                prev = segs[i - 1]
                name = re.sub(r"\W", "_", (prev[:-1] if prev.endswith("s") else prev)) + ("_id" if ID_SEG.match(s) else "")
                name = name if name not in f["_params"] else name + str(i)
                f["_params"][name] = unquote(s)
                tsegs.append("{" + name + "}")
            else:
                tsegs.append(s)
        f["_template"] = "/" + "/".join(tsegs)
        f["_key"] = f'{f["method"]} {origin(f) if multi_host else ""}{f["_template"]}'
    # One URL that does different things depending on its query (e.g. /w/api.php?action=..&list=..):
    # split it by the set of query keys, and by the values of keys that never vary within that set.
    by_key = defaultdict(list)
    for f in flows:
        by_key[f["_key"]].append(f)
    for key, fs in by_key.items():
        shapes = {tuple(sorted(f["query"])) for f in fs}
        if len(shapes) > 1:
            for f in fs:
                mode = [k for k in ("action", "list", "prop", "meta", "generator", "op", "operation", "method") if k in f["query"]]
                f["_key"] = key + "?" + "&".join(f"{k}={f['query'][k]}" for k in mode) if mode else key + "?" + ",".join(sorted(f["query"]))

    # 3. Value index: every scalar seen in a response, with where and when.
    seen = []  # (t1, key, path, value)
    for f in flows:
        for path, v in leaves(f.get("resp_body")):
            if interesting(v):
                seen.append((f["t1"], f["_key"], path, str(v)))
    typed = [a["action"] for a in actions if a["action"].startswith("type ")]

    def source_of(value, t0):
        value = str(value)
        alt = unquote(value).replace("_", " ")
        best = None
        for t1, key, path, v in seen:
            if t1 <= t0 and (v == value or v == alt):
                best = {"from": key, "path": path}
        if best:
            return best
        if any(f'"{value}"' in a for a in typed):
            return {"from": "user_input"}
        if DATE.match(value):
            return {"from": "user_choice", "kind": "date"}
        return {"from": "user_choice"}

    # 4. Auth: find the bearer token, the call that issued it, and the refresh call.
    auth = {"scheme": None}
    for f in flows:
        h = {k.lower(): v for k, v in f["req_headers"].items()}
        if h.get("authorization", "").lower().startswith("bearer "):
            tok = h["authorization"][7:]
            src = source_of(tok, f["t0"])
            if src.get("from") not in (None, "user_choice", "user_input"):
                auth = {"scheme": "bearer", "header": "authorization", "token_from": src}
                break
    login_key = refresh_key = None
    for f in flows:
        body = f.get("req_body") if isinstance(f.get("req_body"), dict) else {}
        keys = " ".join(body.keys()).lower()
        if "password" in keys and f["status"] < 400:
            login_key = f["_key"]
            auth["login"] = {"endpoint": f["_key"], "body_fields": list(body.keys())}
        elif "refresh" in keys:
            refresh_key = f["_key"]
            rk = next(k for k in body if "refresh" in k.lower())
            auth["refresh"] = {"endpoint": f["_key"], "body_field": rk, "value_from": source_of(body[rk], f["t0"])}
    if login_key:
        lf = next(f for f in flows if f["_key"] == login_key and f["status"] < 400)
        for path, v in leaves(lf.get("resp_body")):
            if "access" in path or path.endswith(".token"):
                auth.setdefault("token_path", path)
            if "refresh" in path:
                auth.setdefault("refresh_token_path", path)
            if "expires" in path:
                auth["expires_in_s"] = v

    # 5. Constant headers to replay on every call.
    hdrs, seen_on = defaultdict(set), Counter()
    for f in flows:
        for k, v in f["req_headers"].items():
            if k.lower() not in SKIP_HEADERS:
                hdrs[k.lower()].add(v)
                seen_on[k.lower()] += 1
    constant_headers = {k: next(iter(v)) for k, v in hdrs.items() if len(v) == 1 and seen_on[k] >= 0.6 * len(flows)}

    # 6. Group by endpoint and describe each one.
    first_tap = min((a["t"] for a in actions if a["action"] not in ("launch",)), default=0)
    endpoints = {}
    for f in flows:
        e = endpoints.setdefault(f["_key"], {"method": f["method"], "template": f["_template"], "calls": 0, "statuses": Counter(),
                                             "params": {}, "query": {}, "body": {}, "triggers": [], "examples": [],
                                             "needs_auth": False, "held": False, "response_shape": None})
        e["calls"] += 1
        e["statuses"][f["status"]] += 1
        e["held"] |= f["held"]
        h = {k.lower(): v for k, v in f["req_headers"].items()}
        e["needs_auth"] |= "authorization" in h
        if f["status"] < 400 and e["response_shape"] is None and f.get("resp_body") is not None:
            e["response_shape"] = shape(f["resp_body"])
        for name, v in f["_params"].items():
            e["params"].setdefault(name, {"examples": [], "source": source_of(v, f["t0"])})["examples"].append(v)
        for name, v in f["query"].items():
            e["query"].setdefault(name, {"examples": [], "source": source_of(v, f["t0"])})["examples"].append(v)
        if isinstance(f.get("req_body"), dict) and f["_key"] not in (login_key, refresh_key):
            for path, v in leaves(f["req_body"]):
                e["body"].setdefault(path, {"examples": [], "source": source_of(v, f["t0"])})["examples"].append(v)
        trig = [a for a in actions if a["t"] <= f["t0"] and f["t0"] - a["t"] < 4]
        if trig:
            a = trig[-1]
            e["triggers"].append({"action": a["action"], "screen": a["screen"], "goal": a.get("goal")})
        if len(e["examples"]) < 2:
            e["examples"].append({"path": f["path"], "query": f["query"], "status": f["status"]})
        e.setdefault("_first", f["t0"])

    # 7. Noise: telemetry (many calls, trivial reply, event-like body) and bootstrap (only before the first tap).
    for key, e in endpoints.items():
        trivial = e["response_shape"] in ({"ok": "bool"}, {}, None) and not e["held"]
        eventish = any(re.search(r"\.(event|event_name|events|screen|screen_name|ts|timestamp)$", k) for k in e["body"])
        named = ANALYTICS_HOST.search(key.split(" ", 1)[1].split("/")[2] if "://" in key else "") or \
            re.search(r"(_204\b|/csi\b|/log\b|/beacon\b)", key) or \
            (e["method"] != "GET" and re.search(r"/(collect|track|beacon|logs?|telemetry|analytics|events?)(/|\?|$)", key, re.I))
        if named or (trivial and (eventish or e["calls"] >= 4)):
            e["role"] = "telemetry"
        elif ASSET_PATH.search(e["template"]):
            e["role"] = "asset"
        elif key in (login_key, refresh_key):
            e["role"] = "auth"
        elif e["_first"] < first_tap and not e["needs_auth"] and not e["params"] and not e["query"]:
            e["role"] = "bootstrap"
        else:
            e["role"] = "feature"
        e["effect"] = "read" if e["method"] == "GET" else "write"
        e["statuses"] = dict(e["statuses"])
        # A query value is fixed (sent automatically, not an input) when it never changed and did not come from
        # an earlier response, from what the user typed, or from a date the user picked.
        e["fixed_query"] = {n: v["examples"][0] for n, v in e["query"].items()
                            if len(set(map(str, v["examples"]))) == 1 and v["source"].get("from") == "user_choice"
                            and v["source"].get("kind") != "date"}
        for d in (e["params"], e["query"], e["body"]):
            for v in d.values():
                v["examples"] = list(dict.fromkeys(map(str, v["examples"])))[:4]
        e["triggers"] = list({json.dumps(t, sort_keys=True): t for t in e["triggers"]}.values())[:3]
        e.pop("_first")

    base = origin(next(f for f in flows if (f["host"], f["port"]) == (host, port)))
    api = {"base_url": base, "captured_host": f"{host}:{port}", "auth": auth, "constant_headers": constant_headers,
           "endpoints": endpoints, "stats": {"flows": len(flows), "actions": len(actions)}}
    json.dump(api, open(os.path.join(args.run, "api_map.json"), "w"), indent=2, default=str)

    print(f"{len(flows)} requests on {host}:{port}, {len(endpoints)} endpoints, {len(actions)} actions")
    print("auth:", json.dumps({k: auth.get(k) for k in ("scheme", "token_path", "refresh_token_path")}))
    for key, e in sorted(endpoints.items(), key=lambda kv: kv[1]["role"]):
        trig = e["triggers"][0]["action"] if e["triggers"] else "-"
        srcs = {n: v["source"].get("from") + (":" + v["source"]["path"] if "path" in v["source"] else "")
                for n, v in {**e["params"], **e["query"], **e["body"]}.items()}
        print(f"  [{e['role']:9}] {key:42} x{e['calls']:<2} ← {trig[:38]:38} {srcs if srcs else ''}")


if __name__ == "__main__":
    main()
