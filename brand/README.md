# Komposit brand

Source of truth: the author's Illustrator master file, artboard **Logo Spec** (mark v2.0).
The SVGs here are exported from it; the geometry is the spec's, not redrawn.

| File | What |
| --- | --- |
| `komposit-tile.svg` | **04.C Solid tile**: Ink tile, white arrow. App icon, favicon, avatars, social. |
| `komposit-tile-mono.svg` | The same tile in `currentColor` with the arrow knocked out (UI, templates). |
| `komposit-wordmark.svg` | The serif wordmark, outlined. |
| `komposit-lockup.svg` | Tile + wordmark: tile = 2 × cap height, gap 11u. |
| `komposit-lockup-light.svg` | The lockup for dark backgrounds. |

- 1u = mark size ÷ 48. Tile radius 11u. Clear space 12u around the mark.
- Below 32 px use the Solid tile (or Brackets), never the dashed Marquee.
- Colour: Ink `#111111`, Paper `#F4F2EE`, Signal `#FF5A1F` (Signal is for the arrow only).

Where it's used: `ui/favicon.svg`, the sidebar and connect-screen logo (`ui/index.html`, `ui/app.css`),
the Mac app icon (`packaging/macos/make-icon.swift`), the menu bar glyph (`packaging/macos/Komposit.swift`),
and the Windows icons (`packaging/windows/make-icons.swift` → `packaging/windows/icons/`: `komposit.ico`
for the app and installer, `tray-dark.ico` / `tray-light.ico` for light and dark taskbars).
The three Swift files each carry a copy of `kompositTile()`; keep them in step with these SVGs.
