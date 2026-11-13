"""Ask Claude through the local Claude Code CLI and parse a JSON answer.

Uses whatever login the `claude` CLI already has. Optionally, set CLAUDE_CODE_OAUTH_TOKEN, or set
UNREMOTE_KEYCHAIN_SERVICE to the name of a macOS Keychain item that holds a Claude Code token.
"""
import json
import os
import re
import subprocess

MODEL = os.environ.get("UNREMOTE_MODEL", "sonnet")
_env = None


def environ():
    global _env
    if _env is None:
        _env = dict(os.environ)
        service = os.environ.get("UNREMOTE_KEYCHAIN_SERVICE")
        if service and not _env.get("CLAUDE_CODE_OAUTH_TOKEN"):
            tok = subprocess.run(["security", "find-generic-password", "-s", service, "-w"],
                                 capture_output=True, text=True).stdout.strip()
            if tok:
                _env["CLAUDE_CODE_OAUTH_TOKEN"] = tok  # kept in memory only, never printed or written
    return _env


def ask(prompt, model=MODEL):
    r = subprocess.run(["claude", "-p", prompt, "--model", model, "--tools", ""],
                       capture_output=True, text=True, env=environ(), timeout=180)
    if r.returncode != 0:
        raise RuntimeError("claude failed: " + (r.stderr or r.stdout)[-400:])
    return r.stdout


def ask_json(prompt, model=MODEL):
    out = ask(prompt, model)
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        raise ValueError("no JSON in reply: " + out[:300])
    return json.loads(m.group(0))
