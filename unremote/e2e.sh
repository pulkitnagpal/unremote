#!/usr/bin/env bash
# End-to-end check: Claude Code gets ONLY the generated MCP server and a plain-English task.
#   e2e.sh <app> "<task>" [test-creds "email=..,password=.."]
# The server's login env vars are filled from the test creds. Nothing is written to Claude Code's settings:
# the server is passed with --mcp-config for this one run.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=$1 TASK=$2 CREDS=${3:-}
OUT=$ROOT/generated/$APP
CFG=$(mktemp -t unremote-mcp).json
python3 - "$OUT" "$CREDS" "$CFG" "${EXTRA_CA:-}" <<'EOF'
import json, sys
out, creds, cfg_path, ca = sys.argv[1:5]
cfg = json.load(open(f"{out}/unremote.config.json"))
vals = dict(kv.split("=", 1) for kv in creds.split(",") if "=" in kv)
env = {var: vals.get(field, "") for field, var in ((cfg.get("auth") or {}).get("login", {}).get("fields", {})).items()}
if ca:
    env["NODE_EXTRA_CA_CERTS"] = ca
json.dump({"mcpServers": {cfg["name"]: {"command": "node", "args": [f"{out}/server.mjs"], "env": env}}}, open(cfg_path, "w"))
print(cfg["name"])
EOF
NAME=$(python3 -c "import json;print(json.load(open('$OUT/unremote.config.json'))['name'])")
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -n "${UNREMOTE_KEYCHAIN_SERVICE:-}" ]; then
  CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s "$UNREMOTE_KEYCHAIN_SERVICE" -w); export CLAUDE_CODE_OAUTH_TOKEN
fi
cd "$(mktemp -d)"
claude -p "$TASK" --model sonnet --mcp-config "$CFG" --strict-mcp-config \
  --allowedTools "mcp__$NAME" --tools "" --output-format text
rm -f "$CFG"
