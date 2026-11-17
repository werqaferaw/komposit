#!/bin/bash
# Builds out/helper/komposit-helper from helper/mac/Sources.
# Universal (arm64 + x86_64, joined with lipo) when both slices compile;
# otherwise this Mac's own architecture, and it says which.
#
#   helper/mac/build.sh            optimised build
#   KOMPOSIT_HELPER_DEBUG=1 ...    debug build (faster to compile)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/out/helper"
TMP="$OUT/.build"
MIN_MACOS="12.0" # Electron 45 needs macOS 12, so nothing older runs Komposit anyway
mkdir -p "$OUT" "$TMP"

OPT=(-O -whole-module-optimization)
[ "${KOMPOSIT_HELPER_DEBUG:-}" = "1" ] && OPT=(-Onone -g)

# Swift 5 language mode: the helper shares a little state between worker threads
# behind locks, which Swift 6's strict checking would make noisy for no gain here.
build_arch() {
  xcrun swiftc "${OPT[@]}" -swift-version 5 \
    -target "$1-apple-macos$MIN_MACOS" \
    -framework AppKit -framework ApplicationServices -framework CoreServices \
    -framework IOKit -framework QuickLookThumbnailing -framework ImageIO \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$HERE/Info.plist" \
    -o "$TMP/komposit-helper-$1" "$HERE"/Sources/*.swift
}

NATIVE="$(uname -m)"
OTHER=arm64; [ "$NATIVE" = "arm64" ] && OTHER=x86_64

build_arch "$NATIVE"
if build_arch "$OTHER" 2>"$TMP/$OTHER.log"; then
  lipo -create "$TMP/komposit-helper-$NATIVE" "$TMP/komposit-helper-$OTHER" -output "$OUT/komposit-helper"
  echo "built $OUT/komposit-helper (universal: $(lipo -archs "$OUT/komposit-helper"))"
else
  cp "$TMP/komposit-helper-$NATIVE" "$OUT/komposit-helper"
  echo "built $OUT/komposit-helper ($NATIVE only; the $OTHER slice failed, see $TMP/$OTHER.log)"
fi
# Ad-hoc signature so it runs; the release build re-signs it inside Komposit.app.
codesign --force --sign - --identifier dev.werq.komposit.helper "$OUT/komposit-helper" >/dev/null 2>&1 || true
ls -l "$OUT/komposit-helper" | awk '{print "size:", $5, "bytes"}'
