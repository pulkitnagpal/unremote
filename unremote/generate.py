"""Generator: write a standalone MCP server for the app from the API map and the tool design. No LLM here."""
import argparse
import json
import os
import re
import shutil
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--out", required=True)
    args = p.parse_args()
    api = json.load(open(os.path.join(args.run, "api_map.json")))
    design = json.load(open(os.path.join(args.run, "tools.json")))
    os.makedirs(args.out, exist_ok=True)

    for t in design["tools"]:
        e = api["endpoints"].get(t["endpoint"]) or {}
        t["fixed"] = e.get("fixed_query", {})
        t["inputs"] = [i for i in t.get("inputs", []) if not (i["in"] == "query" and i["field"] in t["fixed"])]
    auth = api["auth"]
    login = auth.get("login")
    env_prefix = design["server_name"].upper().replace("-", "_")
    # Per-install ids the app sends (device id, install uuid) are never reused from the capture:
    # each generated server gets its own fresh one.
    headers = {k: (str(uuid.uuid4()) if UUID.fullmatch(str(v)) else v) for k, v in api["constant_headers"].items()}
    config = {
        "name": design["server_name"],
        "base_url": api["base_url"],
        "headers": headers,
        "auth": None if not login else {
            "login": {"endpoint": login["endpoint"], "fields": {f: f"{env_prefix}_{f.upper()}" for f in login["body_fields"]}},
            "token_path": auth.get("token_path"),
            "refresh_token_path": auth.get("refresh_token_path"),
            "refresh": auth.get("refresh") and {"endpoint": auth["refresh"]["endpoint"], "field": auth["refresh"]["body_field"]},
            "header": auth.get("header", "authorization"),
        },
        "tools": design["tools"],
    }
    json.dump(config, open(os.path.join(args.out, "unremote.config.json"), "w"), indent=2)

    # Example arguments for each read tool, taken from what the app really sent, so the server can be checked.
    checks = []
    for t in design["tools"]:
        e = api["endpoints"].get(t["endpoint"])
        if not e or t["effect"] != "read":
            continue
        ex = {}
        for inp in t.get("inputs", []):
            src = {"path": e["params"], "query": e["query"]}.get(inp["in"]) or {}
            vals = (src.get(inp["field"]) or {}).get("examples") or []
            if vals:
                v = vals[0]
                ex[inp["name"]] = int(v) if inp["type"] == "integer" and str(v).isdigit() else v
        checks.append({"tool": t["name"], "args": ex, "expect_keys": sorted((e["response_shape"] or {}).keys())
                       if isinstance(e["response_shape"], dict) else []})
    json.dump(checks, open(os.path.join(args.out, "checks.json"), "w"), indent=2)
    shutil.copy(os.path.join(HERE, "runtime", "verify.mjs"), os.path.join(args.out, "verify.mjs"))
    shutil.copy(os.path.join(HERE, "runtime", "server.mjs"), os.path.join(args.out, "server.mjs"))
    shutil.copy(os.path.join(HERE, "runtime", "client.mjs"), os.path.join(args.out, "client.mjs"))
    json.dump({"name": f"unremote-{design['server_name']}", "type": "module", "private": True,
               "dependencies": {"@modelcontextprotocol/sdk": "^1.12.0", "zod": "^3.24.0"}},
              open(os.path.join(args.out, "package.json"), "w"), indent=2)
    if config["auth"]:
        with open(os.path.join(args.out, ".env.example"), "w") as f:
            for var in config["auth"]["login"]["fields"].values():
                f.write(f"{var}=\n")
    print(f"wrote MCP server for {design['server_name']} with {len(design['tools'])} tools to {args.out}")
    if config["auth"]:
        print("login env vars:", ", ".join(config["auth"]["login"]["fields"].values()))


if __name__ == "__main__":
    main()
