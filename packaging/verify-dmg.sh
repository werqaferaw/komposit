#!/bin/bash
# Check a built DMG before it goes out:
#   packaging/verify-dmg.sh [dist/Komposit-<version>.dmg] [--web-url https://app.komposit.werq.dev]
#
# Mounts it read-only and checks that:
#   - the app's companion/, ui/ and package.json match this checkout byte for byte
#     (so the DMG isn't stale);
#   - every binary is universal (Apple Silicon + Intel) and the signature verifies;
#   - Info.plist carries this version and the expected hosted-UI address
#     (empty when --web-url isn't given);
#   - the bundled node can load the server's modules.
# Prints size and SHA-256. Exits non-zero on the first failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
DMG="dist/Komposit-$VERSION.dmg"
WEBURL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --web-url) WEBURL="${2:-}"; shift 2 ;;
    *) DMG="$1"; shift ;;
  esac
done
[ -f "$DMG" ] || { echo "no DMG at $DMG (run npm run build:mac)" >&2; exit 1; }

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok  $*"; }

MNT="$(mktemp -d "${TMPDIR:-/tmp}/komposit-verify.XXXX")"
cleanup() { hdiutil detach -quiet "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true; }
trap cleanup EXIT
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MNT" "$DMG"
APP="$MNT/Komposit.app"
RES="$APP/Contents/Resources/app"

echo "== verify $DMG"
[ -d "$APP" ] || fail "no Komposit.app in the DMG"
[ -L "$MNT/Applications" ] || fail "no Applications link in the DMG"
ok "layout: Komposit.app + Applications link"

diff -r -q -x test -x .DS_Store companion "$RES/companion" >/dev/null || { diff -r -q -x test -x .DS_Store companion "$RES/companion" | head; fail "companion/ differs from this checkout"; }
diff -r -q -x .DS_Store ui "$RES/ui" >/dev/null || { diff -r -q -x .DS_Store ui "$RES/ui" | head; fail "ui/ differs from this checkout"; }
cmp -s package.json "$RES/package.json" || fail "package.json differs"
ok "companion/, ui/ and package.json match this checkout"

for b in Komposit komposit-helper node; do
  lipo -info "$APP/Contents/MacOS/$b" | grep -q "x86_64 arm64\|arm64 x86_64" || fail "$b is not universal"
done
ok "Komposit, komposit-helper and node are universal (arm64 + x86_64)"

codesign --verify --strict "$APP" 2>/dev/null || fail "codesign --verify failed"
ok "signature verifies (ad-hoc)"

PL="$APP/Contents/Info.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PL")" = "$VERSION" ] || fail "Info.plist version is not $VERSION"
GOT="$(/usr/libexec/PlistBuddy -c 'Print :KompositWebURL' "$PL" 2>/dev/null || true)"
[ "$GOT" = "$WEBURL" ] || fail "KompositWebURL is '$GOT', expected '$WEBURL'"
ok "Info.plist: version $VERSION, hosted UI '${WEBURL:-none}'"

[ -f "$APP/Contents/Resources/AppIcon.icns" ] || fail "no app icon"
( cd "$RES" && "$APP/Contents/MacOS/node" --input-type=module -e "
  await import('./companion/engines/index.mjs');
  await import('./companion/setup.mjs');
  await import('@anthropic-ai/sdk');
" ) >/dev/null 2>&1 || fail "the bundled node can't load the server modules"
ok "bundled node loads the server modules"

echo "== $(du -h "$DMG" | cut -f1)  $DMG"
shasum -a 256 "$DMG"
