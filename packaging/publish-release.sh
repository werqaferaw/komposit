#!/bin/bash
# Publish a release: the Mac DMG and the Windows installer go on the GitHub
# Releases page of the Komposit repo. Run this yourself: it publishes.
#
#   packaging/publish-release.sh                 # Mac + Windows
#   packaging/publish-release.sh --mac-only      # ship Windows later
#   packaging/publish-release.sh --make-public   # first release: also make the repo public
#
# Release downloads only work from a public repo, so a private repo stops the
# script unless --make-public is given.
#
# Needs: gh, signed in with push access to the repo (`gh auth status`); dist/Komposit-mac.dmg
# from packaging/release-mac.sh. The Windows installer is taken from
# dist/Komposit-Setup-win.exe, or downloaded from the newest green run of the
# "windows" workflow on main.
#
# The download links never change between versions:
#   https://github.com/werqaferaw/komposit/releases/latest/download/Komposit-mac.dmg
#   https://github.com/werqaferaw/komposit/releases/latest/download/Komposit-Setup-win.exe
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION-preview"
REPO="werqaferaw/komposit"
NOTES="docs/release-notes.md"
MAC="dist/Komposit-mac.dmg"
WIN="dist/Komposit-Setup-win.exe"
MAC_ONLY=0
MAKE_PUBLIC=0
for arg in "$@"; do
  case "$arg" in
    --mac-only) MAC_ONLY=1 ;;
    --make-public) MAKE_PUBLIC=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

command -v gh >/dev/null || { echo "gh isn't installed (https://cli.github.com)" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh isn't signed in: run gh auth login" >&2; exit 1; }
[ -f "$MAC" ] || { echo "no $MAC: run packaging/release-mac.sh first" >&2; exit 1; }
[ -f "$NOTES" ] || { echo "no $NOTES" >&2; exit 1; }

if [ "$MAC_ONLY" = 0 ] && [ ! -f "$WIN" ]; then
  echo "== fetching the Windows installer from the newest green 'windows' run on main"
  RUN="$(gh run list --repo "$REPO" --workflow windows.yml --branch main --status success --limit 1 --json databaseId -q '.[0].databaseId')"
  [ -n "$RUN" ] || { echo "no green windows run on main; use --mac-only or run the workflow" >&2; exit 1; }
  TMP="$(mktemp -d)"
  gh run download "$RUN" --repo "$REPO" --name komposit-windows-installer --dir "$TMP"
  cp "$(ls "$TMP"/Komposit-Setup-*.exe | head -1)" "$WIN"
  rm -rf "$TMP"
  echo "   from run $RUN"
fi

ASSETS=("$MAC")
[ "$MAC_ONLY" = 0 ] && ASSETS+=("$WIN")
( cd dist && shasum -a 256 $(for a in "${ASSETS[@]}"; do basename "$a"; done) > SHA256SUMS.txt )
ASSETS+=("dist/SHA256SUMS.txt")
echo "== assets"; cat dist/SHA256SUMS.txt

VISIBILITY="$(gh repo view "$REPO" --json visibility -q .visibility)"
if [ "$VISIBILITY" != "PUBLIC" ]; then
  if [ "$MAKE_PUBLIC" = 1 ]; then
    echo "== making $REPO public"
    gh repo edit "$REPO" --visibility public --accept-visibility-change-consequences
    # Lets people report security problems privately (SECURITY.md links to it).
    gh api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null || echo "   (turn on private vulnerability reporting in the repo's Security settings)"
  else
    echo "$REPO is $VISIBILITY: its release downloads would not work." >&2
    echo "Run again with --make-public to publish the code and the release together." >&2
    exit 1
  fi
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "== $TAG exists: replacing its files"
  gh release upload "$TAG" "${ASSETS[@]}" --repo "$REPO" --clobber
  gh release edit "$TAG" --repo "$REPO" --notes-file "$NOTES" --latest
else
  echo "== creating release $TAG"
  gh release create "$TAG" "${ASSETS[@]}" --repo "$REPO" --title "Komposit $VERSION preview" --notes-file "$NOTES" --latest
fi

echo "== checking the download links"
check() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 60 -r 0-0 "$1")"
  [ "$code" = "200" ] || [ "$code" = "206" ] || { echo "   FAIL $code $1" >&2; return 1; }
  echo "   ok  $1"
}
check "https://github.com/$REPO/releases/latest/download/Komposit-mac.dmg"
[ "$MAC_ONLY" = 0 ] && check "https://github.com/$REPO/releases/latest/download/Komposit-Setup-win.exe"
echo "== done: https://github.com/$REPO/releases/tag/$TAG"
