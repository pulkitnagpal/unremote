#!/usr/bin/env bash
# Set up the ShowTime demo: a TLS cert for its API, and the Android app that trusts that cert.
#
#   demo/setup.sh              make the cert if there is none, copy it into the app, build the APK
#   demo/setup.sh --new-cert   replace the cert (reinstall the app and restart the API afterwards)
#   demo/setup.sh --no-build   only the cert
#
# Uses ./gradlew or gradle when there is one; otherwise downloads Gradle once into ~/.cache/unremote.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BACKEND=$HERE/backend
ANDROID=$HERE/android
RAW=$ANDROID/app/src/main/res/raw/showtime_api.pem
APK=$ANDROID/app/build/outputs/apk/debug/app-debug.apk
SDK=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}
export JAVA_HOME=${JAVA_HOME:-"/Applications/Android Studio.app/Contents/jbr/Contents/Home"}
GRADLE_VERSION=8.11.1

NEW_CERT=0 BUILD=1
for arg in "$@"; do case $arg in
  --new-cert) NEW_CERT=1 ;;
  --no-build) BUILD=0 ;;
  -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown option $arg (try --help)"; exit 2 ;;
esac; done

# 1. A self-signed cert for the demo API, valid for the emulator's name for this Mac (10.0.2.2) and localhost.
if [ "$NEW_CERT" = 1 ] || [ ! -f "$BACKEND/cert.pem" ] || [ ! -f "$BACKEND/key.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -config "$BACKEND/cert.cnf" \
    -keyout "$BACKEND/key.pem" -out "$BACKEND/cert.pem" 2>/dev/null
  chmod 600 "$BACKEND/key.pem"
  echo "made a new cert: $BACKEND/cert.pem"
else
  echo "cert already there: $BACKEND/cert.pem (--new-cert replaces it)"
fi

# 2. The app trusts system CAs plus this one cert (res/xml/network_security_config.xml), like a release app
#    that ships its own API's cert. It does not trust user-installed CAs.
mkdir -p "$(dirname "$RAW")"
cp "$BACKEND/cert.pem" "$RAW"
echo "copied it to the app: ${RAW#"$HERE"/}"

[ "$BUILD" = 1 ] || exit 0

# 3. Build the APK.
[ -d "$JAVA_HOME" ] || { echo "no JDK at $JAVA_HOME; set JAVA_HOME (JDK 17+)"; exit 1; }
[ -d "$SDK" ] || { echo "no Android SDK at $SDK; set ANDROID_SDK_ROOT"; exit 1; }
[ -f "$ANDROID/local.properties" ] || echo "sdk.dir=$SDK" > "$ANDROID/local.properties"

if [ -x "$ANDROID/gradlew" ]; then
  GRADLE=$ANDROID/gradlew
elif command -v gradle >/dev/null 2>&1; then
  GRADLE=$(command -v gradle)
else
  CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/unremote
  GRADLE=$CACHE/gradle-$GRADLE_VERSION/bin/gradle
  if [ ! -x "$GRADLE" ]; then
    URL=https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip
    echo "downloading Gradle $GRADLE_VERSION into $CACHE (about 140 MB, once)"
    mkdir -p "$CACHE"
    curl -fsSL "$URL" -o "$CACHE/gradle.zip"
    WANT=$(curl -fsSL "$URL.sha256")
    GOT=$(shasum -a 256 "$CACHE/gradle.zip" | cut -d' ' -f1)
    [ "$WANT" = "$GOT" ] || { rm -f "$CACHE/gradle.zip"; echo "Gradle download failed its checksum"; exit 1; }
    (cd "$CACHE" && unzip -q -o gradle.zip && rm gradle.zip)
  fi
fi

(cd "$ANDROID" && "$GRADLE" --quiet assembleDebug)
echo "built: ${APK#"$HERE"/}"
