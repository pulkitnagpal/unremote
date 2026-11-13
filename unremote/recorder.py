"""mitmproxy addon: record every request/response the app makes, one JSON line per flow.

Run:  mitmdump -s unremote/recorder.py --set out=runs/<run>/flows.jsonl --set writes=allow
writes=block holds back anything that changes server state (POST/PUT/PATCH/DELETE) except login,
records its shape, and answers the app with 403, so exploring a real app can never book or pay.
"""
import json
import re
import time

from mitmproxy import ctx, http

AUTH_PATH = re.compile(r"(login|signin|sign-in|auth|token|refresh|session)", re.I)
# The emulator's own background traffic is not the app's.
NOISE_HOSTS = re.compile(r"(googleapis|gstatic|google\.com|gvt\d|android\.com|doubleclick|crashlytics|firebase)", re.I)


def _body(raw, ctype):
    if not raw:
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return {"_binary": len(raw)}
    if "json" in (ctype or "") or text[:1] in "{[":
        try:
            return json.loads(text)
        except ValueError:
            pass
    return text[:4000]


class Recorder:
    def load(self, loader):
        loader.add_option("out", str, "flows.jsonl", "Where to write flows")
        loader.add_option("writes", str, "allow", "allow | block state-changing requests")

    def request(self, flow: http.HTTPFlow):
        flow.metadata["t0"] = time.time()
        r = flow.request
        flow.metadata["host"] = r.pretty_host
        if NOISE_HOSTS.search(r.pretty_host):
            return
        if r.host == "10.0.2.2":  # the emulator's name for this Mac; the proxy runs on the Mac, so connect locally
            r.host = "127.0.0.1"
        if ctx.options.writes == "block" and r.method in ("POST", "PUT", "PATCH", "DELETE") and not AUTH_PATH.search(r.path):
            flow.metadata["held"] = True
            flow.response = http.Response.make(403, b'{"error":"held_by_unremote"}', {"content-type": "application/json"})

    def response(self, flow: http.HTTPFlow):
        r, s = flow.request, flow.response
        host = flow.metadata.get("host", r.pretty_host)
        if NOISE_HOSTS.search(host):
            return
        rec = {
            "t0": flow.metadata.get("t0", time.time()),
            "t1": time.time(),
            "method": r.method,
            "scheme": r.scheme,
            "host": host,
            "port": r.port,
            "path": r.path.split("?")[0],
            "query": dict(r.query),
            "req_headers": dict(r.headers),
            # get_content() undoes gzip/brotli; raw_content would be the compressed bytes.
            "req_body": _body(r.get_content(strict=False), r.headers.get("content-type")),
            "status": s.status_code,
            "resp_headers": dict(s.headers),
            "resp_body": _body(s.get_content(strict=False), s.headers.get("content-type")),
            "held": bool(flow.metadata.get("held")),
        }
        with open(ctx.options.out, "a") as f:
            f.write(json.dumps(rec) + "\n")


addons = [Recorder()]
