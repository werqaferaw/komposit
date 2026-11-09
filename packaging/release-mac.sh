#!/bin/bash
# The release build of the Mac app, in one go:
#   packaging/release-mac.sh                                   # local UI only
#   KOMPOSIT_WEB_URL=https://app.komposit.werq.dev packaging/release-mac.sh
#
# 1. With KOMPOSIT_WEB_URL: refuses unless that page is live and is the
#    Komposit UI (a DMG pointing at a dead page would open a broken page).
# 2. Quits a Komposit running from dist/ (building over a running copy fails
#    or ships stale files).
# 3. Runs the unit tests and the syntax check.
# 4. Builds dist/Komposit-<version>.dmg and verifies it (verify-dmg.sh).
# 5. Copies it to dist/Komposit-mac.dmg, the stable name the download links use.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
WEBURL="${KOMPOSIT_WEB_URL:-}"

if [ -n "$WEBURL" ]; then
  echo "== checking $WEBURL is live"
  BODY="$(curl -fsSL --max-time 20 "$WEBURL/" || true)"
  echo "$BODY" | grep -q 'komposit-download' || {
    echo "$WEBURL doesn't serve the Komposit UI yet. Deploy web/ first (docs/releasing.md), or build without KOMPOSIT_WEB_URL." >&2
    exit 1
  }
  echo "   ok"
fi

RUNNING="$(pgrep -i -f "$ROOT/dist/.*/Komposit.app/Contents/MacOS/Komposit" || true)"
if [ -n "$RUNNING" ]; then
  echo "== quitting the Komposit running from dist/ ($RUNNING)"
  kill -TERM $RUNNING || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -i -f "$ROOT/dist/.*/Komposit.app/Contents/MacOS/Komposit" >/dev/null || break; sleep 0.5; done
fi

echo "== tests"
npm test >/dev/null 2>&1 || { echo "npm test failed; run it to see why" >&2; exit 1; }
npm run check >/dev/null 2>&1 || { echo "npm run check failed; run it to see why" >&2; exit 1; }
echo "   ok"

packaging/build-mac.sh
packaging/verify-dmg.sh "dist/Komposit-$VERSION.dmg" --web-url "$WEBURL"
cp -f "dist/Komposit-$VERSION.dmg" dist/Komposit-mac.dmg
echo "== release file: dist/Komposit-mac.dmg (same bytes as dist/Komposit-$VERSION.dmg)"
