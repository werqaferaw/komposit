// Adobe Illustrator bridge. Implements the uniform bridge interface the harness
// calls: activate · listDocuments · inspect · edit · render · exportCopy ·
// saveDocument · preflight · undo.
import { join } from "node:path";
import { runViaStdout, activate as osActivate, scratchDir, readPng } from "./extendscript.mjs";
import { env } from "../env.mjs";
import { newOutputPath } from "./files.mjs";

// The app id; the platform layer knows how to reach it (AppleScript target on
// a Mac, the COM ProgID on Windows).
const APP = "illustrator";

export const label = "Illustrator";
export const capabilities = { inspect: true, edit: true, render: true, export: ["png", "jpg", "svg", "pdf"], save: ["copy", "overwrite"], preflight: true, selection: true };

export async function activate() {
  await osActivate(APP);
  return { ok: true };
}

// Create a new blank document (so you can komposit from scratch, not only edit
// an existing file). Returns the new doc's name.
export async function newDocument({ width = 1000, height = 1000 } = {}) {
  await osActivate(APP);
  const res = await runViaStdout(
    APP,
    `app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
     var d = app.documents.add(DocumentColorSpace.RGB, ${Number(width)}, ${Number(height)});
     return { name: d.name };`,
  );
  if (!res.ok) throw new Error(res.error);
  return { ok: true, name: res.data.name };
}

export async function listDocuments() {
  const res = await runViaStdout(
    APP,
    `
var docs = [], activeName = app.documents.length ? app.activeDocument.name : null;
for (var i=0;i<app.documents.length;i++){
  var d = app.documents[i], p = null;
  try { p = d.fullName.fsName; if (!(new File(p)).exists) p = null; } catch(e){ p = null; }
  docs.push({ name:d.name, path:p, active:d.name===activeName });
}
return { documents: docs };`,
  );
  if (!res.ok) throw new Error(res.error);
  return res.data.documents;
}

// Walk the active doc into a compact, model-readable state map. Every item
// carries a `ref` that is directly usable in an edit script.
export async function inspect() {
  const res = await runViaStdout(
    APP,
    `
if (app.documents.length === 0) return { noDocument:true };
var doc = app.activeDocument;
function rnd(n){ return Math.round(n*10)/10; }
function colorStr(c){
  try{
    if(!c) return null; var t=c.typename;
    if(t==='RGBColor') return 'rgb('+Math.round(c.red)+','+Math.round(c.green)+','+Math.round(c.blue)+')';
    if(t==='GrayColor') return 'gray('+Math.round(c.gray)+')';
    if(t==='CMYKColor') return 'cmyk('+Math.round(c.cyan)+','+Math.round(c.magenta)+','+Math.round(c.yellow)+','+Math.round(c.black)+')';
    if(t==='NoColor') return 'none';
    if(t==='SpotColor') return 'spot('+c.spot.name+')';
    return t;
  }catch(e){ return 'unknown'; }
}
// Collect the distinct fill colors of the paths INSIDE a group (recursively),
// so nested artwork — a panel path buried in a group — isn't invisible.
function groupFills(g, acc, cap){
  for (var gi=0; gi<g.pageItems.length && acc.length<cap; gi++){
    var c = g.pageItems[gi];
    try{
      if (c.typename==='GroupItem'){ groupFills(c, acc, cap); }
      else if (c.filled){
        var f = colorStr(c.fillColor);
        if (f && f!=='none'){ var dup=false; for (var k=0;k<acc.length;k++){ if(acc[k]===f) dup=true; } if(!dup) acc.push(f); }
      }
    }catch(e){}
  }
}
var MAX = 400, count = 0, truncated = false;
var abs = [];
for (var a=0;a<doc.artboards.length;a++){
  var r = doc.artboards[a].artboardRect;
  abs.push({ i:a, name:doc.artboards[a].name, rect:[rnd(r[0]),rnd(r[1]),rnd(r[2]),rnd(r[3])], w:rnd(r[2]-r[0]), h:rnd(r[1]-r[3]) });
}
var layers = [];
for (var li=0; li<doc.layers.length; li++){
  var L = doc.layers[li], items = [];
  for (var pi=0; pi<L.pageItems.length; pi++){
    if (count >= MAX){ truncated = true; break; }
    var it = L.pageItems[pi], gb;
    try{ gb = it.geometricBounds; }catch(e){ gb=[0,0,0,0]; }
    var rec = { ref:'doc.layers['+li+'].pageItems['+pi+']', type:it.typename, name:it.name||null,
      bounds:[rnd(gb[0]),rnd(gb[1]),rnd(gb[2]),rnd(gb[3])], w:rnd(gb[2]-gb[0]), h:rnd(gb[1]-gb[3]) };
    if (it.typename==='TextFrame'){ try{ rec.text=it.contents; }catch(e){}; try{ rec.fontSize=rnd(it.textRange.characterAttributes.size); }catch(e){} }
    try{ if (it.filled) rec.fill = colorStr(it.fillColor); }catch(e){}
    if (it.typename==='GroupItem'){ var __gf=[]; try{ groupFills(it, __gf, 8); }catch(e){} if (__gf.length) rec.fills = __gf; }
    if (it.hidden) rec.hidden = true;
    if (it.locked) rec.locked = true;
    items.push(rec); count++;
  }
  layers.push({ ref:'doc.layers['+li+']', name:L.name, visible:L.visible, locked:L.locked, items:items });
}
return { name:doc.name, unit:String(doc.rulerUnits), artboards:abs, layers:layers, itemCount:count, truncated:truncated };`,
  );
  if (!res.ok) throw new Error(res.error);
  if (res.data.noDocument) return { text: "No document open in Illustrator.", image: null };
  return { text: JSON.stringify(res.data, null, 2), image: await render().then((r) => r.image).catch(() => null) };
}

