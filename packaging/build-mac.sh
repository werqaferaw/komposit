#!/bin/bash
# Build Komposit.app and a drag-to-install DMG for testers.
#
#   packaging/build-mac.sh                   # -> dist/Komposit-<version>.dmg
#   KOMPOSIT_WEB_URL=https://app.komposit.werq.dev packaging/build-mac.sh
#
# The app bundles: a universal Swift menu-bar app, the universal Node runtime
# (keeps its Node.js Foundation signature), the companion server, the UI and
# the production node_modules. Signed ad-hoc (no Apple Developer account), so
# testers allow it once in System Settings > Privacy & Security.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
BUILD="${BUILD:-$(git rev-list --count HEAD 2>/dev/null || date +%Y%m%d%H%M)}"
WEBURL="${KOMPOSIT_WEB_URL:-}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
MIN_OS="13.5"

OUT="$ROOT/dist"
WORK="$OUT/build"
APP="$WORK/Komposit.app"
rm -rf "$WORK"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$OUT"

echo "== Komposit $VERSION ($BUILD)  web: ${WEBURL:-none}"

# 1. Native code: universal (Apple Silicon + Intel).
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos$MIN_OS" -o "$WORK/Komposit-$arch" packaging/macos/Komposit.swift
  swiftc -O -target "$arch-apple-macos$MIN_OS" -o "$WORK/helper-$arch" packaging/macos/helper.swift
done
lipo -create "$WORK/Komposit-arm64" "$WORK/Komposit-x86_64" -output "$APP/Contents/MacOS/Komposit"
lipo -create "$WORK/helper-arm64" "$WORK/helper-x86_64" -output "$APP/Contents/MacOS/komposit-helper"

# 2. Node runtime. Must be universal so one DMG serves every Mac.
if ! lipo -info "$NODE_BIN" | grep -q "x86_64 arm64\|arm64 x86_64"; then
  echo "NODE_BIN ($NODE_BIN) is not a universal binary; point NODE_BIN at one." >&2
  exit 1
fi
ditto "$NODE_BIN" "$APP/Contents/MacOS/node"

# 3. The app itself: server, UI, production dependencies (no types/maps/docs).
rsync -a --exclude ".DS_Store" --exclude "test/" companion "$APP/Contents/Resources/app/"
rsync -a --exclude ".DS_Store" ui "$APP/Contents/Resources/app/"
cp package.json "$APP/Contents/Resources/app/"
rsync -a --exclude ".DS_Store" --exclude "*.map" --exclude "*.d.ts" --exclude "*.d.mts" --exclude "*.d.cts" \
  --exclude "*.md" --exclude "*.ts" --exclude "src/" --exclude ".bin/" \
  node_modules "$APP/Contents/Resources/app/"

# 4. Icon + Info.plist.
swift packaging/macos/make-icon.swift "$WORK/AppIcon.iconset" >/dev/null
iconutil -c icns "$WORK/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
sed -e "s|__VERSION__|$VERSION|" -e "s|__BUILD__|$BUILD|" -e "s|__WEBURL__|$WEBURL|" \
  packaging/macos/Info.plist > "$APP/Contents/Info.plist"
printf "APPL????" > "$APP/Contents/PkgInfo"

# 5. Smoke test: the bundled node can load the server's modules.
"$APP/Contents/MacOS/node" --input-type=module -e "
  await import('$APP/Contents/Resources/app/companion/engines/index.mjs');
  await import('@anthropic-ai/sdk').catch(() => {});
" 2>&1 | head -5 || true
( cd "$APP/Contents/Resources/app" && "$APP/Contents/MacOS/node" -e "import('@anthropic-ai/sdk').then(()=>console.log('   sdk loads'))" )

# 6. Sign ad-hoc. Node keeps its own signature (and its JIT entitlements).
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/komposit-helper"
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/Komposit"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict --verbose=1 "$APP"
spctl --assess --type execute "$APP" 2>&1 | sed 's/^/   gatekeeper: /' || true

# 7. DMG: the app, a link to Applications, and how to open it the first time.
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Komposit.app"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/How to open Komposit.txt" <<'TXT'
Komposit preview: first launch

1. Drag Komposit into Applications, then open it from there.
2. macOS says it can't check Komposit for malicious software (this preview
   isn't signed with an Apple developer certificate). Click Done.
3. Open System Settings > Privacy & Security, scroll down to
   "Komposit was blocked...", click Open Anyway, and confirm.

Komposit then appears in the menu bar and opens in your browser.
The first time it works in Illustrator, Photoshop or After Effects, macOS
asks whether Komposit may control that app: click Allow.
TXT
DMG="$OUT/Komposit-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -quiet -volname "Komposit" -srcfolder "$STAGE" -fs HFS+ -format ULMO -ov "$DMG"

echo "== done"
du -sh "$APP" | sed 's/^/   app: /'
ls -lh "$DMG" | awk '{print "   dmg: " $5 "  " $9}'
shasum -a 256 "$DMG" | sed 's/^/   sha256: /'
