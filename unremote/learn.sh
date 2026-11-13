#!/usr/bin/env bash
# unremote learn: explore an app that is installed on the capture emulator, capture its private API,
# and generate an MCP server for it. The only inputs are the app's package name and its store listing.
#
#   learn.sh <package> <listing.txt> <app-name> [test-creds "email=..,password=.."]
#
# Env: WRITES=allow|block (default block: state-changing calls are held back while exploring)
#      UPSTREAM_CA=<pem> to trust a self-signed API cert upstream (demo only)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
ADB=${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}/platform-tools/adb
PKG=$1 LISTING=$2 APP=$3 CREDS=${4:-}
RUN=$ROOT/runs/$APP-$(date +%Y%m%d-%H%M%S)
OUT=$ROOT/generated/$APP
mkdir -p "$RUN"

echo "== 1. capture: proxy on :18080, emulator routed through it (writes=${WRITES:-block})"
EXTRA=()
[ -n "${UPSTREAM_CA:-}" ] && EXTRA=(--set "ssl_verify_upstream_trusted_ca=$UPSTREAM_CA")
mitmdump -q -p 18080 --set connection_strategy=lazy -s "$HERE/recorder.py" --set "out=$RUN/flows.jsonl" --set "writes=${WRITES:-block}" ${EXTRA[@]+"${EXTRA[@]}"} >"$RUN/mitm.log" 2>&1 &
MITM=$!
trap 'kill $MITM 2>/dev/null || true; "$ADB" shell settings put global http_proxy :0 >/dev/null 2>&1 || true' EXIT
sleep 2
"$ADB" shell settings put global http_proxy 10.0.2.2:18080

echo "== 2. explore: the agent uses the app toward goals from its store listing"
(cd "$HERE" && python3 explorer.py --package "$PKG" --listing "$LISTING" --run "$RUN" --creds "$CREDS")
"$ADB" shell settings put global http_proxy :0
sleep 1; kill $MITM 2>/dev/null || true

echo "== 3. analyze: endpoints, value flow, login, noise"
(cd "$HERE" && python3 analyze.py --run "$RUN")

echo "== 4. design tools (Claude)"
(cd "$HERE" && python3 design.py --run "$RUN" --app "$APP")

echo "== 5. generate the MCP server"
(cd "$HERE" && python3 generate.py --run "$RUN" --out "$OUT")
(cd "$OUT" && npm install --silent --no-audit --no-fund >/dev/null)
echo "run: $RUN"
echo "server: $OUT"