// What the person has selected right now, read live (fast, read-only). Covers
// the cases that trip an agent up: a text range being edited inside a frame,
// items nested in groups or clipping masks (with a ref straight to them), only
// some points of a path picked with the Direct Selection tool, selections that
// span artboards, and nothing selected at all.
export async function selection() {
  const res = await runViaStdout(
    APP,
    `
if (app.documents.length === 0) return { noDocument: true };
var doc = app.activeDocument, s = doc.selection, MAX = 25;
function rnd(n){ return Math.round(n*10)/10; }
function idxIn(coll, it){ for (var i=0;i<coll.length;i++){ if (coll[i] == it) return i; } return -1; }
function refOf(it){
  var path = '', cur = it;
  for (var guard=0; guard<30 && cur; guard++){
    var p = cur.parent;
    if (!p) break;
    if (cur.typename === 'Layer'){
      if (p.typename === 'Document') return 'doc.layers[' + idxIn(doc.layers, cur) + ']' + path;
      path = '.layers[' + idxIn(p.layers, cur) + ']' + path;
    } else {
      path = '.pageItems[' + idxIn(p.pageItems, cur) + ']' + path;
    }
    cur = p;
  }
  return null;
}
function colorStr(c){ try{ var t=c.typename;
  if(t==='RGBColor') return 'rgb('+Math.round(c.red)+','+Math.round(c.green)+','+Math.round(c.blue)+')';
  if(t==='CMYKColor') return 'cmyk('+Math.round(c.cyan)+','+Math.round(c.magenta)+','+Math.round(c.yellow)+','+Math.round(c.black)+')';
  if(t==='GrayColor') return 'gray('+Math.round(c.gray)+')'; if(t==='SpotColor') return 'spot('+c.spot.name+')';
  if(t==='NoColor') return 'none'; return t; }catch(e){ return null; } }
function artboardOf(b){
  for (var a=0;a<doc.artboards.length;a++){ var r = doc.artboards[a].artboardRect;
    if (b[0] < r[2] && b[2] > r[0] && b[1] > r[3] && b[3] < r[1]) return doc.artboards[a].name; }
  return null;
}
function layerOf(it){ var cur = it; for (var g=0; g<30 && cur; g++){ if (cur.typename === 'Layer') return cur.name; cur = cur.parent; } return null; }
var out = { doc: doc.name, activeArtboard: doc.artboards[doc.artboards.getActiveArtboardIndex()].name };

// Editing text with the Type tool: the selection is a text range, not items.
if (s && s.typename === 'TextRange'){
  var tf = null; try { tf = s.story.textFrames[0]; } catch(e){}
  var ca = s.characterAttributes, font = null, size = null;
  try { font = ca.textFont.name; } catch(e){} try { size = rnd(ca.size); } catch(e){}
  var whole = null; try { whole = tf ? tf.contents : null; } catch(e){}
  out.kind = 'text';
  out.text = String(s.contents).substr(0, 300); out.length = s.length;
  out.frameText = whole ? String(whole).substr(0, 300) : null;
  out.frameRef = tf ? refOf(tf) : null; out.font = font; out.size = size;
  try { out.fill = colorStr(ca.fillColor); } catch(e){}
  return out;
}
if (!s || !s.length){ out.kind = 'nothing'; return out; }

out.kind = 'items'; out.count = s.length; out.items = [];
var boards = {};
for (var i=0; i<s.length && i<MAX; i++){
  var it = s[i], b; try { b = it.visibleBounds; } catch(e){ b = [0,0,0,0]; }
  var rec = { ref: refOf(it), type: it.typename, name: it.name || null,
    bounds: [rnd(b[0]),rnd(b[1]),rnd(b[2]),rnd(b[3])], w: rnd(b[2]-b[0]), h: rnd(b[1]-b[3]), layer: layerOf(it) };
  var ab = artboardOf(b); rec.artboard = ab; if (ab) boards[ab] = 1;
  try { if (it.parent.typename === 'GroupItem') rec.inGroup = it.parent.name || 'unnamed group'; } catch(e){}
  try { if (it.parent.typename === 'GroupItem' && it.parent.clipped) rec.insideClippingMask = true; } catch(e){}
  if (it.typename === 'GroupItem'){ rec.children = it.pageItems.length; if (it.clipped) rec.clippingGroup = true; }
  if (it.typename === 'TextFrame'){ try { rec.text = String(it.contents).substr(0, 160); rec.size = rnd(it.textRange.characterAttributes.size); rec.font = it.textRange.characterAttributes.textFont.name; } catch(e){} }
  if (it.typename === 'PathItem'){
    try { if (it.clipping) rec.isClippingPath = true; } catch(e){}
    try { var n = it.pathPoints.length, k = 0;
      for (var p=0;p<n;p++){ if (it.pathPoints[p].selected === PathPointSelection.ANCHORPOINT) k++; }
      if (k > 0 && k < n) rec.selectedPoints = k + ' of ' + n;
    } catch(e){}
  }
  if (it.typename === 'PlacedItem'){ try { rec.file = it.file.name; } catch(e){ rec.file = 'missing link'; } }
  if (it.typename === 'SymbolItem'){ try { rec.symbol = it.symbol.name; } catch(e){} }
  try { if (it.filled) rec.fill = colorStr(it.fillColor); if (it.stroked) rec.stroke = colorStr(it.strokeColor) + ' ' + rnd(it.strokeWidth) + 'pt'; } catch(e){}
  out.items.push(rec);
}
var bl = []; for (var k2 in boards) bl.push(k2); out.artboards = bl;
return out;`,
    { timeoutMs: 8000 },
  );
  if (!res.ok) throw new Error(res.error);
  return { data: res.data, summary: summarizeSelection(res.data) };
}

