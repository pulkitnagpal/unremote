#!/usr/bin/env bash
# Prepare a capture emulator: an unlocked Android 13 image whose system trust store holds the
# mitmproxy CA, so the app's HTTPS traffic can be read like a normal release build's would be.
# This changes only the emulator, never the Mac's own trust settings.
set -euo pipefail
SDK=${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}
export JAVA_HOME=${JAVA_HOME:-"/Applications/Android Studio.app/Contents/jbr/Contents/Home"}
CMD=$SDK/cmdline-tools/latest/bin
export ANDROID_HOME=$SDK
ADB=$SDK/platform-tools/adb
AVD=unremote_api33
IMG="system-images;android-33;google_apis;arm64-v8a"

if ! "$SDK/emulator/emulator" -list-avds | grep -qx $AVD; then
  echo no | "$CMD/avdmanager" create avd -n $AVD -k "$IMG" -d pixel_6 >/dev/null 2>&1 || true
fi

boot() {
  "$SDK/emulator/emulator" -avd $AVD -writable-system -no-snapshot -no-boot-anim -no-audio -gpu swiftshader_indirect >/tmp/unremote_emulator.log 2>&1 &
  "$ADB" wait-for-device
  until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
}

if ! "$ADB" devices | grep -q emulator; then boot; fi
"$ADB" root >/dev/null; sleep 2; "$ADB" wait-for-device

CA=$HOME/.mitmproxy/mitmproxy-ca-cert.pem
if [ ! -f "$CA" ]; then mitmdump -p 18999 >/dev/null 2>&1 & P=$!; sleep 4; kill $P 2>/dev/null || true; fi
HASH=$(openssl x509 -inform PEM -subject_hash_old -in "$CA" | head -1)
if ! "$ADB" shell ls /system/etc/security/cacerts/$HASH.0 >/dev/null 2>&1; then
  if "$ADB" remount 2>&1 | grep -qi reboot; then
    "$ADB" reboot; "$ADB" wait-for-device
    until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
    "$ADB" root >/dev/null; sleep 2; "$ADB" wait-for-device; "$ADB" remount
  fi
  cp "$CA" /tmp/$HASH.0
  "$ADB" push /tmp/$HASH.0 /system/etc/security/cacerts/ >/dev/null
  "$ADB" shell chmod 644 /system/etc/security/cacerts/$HASH.0
  "$ADB" reboot; "$ADB" wait-for-device
  until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
fi
echo "emulator ready; mitmproxy CA $HASH is a system CA"
