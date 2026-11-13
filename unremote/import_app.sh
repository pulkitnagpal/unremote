#!/usr/bin/env bash
# Copy an app the user installed from the Play Store (on a normal emulator or phone) to the capture emulator.
#   import_app.sh <package> <from-serial> <to-serial>
# Play installs an app as several split APKs (code, CPU, screen density, language); all are copied together.
set -euo pipefail
ADB=${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}/platform-tools/adb
PKG=$1 FROM=$2 TO=$3
DIR=$(mktemp -d)
PATHS=$("$ADB" -s "$FROM" shell pm path "$PKG" | tr -d '\r' | sed 's/^package://')
[ -n "$PATHS" ] || { echo "$PKG is not installed on $FROM"; exit 1; }
for p in $PATHS; do "$ADB" -s "$FROM" pull "$p" "$DIR/" >/dev/null; done
echo "pulled: $(ls "$DIR" | tr '\n' ' ')"
"$ADB" -s "$TO" install-multiple -r "$DIR"/*.apk | tail -1
rm -rf "$DIR"