// One compact, plain line block the model reads at the top of each message.
export function summarizeSelection(d) {
  if (!d || d.noDocument) return "No document open in Illustrator.";
  const head = `Document "${d.doc}", active artboard "${d.activeArtboard}".`;
  if (d.kind === "nothing") return `${head} Nothing is selected.`;
  if (d.kind === "text") {
    const part = d.frameText && d.frameText !== d.text ? ` inside the text frame "${clip(d.frameText, 80)}"` : "";
    return `${head} Editing text: "${clip(d.text, 120)}" is selected (${d.length} characters)${part}, ${d.font || "?"} ${d.size || "?"}pt. Change only this range unless asked otherwise. Frame ref: ${d.frameRef}.`;
  }
  const lines = d.items.map((it) => {
    const bits = [it.type + (it.name ? ` "${it.name}"` : "")];
    if (it.text) bits.push(`text "${clip(it.text, 60)}" ${it.font || ""} ${it.size || ""}pt`.trim());
    if (it.children != null) bits.push(`${it.clippingGroup ? "clipping group" : "group"} of ${it.children}`);
    if (it.inGroup) bits.push(`inside group "${it.inGroup}"${it.insideClippingMask ? " (a clipping mask)" : ""}`);
    if (it.isClippingPath) bits.push("this is the clipping path");
    if (it.selectedPoints) bits.push(`only ${it.selectedPoints} points selected (Direct Selection)`);
    if (it.file) bits.push(`image ${it.file}`);
    if (it.symbol) bits.push(`symbol "${it.symbol}"`);
    if (it.fill) bits.push(`fill ${it.fill}`);
    if (it.stroke) bits.push(`stroke ${it.stroke}`);
    bits.push(`${it.w}×${it.h}pt at [${it.bounds.join(", ")}]`);
    bits.push(it.artboard ? `on "${it.artboard}"` : "off the artboards");
    bits.push(`layer "${it.layer}"`);
    return `- ${bits.join(", ")}. ref: ${it.ref}`;
  });
  const more = d.count > d.items.length ? `\n- …and ${d.count - d.items.length} more.` : "";
  const span = d.artboards && d.artboards.length > 1 ? ` across artboards ${d.artboards.map((a) => `"${a}"`).join(", ")}` : "";
  return `${head} ${d.count} item${d.count === 1 ? "" : "s"} selected${span}:\n${lines.join("\n")}${more}`;
}

