#!/bin/bash
# For LIVE-TEST.md only: wraps the built helper in a tiny app called "Komposit"
# in a folder you choose, so macOS's Automation prompt names "Komposit" (a bare
# program started from Terminal gets its permissions attributed to Terminal).
#
#   helper/mac/live-bundle.sh <folder>    ->  <folder>/Komposit.app
#
# Its bundle id is dev.werq.komposit.livetest, kept apart from the real app's,
# so its permission can be removed afterwards without touching anything else:
#   tccutil reset AppleEvents dev.werq.komposit.livetest
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../../out/helper/komposit-helper"
DEST="${1:?usage: live-bundle.sh <folder>}"
[ -x "$BIN" ] || "$HERE/build.sh"
APP="$DEST/Komposit.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/komposit-helper"
sed -e 's/dev.werq.komposit.helper/dev.werq.komposit.livetest/' "$HERE/Info.plist" > "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string komposit-helper" -c "Add :CFBundlePackageType string APPL" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" >/dev/null
echo "$APP"
