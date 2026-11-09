// Shared ExtendScript guidance injected into BOTH engines' system prompt, so the
// model writes a correct script on the FIRST try instead of trial-and-error.
// Every recipe here is the known-good pattern + the specific pitfall that caused
// a retry in testing. Keep it concrete — this is what drives down the error rate.

// How the edit wrapper surfaces results — the single biggest source of wasted
// retries was the model THROWING errors to read values because it didn't trust
// the return channel. Make it explicit.
export const ENVELOPE = `How your edit script talks back to you:
- Whatever you \`return\` from the script is delivered to you as \`result: <json>\`. READ data this way (bounds, colors, counts, names) — do NOT throw an error to surface a value.
- \`log(x)\` appends to \`logs:\` for extra values in the same run.
- A failure comes back as \`edit failed: <message> (line N)\` — fix that line and retry.
- One returning script can both change the doc AND return what you need to verify. Don't probe in separate calls.`;

const PER_APP = {
  illustrator: `Illustrator ExtendScript (ES3) — correct patterns:
- DOM: app.activeDocument (doc), doc.layers[], doc.pageItems[], doc.textFrames[], doc.artboards[].
- geometricBounds = [left, top, right, bottom] in POINTS, y increases UPWARD (top > bottom). Width = r-l, height = top-bottom.
- Color: var c = new RGBColor(); c.red=230; c.green=80; c.blue=40;  (0–255). Match doc.documentColorSpace (RGB vs CMYK).
- New rectangle: var it = doc.pathItems.rectangle(top, left, width, height); it.filled=true; it.stroked=false; it.fillColor=c;  (note: top-left origin, y DOWN for this call's args).
- New ellipse/circle: doc.pathItems.ellipse(top, left, width, height).
- New text: var tf = doc.textFrames.add(); tf.contents="Hi"; tf.textRange.characterAttributes.size=48; tf.left=x; tf.top=y;
- Center on an artboard: var r=doc.artboards[i].artboardRect; // [l,t,r,b]; cx=(r[0]+r[2])/2; cy=(r[1]+r[3])/2; then set item.left=cx-item.width/2; item.top=cy+item.height/2;
- Duplicate artwork: use item.duplicate() — NEVER copy()/paste(). Paste needs the app frontmost and fails with "Illustrator must be the front application".
- Switch artboard: doc.artboards.setActiveArtboardIndex(i).
- "Target layer cannot be modified" when creating art: the document's ACTIVE layer is locked or hidden, even if you target another layer. Set doc.activeLayer to the visible, unlocked layer you're drawing into first.
- Bring in an attached VECTOR file (SVG, PDF, AI, EPS) as editable artwork: var g = doc.groupItems.createFromFile(new File(path));  then size/position g (it's a GroupItem). One call, no copy/paste, no opening the file.
- Place an attached RASTER image (PNG, JPG, PSD, TIFF): var p = doc.placedItems.add(); p.file = new File(path);  (linked; p.embed() embeds it). placedItems does NOT accept SVG. If setting .file throws, p.remove() the empty item it leaves behind.
- A path's color may be nested in a GroupItem — walk group.pageItems recursively; inspect() now returns nested group fills in \`fills\`.`,

  photoshop: `Photoshop ExtendScript (ES3) — correct patterns:
- First line for pixel work: app.preferences.rulerUnits = Units.PIXELS;  (restore the old value at the end). Also app.displayDialogs = DialogModes.NO;
- Add a TEXT layer (the common one): var L = doc.artLayers.add(); L.kind = LayerKind.TEXT; var t = L.textItem; t.contents="Hello"; t.size=48; t.position=[x, y]; var c=new SolidColor(); c.rgb.red=255; c.rgb.green=255; c.rgb.blue=255; t.color=c; t.font="Helvetica-Bold";  // font MUST be the PostScript name (e.g. "Helvetica-Bold"), NOT the display name "Helvetica" — wrong name silently falls back.
- Fill the whole canvas: doc.selection.selectAll(); var c=new SolidColor(); c.rgb.red=18; c.rgb.green=28; c.rgb.blue=70; doc.selection.fill(c); doc.selection.deselect();
- New solid layer to fill a region: var L=doc.artLayers.add(); then select a region and fill.
- Color is ALWAYS a SolidColor with .rgb.red/green/blue (0–255) — not RGBColor.
- Bounds come back as UnitValue; use b[0].value for the number.
- Place an attached file as a smart object in the active doc: var d = new ActionDescriptor(); d.putPath(charIDToTypeID('null'), new File(path)); executeAction(charIDToTypeID('Plc '), d, DialogModes.NO);  (it lands centred; then move/scale the new active layer). app.open(new File(path)) opens it as its own document.`,

  aftereffects: `After Effects ExtendScript (ES3) — correct patterns:
- Wrap EVERY change: app.beginUndoGroup('what'); ... app.endUndoGroup();
- Active comp: var comp = app.project.activeItem; if (!(comp && comp instanceof CompItem)) { for (var i=1;i<=app.project.numItems;i++){ if (app.project.item(i) instanceof CompItem){ comp=app.project.item(i); break; } } }
- New text layer: var L = comp.layers.addText("Hello"); then: var td = L.property("Source Text").value; td.fontSize=96; td.fillColor=[1,1,1]; L.property("Source Text").setValue(td);  (AE colors are [r,g,b] 0–1, NOT 0–255).
- Position: L.property("Transform")("Position").setValue([x, y]);  (time in SECONDS; keyframes via setValueAtTime(t, v)).
- New solid: comp.layers.addSolid([r,g,b], "name", comp.width, comp.height, 1);
- Easing (what makes motion feel designed): after setting keys, var e = new KeyframeEase(0, 75); prop.setTemporalEaseAtKey(k, [e], [e]);  (one KeyframeEase per dimension for separated/spatial props: Position in 3D takes 1 since it's spatial; Scale takes 3 → [e,e,e]). Speed 0 + influence 33–80 = ease in/out.
- Hold or linear: prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD | LINEAR | BEZIER).
- Stagger several layers: offset each layer's keys by i * frameDuration * N, or shift layer.startTime.
- Import an attached file (footage, image, audio, AI/PSD): var item = app.project.importFile(new ImportOptions(new File(path))); comp.layers.add(item);  (AI/PSD import as footage; set ImportOptions.importAs = ImportAsType.COMP to keep layers).
- Expressions: prop.expression = 'wiggle(2, 20)'; check prop.expressionError afterwards.
- Read the selection's refs from the [Live selection] block; times are in seconds.
- To check motion, render with frames: 4-6; when it's done, render once with video: true so the user can watch it.
- RETURN a plain object/value — AE has no stdout, the wrapper writes your return to a file.`,
};

// Full guidance block for an app's system prompt.
export function esGuidance(app) {
  const per = PER_APP[app] || "";
  return (per ? per + "\n\n" : "") + ENVELOPE;
}

// Guidance for every supported app at once. The API engine uses this so its
// system prompt never changes when the person switches apps mid-chat.
export function esGuidanceAll() {
  return Object.values(PER_APP).join("\n\n") + "\n\n" + ENVELOPE;
}