function clip(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Run a surgical ExtendScript edit against the live doc.
export async function edit(code) {
  const res = await runViaStdout(APP, code, { timeoutMs: 180000 });
  return { ok: res.ok, result: res.data, error: res.error, logs: res.logs || [] };
}

// Export the active artboard to a PNG and return it as base64 so the agent can
// SEE its own work and the UI can preview it.
export async function render() {
  const out = join(scratchDir(), `il_render_${Date.now()}.png`);
  const res = await runViaStdout(
    APP,
    `
if (app.documents.length === 0) throw new Error('No open document to render.');
var doc = app.activeDocument;
var idx = doc.artboards.getActiveArtboardIndex();
var r = doc.artboards[idx].artboardRect, aw = r[2]-r[0], ah = r[1]-r[3];
var sc = Math.min(100, Math.round(${Number(env.renderMaxPx)}*100/Math.max(aw,ah))); if (sc<5) sc=5;
var o = new ExportOptionsPNG24();
o.antiAliasing = true; o.transparency = false; o.artBoardClipping = true;
o.horizontalScale = sc; o.verticalScale = sc;
doc.exportFile(new File(${JSON.stringify(out)}), ExportType.PNG24, o);
return 'ok';`,
  );
  if (!res.ok) throw new Error(res.error);
  return { image: { media_type: "image/png", data: readPng(out).toString("base64") }, note: "active artboard" };
}

// Render a specific OPEN document by name (for previews of files that aren't the
// active doc). Activates it, exports its active artboard, then restores focus.
export async function renderNamed(name) {
  const out = join(scratchDir(), `il_rn_${Date.now()}.png`);
  const res = await runViaStdout(
    APP,
    `if (app.documents.length === 0) throw new Error('No open document.');
var prev = app.activeDocument;
var target = null;
for (var i=0;i<app.documents.length;i++){ if (app.documents[i].name === ${JSON.stringify(name)}){ target = app.documents[i]; break; } }
if (!target) throw new Error('Not open: ' + ${JSON.stringify(name)});
app.activeDocument = target;
var doc = target;
var idx = doc.artboards.getActiveArtboardIndex();
var r = doc.artboards[idx].artboardRect, aw=r[2]-r[0], ah=r[1]-r[3];
var sc = Math.min(100, Math.round(${Number(env.renderMaxPx)}*100/Math.max(aw,ah))); if (sc<5) sc=5;
var o = new ExportOptionsPNG24(); o.antiAliasing=true; o.transparency=false; o.artBoardClipping=true; o.horizontalScale=sc; o.verticalScale=sc;
doc.exportFile(new File(${JSON.stringify(out)}), ExportType.PNG24, o);
try { if (prev) app.activeDocument = prev; } catch(e){}
return 'ok';`,
  );
  if (!res.ok) throw new Error(res.error);
  return { image: { media_type: "image/png", data: readPng(out).toString("base64") }, note: "artboard" };
}

// ---------- exports and saving ----------
//
// Illustrator can only write a PDF (or an .ai) with doc.saveAs(), and saveAs
// REPOINTS the open document at the new file and marks it saved. So both are
// made from a throwaway copy, never from the user's document:
//   - saved on disk with no pending changes: copy the file, open the copy;
//   - otherwise (unsaved changes, or never saved): rebuild it in a new
//     document (artboards, layers, artwork duplicated across).
// The user's document keeps its name, path and unsaved state; every call checks
// that and reports it. (Rebuilding marks the source as changed, which is why
// only documents that already have unsaved changes are rebuilt.)

const DOC_TOOLS = `
function __snap(d){ var p=null; try{ p=d.fullName.fsName; }catch(e){} return { name:d.name, path:p, saved:d.saved }; }
function __sameSnap(a,b){ return a.name===b.name && a.path===b.path && a.saved===b.saved; }
// Saved on disk? Straight after a save Illustrator may still be writing the
// file in the background, and opening a half-written copy hangs it, so wait
// (up to a minute) until the file has been quiet for 3 s. A saved document
// must take this path: rebuilding duplicates its art, which marks it changed.
function __onDisk(d){
  try {
    if (!d.saved) return false;
    for (var i=0; i<120; i++){
      var f = new File(d.fullName.fsName);
      if (!f.exists) return false;
      if (new Date().getTime() - f.modified.getTime() > 3000) return true;
      $.sleep(500);
    }
    return true;
  } catch(e){ return false; }
}
function __copyLayer(sL, tLayers){
  var tL = tLayers.add(); tL.name = sL.name;
  for (var i=sL.layers.length-1; i>=0; i--) __copyLayer(sL.layers[i], tL.layers);
  // pageItems holds the layer's own items only (sublayers are copied above);
  // duplicating works even from hidden or locked layers.
  for (var j=0; j<sL.pageItems.length; j++) sL.pageItems[j].duplicate(tL, ElementPlacement.PLACEATEND);
  try{ tL.printable = sL.printable; }catch(e){}
  try{ tL.visible = sL.visible; }catch(e){}
  try{ tL.locked = sL.locked; }catch(e){}
}
function __rebuild(src){
  var abs = src.artboards, r0 = abs[0].artboardRect;
  var t = app.documents.add(src.documentColorSpace, r0[2]-r0[0], r0[1]-r0[3]);
  t.artboards[0].artboardRect = r0; t.artboards[0].name = abs[0].name;
  for (var i=1; i<abs.length; i++){ var a = t.artboards.add(abs[i].artboardRect); a.name = abs[i].name; }
  var seed = t.layers[0];
  for (var li=src.layers.length-1; li>=0; li--) __copyLayer(src.layers[li], t.layers);
  seed.remove();
  return t;
}
// Run fn(copy) on a throwaway copy of src, then close it and put src back in front.
function __withCopy(src, tmpPath, fn){
  var dup = null, tmpFile = null, made = '';
  try {
    if (__onDisk(src)){
      tmpFile = new File(tmpPath);
      if (!(new File(src.fullName.fsName)).copy(tmpFile)) throw new Error('Could not copy the file to make the export.');
      dup = app.open(tmpFile); made = 'from the saved file';
    } else {
      dup = __rebuild(src); made = 'from the current, unsaved state';
    }
    fn(dup);
  } finally {
    try{ if (dup) dup.close(SaveOptions.DONOTSAVECHANGES); }catch(e){}
    try{ if (tmpFile && tmpFile.exists) tmpFile.remove(); }catch(e){}
    try{ app.activeDocument = src; }catch(e){}
  }
  return made;
}
`;

function pdfOptionsScript({ preset, bleedPt, cropMarks, artboards }) {
  return `
var __presets = app.PDFPresetsList, __ok = false;
for (var i=0;i<__presets.length;i++){ if (__presets[i] === ${JSON.stringify(preset)}) __ok = true; }
if (!__ok) throw new Error('Unknown PDF preset ' + ${JSON.stringify(preset)} + '. Available: ' + __presets.join(', '));
var o = new PDFSaveOptions();
o.pDFPreset = ${JSON.stringify(preset)};
o.preserveEditability = false; o.viewAfterSaving = false; o.generateThumbnails = true;
o.bleedLink = true; o.bleedOffsetRect = [${bleedPt}, ${bleedPt}, ${bleedPt}, ${bleedPt}];
o.trimMarks = ${cropMarks ? "true" : "false"};
${cropMarks ? `o.pageMarksType = PageMarksTypes.Roman; o.trimMarkWeight = PDFTrimMarkWeight.TRIMMARKWEIGHT025; o.offset = ${Math.max(bleedPt, 6)};` : ""}
${artboards ? `o.artboardRange = ${JSON.stringify(String(artboards))};` : ""}`;
}

const MM = 72 / 25.4;

// Export a COPY to a new file. Never overwrites, never touches the source.
export async function exportCopy({ format = "png", name, outputDir, preset, bleedMm, cropMarks, artboards } = {}) {
  const f = String(format || "png").toLowerCase().replace("jpeg", "jpg");
  if (!capabilities.export.includes(f)) {
    throw new Error(`Illustrator export supports ${capabilities.export.join(", ")}; not "${format}".`);
  }
  const docName = await activeDocName();
  const out = newOutputPath({ outputDir, name: name || docName, ext: f });
  const warnings = [];

  if (f === "pdf") {
    const p = preset || "[PDF/X-4:2008]";
    const bleed = bleedMm == null || bleedMm === "" ? 3 : Math.max(0, Math.min(25, Number(bleedMm) || 0));
    const marks = cropMarks == null ? true : !!cropMarks;
    const tmp = join(scratchDir(), `il_copy_${Date.now()}.ai`);
    const res = await runViaStdout(
      APP,
      `${DOC_TOOLS}
if (app.documents.length===0) throw new Error('No open document to export.');
var __ui = app.userInteractionLevel; app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
try {
  var src = app.activeDocument, before = __snap(src);
  ${pdfOptionsScript({ preset: p, bleedPt: +(bleed * MM).toFixed(3), cropMarks: marks, artboards })}
  var made = __withCopy(src, ${JSON.stringify(tmp)}, function(dup){ dup.saveAs(new File(${JSON.stringify(out)}), o); });
  var after = __snap(app.activeDocument);
  return { made: made, unchanged: __sameSnap(before, after), before: before, after: after,
    rgb: src.documentColorSpace === DocumentColorSpace.RGB, artboards: src.artboards.length,
    written: (new File(${JSON.stringify(out)})).exists };
} finally { app.userInteractionLevel = __ui; }`,
      { timeoutMs: 300000 },
    );
    if (!res.ok) throw new Error(res.error);
    const d = res.data;
    if (!d.written) throw new Error("Illustrator reported no error but wrote no PDF.");
    if (d.rgb) warnings.push("RGB document. PDF/X-4 keeps RGB, but many printers want CMYK; ask yours.");
    if (!d.unchanged) warnings.push("The open document's name, path or saved state changed during export; check it.");
    const parts = [`${p.replace(/[\[\]]/g, "")}`, bleed ? `${bleed} mm bleed` : "no bleed", marks ? "crop marks" : "no crop marks"];
    return {
      path: out,
      format: "pdf",
      note: `PDF (${parts.join(", ")}), ${artboards ? `artboards ${artboards}` : `all ${d.artboards} artboard${d.artboards === 1 ? "" : "s"}`}, made ${d.made}.`,
      warnings,
      documentUnchanged: d.unchanged,
    };
  }

  const opt =
    f === "svg"
      ? `var o=new ExportOptionsSVG(); o.embedRasterImages=true; var type=ExportType.SVG;`
      : f === "jpg"
        ? `var o=new ExportOptionsJPEG(); o.qualitySetting=85; o.artBoardClipping=true; var type=ExportType.JPEG;`
        : `var o=new ExportOptionsPNG24(); o.antiAliasing=true; o.artBoardClipping=true; var type=ExportType.PNG24;`;
  const res = await runViaStdout(
    APP,
    `
if (app.documents.length===0) throw new Error('No open document to export.');
${opt}
var d = app.activeDocument;
d.exportFile(new File(${JSON.stringify(out)}), type, o);
return { artboard: d.artboards[d.artboards.getActiveArtboardIndex()].name, rgb: d.documentColorSpace === DocumentColorSpace.RGB };`,
  );
  if (!res.ok) throw new Error(res.error);
  const what = {
    png: "PNG of the active artboard, for screens and previews, not print",
    jpg: "JPG of the active artboard, for screens, not print",
    svg: "SVG of the document, for the web",
  }[f];
  return { path: out, format: f, note: `${what} (artboard "${res.data.artboard}").`, warnings, documentUnchanged: true };
}

// Save the document. mode "overwrite" saves the file itself (Cmd+S / Ctrl+S); mode
// "copy" writes a new .ai and leaves the open document as it is.
export async function saveDocument({ mode = "copy", name, outputDir } = {}) {
  if (mode === "overwrite") {
    const res = await runViaStdout(
      APP,
      `${DOC_TOOLS}
if (app.documents.length===0) throw new Error('No open document to save.');
var d = app.activeDocument, s = __snap(d);
if (!s.path || !(new File(s.path)).exists) return { neverSaved:true, name:d.name };
var was = d.saved;
d.save();
return { path: d.fullName.fsName, name: d.name, hadChanges: !was };`,
      { timeoutMs: 300000 },
    );
    if (!res.ok) throw new Error(res.error);
    if (res.data.neverSaved) {
      throw new Error(`"${res.data.name}" has never been saved, so there is no original to overwrite. Save a copy instead.`);
    }
    return {
      path: res.data.path,
      mode: "overwrite",
      note: res.data.hadChanges ? `Saved "${res.data.name}" over the original file.` : `"${res.data.name}" had no unsaved changes; saved anyway.`,
      warnings: [],
    };
  }
  const docName = await activeDocName();
  const out = newOutputPath({ outputDir, name: name || `${docName.replace(/\.ai$/i, "")} copy`, ext: "ai" });
  const tmp = join(scratchDir(), `il_copy_${Date.now()}.ai`);
  const res = await runViaStdout(
    APP,
    `${DOC_TOOLS}
if (app.documents.length===0) throw new Error('No open document to save.');
var __ui = app.userInteractionLevel; app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
try {
  var src = app.activeDocument, before = __snap(src), made;
  if (__onDisk(src) && /\\.ai$/i.test(before.path)) {
    if (!(new File(before.path)).copy(new File(${JSON.stringify(out)}))) throw new Error('Could not copy the file.');
    made = 'from the saved file';
  } else {
    made = __withCopy(src, ${JSON.stringify(tmp)}, function(dup){ dup.saveAs(new File(${JSON.stringify(out)}), new IllustratorSaveOptions()); });
  }
  var after = __snap(app.activeDocument);
  return { made: made, unchanged: __sameSnap(before, after), written: (new File(${JSON.stringify(out)})).exists };
} finally { app.userInteractionLevel = __ui; }`,
    { timeoutMs: 300000 },
  );
  if (!res.ok) throw new Error(res.error);
  if (!res.data.written) throw new Error("Illustrator reported no error but wrote no file.");
  const warnings = res.data.unchanged ? [] : ["The open document's name, path or saved state changed; check it."];
  return {
    path: out,
    mode: "copy",
    note: `Saved a copy as an Illustrator file, made ${res.data.made}. The open document is unchanged and still has its own unsaved changes, if any.`,
    warnings,
    documentUnchanged: res.data.unchanged,
  };
}

// Read-only print check of the active document.
export async function preflight() {
  const res = await runViaStdout(
    APP,
    `
if (app.documents.length===0) throw new Error('No open document.');
var doc = app.activeDocument, MM = 25.4/72, w = [], info = {};
function r1(n){ return Math.round(n*10)/10; }
info.colorMode = doc.documentColorSpace === DocumentColorSpace.CMYK ? 'CMYK' : 'RGB';
if (info.colorMode === 'RGB') w.push('Colour mode is RGB. Most print jobs want CMYK; check with the printer.');
info.artboards = [];
var abs = [];
for (var a=0;a<doc.artboards.length;a++){ var r = doc.artboards[a].artboardRect; abs.push(r);
  info.artboards.push({ name: doc.artboards[a].name, widthMm: r1((r[2]-r[0])*MM), heightMm: r1((r[1]-r[3])*MM) }); }
try { info.effectResolutionPpi = doc.rasterEffectSettings.resolution; if (info.effectResolutionPpi < 300) w.push('Effects resolution is ' + info.effectResolutionPpi + ' ppi (Effect > Document Raster Effects Settings); 300 is usual for print.'); } catch(e){}
// fonts and live text
var fonts = {}, missing = {}, nText = doc.textFrames.length;
for (var t=0; t<nText && t<600; t++){
  try { var fn = doc.textFrames[t].textRange.characterAttributes.textFont.name; fonts[fn] = 1;
    try { app.textFonts.getByName(fn); } catch(e2){ missing[fn] = 1; } } catch(e){}
}
var fl = [], ml = []; for (var k in fonts) fl.push(k); for (var m in missing) ml.push(m);
info.liveTextFrames = nText; info.fonts = fl;
if (ml.length) w.push('Missing fonts: ' + ml.join(', ') + '.');
// links
var linked = doc.placedItems.length, broken = 0;
for (var p=0; p<linked; p++){ try { if (!doc.placedItems[p].file.exists) broken++; } catch(e){ broken++; } }
info.linkedImages = linked; info.embeddedImages = doc.rasterItems.length;
if (broken) w.push(broken + ' linked image' + (broken>1?'s are':' is') + ' missing.');
// art off or across the artboard edges (top-level items only)
var off = 0, across = 0, n = 0;
for (var li=0; li<doc.layers.length; li++){
  var L = doc.layers[li]; if (!L.visible) continue;
  for (var pi=0; pi<L.pageItems.length && n<3000; pi++, n++){
    var it = L.pageItems[pi], b; if (it.hidden) continue;
    try { b = it.visibleBounds; } catch(e){ continue; }
    var inside = false, crosses = false;
    for (var ai=0; ai<abs.length; ai++){ var r = abs[ai];
      var hit = b[0] < r[2] && b[2] > r[0] && b[1] > r[3] && b[3] < r[1];
      if (hit){ inside = true; if (b[0] < r[0] || b[2] > r[2] || b[1] > r[1] || b[3] < r[3]) crosses = true; } }
    if (!inside) off++; else if (crosses) across++;
  }
}
info.itemsOffArtboard = off; info.itemsCrossingEdge = across;
if (off) w.push(off + ' item' + (off>1?'s sit':' sits') + ' entirely off the artboards (they will not print).');
if (across) w.push(across + ' item' + (across>1?'s cross':' crosses') + ' an artboard edge: fine if meant to bleed; otherwise keep art inside the safe area.');
// spot colours and hidden or non-printing layers
var spots = []; for (var s=0; s<doc.spots.length; s++){ var sn = doc.spots[s].name; if (sn !== '[Registration]') spots.push(sn); }
info.spotColors = spots;
var hidden = [], nonPrinting = [];
for (var hl=0; hl<doc.layers.length; hl++){ var HL = doc.layers[hl]; if (!HL.visible) hidden.push(HL.name); else if (!HL.printable) nonPrinting.push(HL.name); }
if (hidden.length) w.push('Hidden layers (left out of print): ' + hidden.join(', ') + '.');
if (nonPrinting.length) w.push('Non-printing layers: ' + nonPrinting.join(', ') + '.');
info.note = 'Document bleed and overprint are not readable by script; the PDF export sets its own bleed.';
return { document: doc.name, info: info, warnings: w };`,
    { timeoutMs: 180000 },
  );
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

async function activeDocName() {
  const res = await runViaStdout(APP, `if (app.documents.length===0) throw new Error('No open document.'); return app.activeDocument.name;`);
  if (!res.ok) throw new Error(res.error);
  return String(res.data || "document").replace(/\.[a-z0-9]{2,4}$/i, "");
}

export async function undo() {
  const res = await runViaStdout(APP, `app.undo(); return 'ok';`);
  return { ok: res.ok, error: res.error };
}
