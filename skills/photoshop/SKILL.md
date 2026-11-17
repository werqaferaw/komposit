---
name: photoshop
description: Use when the person wants something made, changed, checked or exported in Photoshop (photos, retouching, compositing, social graphics and layered images) and the komposit MCP tools are available. Covers how to look, script with ExtendScript, render, export and save safely, plus tested Photoshop recipes.
---

# Photoshop through Komposit

Work in the person's open Photoshop documents with the komposit MCP tools (the komposit-mcp server). Pass `app: "photoshop"` on every app tool, and `doc` ({ name, path } from `documents`) when more than one document is open.

## How to work

1. Look first. `apps` says whether Photoshop is open and ready; `documents` lists what's open; `inspect` maps the document (each item has a `ref` you can use in code) and shows a picture.
2. Find the recipe. The recipes below are the same ones `guide` serves (`guide` with no topic lists them). Build on them instead of guessing the scripting API.
3. Change with `edit`: ExtendScript (ES3: `var` and `function`; no `let`, `const`, arrow functions or template strings). `return` what you need to check, and batch related changes in one script. A failure comes back with its line number.
4. Look at the result. `render` after a visual change; fix what's off, or `undo`.
5. Check before you say it's done: what was asked is there and nothing else moved.
6. Deliver. `export` writes a new file (png and jpg) to ~/Komposit Exports or an `outputDir` in the home folder, and never overwrites. `save` only when the person asks: `copy` (a new file, the document stays as it is), `overwrite` (the file itself) and `as` (a new file the document becomes).

## Rules

- Never save unless the person asks. Edits stay in the app's undo history until they do.
- Scripts that delete, rename or run files, run commands, quit the app, close documents or save are refused. Use the tools, or leave it to the person.
- Komposit never opens Photoshop. If it isn't open, ask the person to open it.
- Photoshop takes one call at a time; calls wait their turn.
- To bring in a file from elsewhere (another app's export, an image), use `place` with its absolute path.

<!-- The recipes below are generated from connectors/photoshop/guide.md by skills/build.mjs. Edit the guide, then run node skills/build.mjs. -->

# Photoshop ExtendScript (ES3) — correct patterns

Known-good recipes for Photoshop scripts. In a run script, `doc` is the document the call targets (brought to the front for the script, then put back); dialogs are already off.

## Results
How your edit script talks back to you:
- Whatever you `return` from the script is delivered to you as `result: <json>`. READ data this way (bounds, colors, counts, names) — do NOT throw an error to surface a value.
- `log(x)` appends to `logs:` for extra values in the same run.
- A failure comes back as `edit failed: <message> (line N)` — fix that line and retry.
- One returning script can both change the doc AND return what you need to verify. Don't probe in separate calls.

## Units and dialogs
- First line for pixel work: app.preferences.rulerUnits = Units.PIXELS;  (restore the old value at the end). Also app.displayDialogs = DialogModes.NO;

## Text layers
- Add a TEXT layer (the common one): var L = doc.artLayers.add(); L.kind = LayerKind.TEXT; var t = L.textItem; t.contents="Hello"; t.size=48; t.position=[x, y]; var c=new SolidColor(); c.rgb.red=255; c.rgb.green=255; c.rgb.blue=255; t.color=c; t.font="Helvetica-Bold";  // font MUST be the PostScript name (e.g. "Helvetica-Bold"), NOT the display name "Helvetica" — wrong name silently falls back.

## Fills
- Fill the whole canvas: doc.selection.selectAll(); var c=new SolidColor(); c.rgb.red=18; c.rgb.green=28; c.rgb.blue=70; doc.selection.fill(c); doc.selection.deselect();
- New solid layer to fill a region: var L=doc.artLayers.add(); then select a region and fill.

## Color
- Color is ALWAYS a SolidColor with .rgb.red/green/blue (0–255) — not RGBColor.

## Bounds
- Bounds come back as UnitValue; use b[0].value for the number.

## Placing files
- Place an attached file as a smart object in the active doc: var d = new ActionDescriptor(); d.putPath(charIDToTypeID('null'), new File(path)); executeAction(charIDToTypeID('Plc '), d, DialogModes.NO);  (it lands centred; then move/scale the new active layer). app.open(new File(path)) opens it as its own document.

## Reverting
- There is no doc.revert() in Photoshop's scripting ("doc.revert is not a function").
- Back one step: doc.activeHistoryState = doc.historyStates[doc.historyStates.length - 2];  Back to how the document opened: doc.activeHistoryState = doc.historyStates[0];  (history states are what the person sees in the History panel; undo is the same.)
- Back to the saved file (throws away every unsaved change, so only when the person asked): executeAction(charIDToTypeID('Rvrt'), undefined, DialogModes.NO);
- In Komposit, every edit is one history state named "Komposit: " and its explanation (so give edits a short explanation). To take back your own edit, use the undo tool, not activeHistoryState in an edit: undo only steps back over Komposit's own states and says so when the latest one is the user's. Don't call doc.suspendHistory yourself: Komposit already runs the edit inside one.

## Locked layers
- A layer can be locked in parts: layer.allLocked, pixelsLocked, positionLocked, transparentPixelsLocked; and hidden: layer.visible. The Background layer (layer.isBackgroundLayer) can't move or hold transparency.
- Unlock for the change and put back what was there: var was = [L.allLocked, L.visible]; L.allLocked = false; L.visible = true; try { /* the change */ } finally { L.visible = was[1]; L.allLocked = was[0]; }
- To change the Background layer like any other, make it a normal layer first (L.isBackgroundLayer = false), and say so: it changes the file's structure.

## Lookups by name
- doc.artLayers.getByName and doc.layerSets.getByName throw "No such element" when nothing has that name, and only look one level deep. Find layers anywhere with a loop that can come back empty:
  function findLayer(parent, name){ for (var i = 0; i < parent.layers.length; i++){ var L = parent.layers[i]; if (L.name === name) return L; if (L.typename === 'LayerSet'){ var f = findLayer(L, name); if (f) return f; } } return null; }

## ES3 limits
- ExtendScript is ES3. Arrays have no map, forEach, filter, reduce, some, every or indexOf; strings have no trim; there's no Object.keys, Array.isArray, let, arrow functions or template strings. Komposit refuses most of these before the script runs, since they'd fail half way.
- Instead: for (var i = 0; i < a.length; i++) { ... }; for (var k in o) { if (o.hasOwnProperty(k)) ... }; s.replace(/^\s+|\s+$/g, '') for trim; 'a' + b + 'c' for template strings. JSON.stringify and JSON.parse work in edits (Komposit adds them).

## Long scripts
- Write shared setup once: when edit takes `helpers` (the Komposit app), put colours, unit conversions and layer lookups there; they're kept for the chat and in front of every later edit in Photoshop, so later edits only call them.
- To see the result of an edit, pass render: true on the edit (the Komposit app) instead of calling render after it: one call instead of two.
