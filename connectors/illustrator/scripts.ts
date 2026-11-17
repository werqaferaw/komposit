// Illustrator's ExtendScript, ported from 1.0's bridges/illustrator.mjs and handoff.mjs.
// Every script runs inside the guard (quiet mode, the target document as `doc`), so the
// scripts below use `doc` where 1.0 used app.activeDocument.
import type { DocRef } from "../../protocol/common.ts";
import type { Guard } from "../_kit/envelope.ts";
import { refLiteral } from "../_kit/adobe.ts";

const q = (s: unknown) => JSON.stringify(String(s));

// Quiet mode: no alerts while Komposit's script runs (restored afterwards). The target
// document: by path, else by name (only one that was never saved, or the ref has no
// path), else an error. If it isn't the front document it is brought forward for the
// script and the person's front document is put back afterwards; nothing is saved or
// repointed. Kept to helpers in `before` so the setup line stays short.
export function guard(doc?: DocRef): Guard {
  return {
    before: `var __ui = app.userInteractionLevel; app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
var __kpPath = function(d){ try { var p = d.fullName.fsName; return (new File(p)).exists ? p : null; } catch(e){ return null; } };
var __kpSame = function(a, b){ return !!a && !!b && a.name === b.name && __kpPath(a) === __kpPath(b); };
var __kpFind = function(ref){
  if (app.documents.length === 0) throw new Error('No document is open in Illustrator.');
  if (!ref) return app.activeDocument;
  if (ref.path) { for (var i=0;i<app.documents.length;i++){ if (__kpPath(app.documents[i]) === ref.path) return app.documents[i]; } }
  for (var j=0;j<app.documents.length;j++){ var d = app.documents[j]; if (d.name === ref.name && (!ref.path || __kpPath(d) === null)) return d; }
  throw new Error(ref.name + ' is not open in Illustrator anymore.');
};`,
    setup: doc
      ? `var doc = __kpFind(${refLiteral(doc)}); var __prev = app.activeDocument; if (__kpSame(doc, __prev)) { __prev = null; } else { app.activeDocument = doc; }`
      : `var __prev = null; var doc = app.documents.length ? app.activeDocument : null;`,
    after: `try { if (__prev) app.activeDocument = __prev; } catch(e){} app.userInteractionLevel = __ui;`,
  };
}

export const DOCUMENTS = `
var docs = [], active = app.documents.length ? app.activeDocument : null;
for (var i=0;i<app.documents.length;i++){
  var d = app.documents[i];
  docs.push({ name:d.name, path:__kpPath(d), active:__kpSame(d, active) });
}
return { documents: docs };`;

// "Show in": the target document stays in front (the guard would put the one that was in front
// back, so that's switched off here). The app itself comes forward from the transport.
export const SHOW = `if (!doc) return null; __prev = null; return doc.name;`;

export const DOC_NAME = `if (!doc) throw new Error('No document is open in Illustrator.'); return doc.name;`;

// Walk the doc into a compact, model-readable state map. Every item carries a `ref` that
// is directly usable in a run script.
export const INSPECT = `
if (!doc) return { noDocument:true };
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
return { appVersion:String(app.version), name:doc.name, unit:String(doc.rulerUnits), artboards:abs, layers:layers, itemCount:count, truncated:truncated };`;

// What the person has selected right now, read live (fast, read-only). Covers the cases
// that trip an agent up: a text range being edited inside a frame, items nested in groups
// or clipping masks (with a ref straight to them), only some points of a path picked with
// the Direct Selection tool, selections that span artboards, and nothing selected at all.
export const SELECTION = `
if (!doc) return { noDocument: true };
var s = doc.selection, MAX = 25;
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
return out;`;

// Illustrator marks a document as changed when it exports a picture of it (it remembers
// the export; seen on 30.5 in the live test), though nothing in the artwork changed. So a
// document that had no unsaved changes is marked saved again afterwards; one that had
// changes keeps them. Without this, looking at a saved file made Illustrator ask "save
// changes?" when the person closed it.
const KEEP_SAVED_BEFORE = `var __kpWasSaved = false; try { __kpWasSaved = doc.saved === true; } catch(e){}`;
const KEEP_SAVED_AFTER = `try { if (__kpWasSaved && !doc.saved) doc.saved = true; } catch(e){}`;

// Pictures (render, inspect) and PNG and JPG exports go through Export for Screens
// (Illustrator CC 2018 and later). exportFile leaves a hidden step in the document's undo
// history on Illustrator 2026, so after Komposit looked at a document the next undo, the AI's
// or the person's Cmd+Z, undid nothing visible (live test, Nov 16); Export for Screens leaves
// the history and the saved flag alone, in about 40 ms. It writes
// <folder>/<factor>x/<prefix><artboard name>.<ext>: the file is copied to `out` and the folder
// removed. Without Export for Screens: false, and the caller uses exportFile.
const SCREENS = `
function __kpFindFile(dir, re){ var list = dir.getFiles(); for (var i=0;i<list.length;i++){ var x = list[i]; if (x instanceof Folder){ var f = __kpFindFile(x, re); if (f) return f; } else if (re.test(decodeURI(x.name))) return x; } return null; }
function __kpRemoveTree(dir){ try { var list = dir.getFiles(); for (var i=0;i<list.length;i++){ var x = list[i]; if (x instanceof Folder) __kpRemoveTree(x); else x.remove(); } dir.remove(); } catch(e){} }
function __kpScreens(doc, idx, kind, factor, transparent, out){
  if (typeof ExportForScreensType === 'undefined') return false;
  var tmp = new Folder(out + '.d'); if (!tmp.exists) tmp.create();
  try {
    var o = kind === 'jpg' ? new ExportForScreensOptionsJPEG() : new ExportForScreensOptionsPNG24();
    try { o.antiAliasing = AntiAliasingMethod.ARTOPTIMIZED; } catch(e){}
    if (kind !== 'jpg'){ try { o.transparency = transparent; } catch(e){} }
    o.scaleType = ExportForScreensScaleType.SCALEBYFACTOR; o.scaleTypeValue = factor;
    var it = new ExportForScreensItemToExport(); it.artboards = String(idx + 1); it.document = false;
    doc.exportForScreens(tmp, kind === 'jpg' ? ExportForScreensType.SE_JPEG80 : ExportForScreensType.SE_PNG24, o, it, 'kp_');
    var made = __kpFindFile(tmp, kind === 'jpg' ? /\\.jpe?g$/i : /\\.png$/i);
    if (!made) throw new Error('Export for Screens wrote no file.');
    var dest = new File(out); if (dest.exists) dest.remove();
    if (!made.copy(dest)) throw new Error('Could not move the exported file.');
  } finally { __kpRemoveTree(tmp); }
  return true;
}`;

// Export the doc's active artboard to a PNG so the agent can SEE its own work.
export function render(out: string, maxPx: number): string {
  return `${SCREENS}
if (!doc) throw new Error('No open document to render.');
var idx = doc.artboards.getActiveArtboardIndex();
var r = doc.artboards[idx].artboardRect, aw = r[2]-r[0], ah = r[1]-r[3];
var sc = Math.min(100, Math.round(${Number(maxPx)}*100/Math.max(aw,ah))); if (sc<5) sc=5;
${KEEP_SAVED_BEFORE}
if (!__kpScreens(doc, idx, 'png', sc / 100, false, ${q(out)})) {
  var o = new ExportOptionsPNG24();
  o.antiAliasing = true; o.transparency = false; o.artBoardClipping = true;
  o.horizontalScale = sc; o.verticalScale = sc;
  doc.exportFile(new File(${q(out)}), ExportType.PNG24, o);
}
${KEEP_SAVED_AFTER}
return { artboard: doc.artboards[idx].name };`;
}

// ---------- exports and saving ----------
//
// Illustrator can only write a PDF (or an .ai) with doc.saveAs(), and saveAs REPOINTS the
// open document at the new file and marks it saved. So both are made from a throwaway
// copy, never from the person's document:
//   - saved on disk with no pending changes: copy the file, open the copy;
//   - otherwise (unsaved changes, or never saved): rebuild it in a new document
//     (artboards, layers, artwork duplicated across).
// The person's document keeps its name, path and unsaved state; every call checks that
// and reports it. (Rebuilding marks the source as changed, which is why only documents
// that already have unsaved changes are rebuilt.)
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

function pdfOptionsScript({ preset, bleedPt, cropMarks, artboards }: { preset: string; bleedPt: number; cropMarks: boolean; artboards?: string }): string {
  return `
var __presets = app.PDFPresetsList, __ok = false;
for (var i=0;i<__presets.length;i++){ if (__presets[i] === ${q(preset)}) __ok = true; }
if (!__ok) throw new Error('Unknown PDF preset ' + ${q(preset)} + '. Available: ' + __presets.join(', '));
var o = new PDFSaveOptions();
o.pDFPreset = ${q(preset)};
o.preserveEditability = false; o.viewAfterSaving = false; o.generateThumbnails = true;
o.bleedLink = true; o.bleedOffsetRect = [${bleedPt}, ${bleedPt}, ${bleedPt}, ${bleedPt}];
o.trimMarks = ${cropMarks ? "true" : "false"};
${cropMarks ? `o.pageMarksType = PageMarksTypes.Roman; o.trimMarkWeight = PDFTrimMarkWeight.TRIMMARKWEIGHT025; o.offset = ${Math.max(bleedPt, 6)};` : ""}
${artboards ? `o.artboardRange = ${q(artboards)};` : ""}`;
}

export function exportPdf(opts: { out: string; tmp: string; preset: string; bleedPt: number; cropMarks: boolean; artboards?: string }): string {
  return `${DOC_TOOLS}
if (!doc) throw new Error('No open document to export.');
var src = doc, before = __snap(src);
${pdfOptionsScript(opts)}
var made = __withCopy(src, ${q(opts.tmp)}, function(dup){ dup.saveAs(new File(${q(opts.out)}), o); });
var after = __snap(src);
return { made: made, unchanged: __sameSnap(before, after), before: before, after: after,
  rgb: src.documentColorSpace === DocumentColorSpace.RGB, artboards: src.artboards.length,
  written: (new File(${q(opts.out)})).exists };`;
}

export function exportImage(format: "png" | "jpg" | "svg", out: string): string {
  const opt =
    format === "svg"
      ? `var o=new ExportOptionsSVG(); o.embedRasterImages=true; var type=ExportType.SVG;`
      : format === "jpg"
        ? `var o=new ExportOptionsJPEG(); o.qualitySetting=85; o.artBoardClipping=true; var type=ExportType.JPEG;`
        : `var o=new ExportOptionsPNG24(); o.antiAliasing=true; o.artBoardClipping=true; var type=ExportType.PNG24;`;
  // PNG and JPG: Export for Screens (see SCREENS), the active artboard at full size. SVG is the
  // whole document, which only exportFile writes.
  const screens = format === "svg" ? "false" : `__kpScreens(doc, doc.artboards.getActiveArtboardIndex(), ${q(format)}, 1, true, ${q(out)})`;
  return `${SCREENS}
if (!doc) throw new Error('No open document to export.');
${opt}
${KEEP_SAVED_BEFORE}
if (!${screens}) doc.exportFile(new File(${q(out)}), type, o);
${KEEP_SAVED_AFTER}
return { artboard: doc.artboards[doc.artboards.getActiveArtboardIndex()].name, rgb: doc.documentColorSpace === DocumentColorSpace.RGB };`;
}

// Save the document over its own file (Cmd+S / Ctrl+S).
export const SAVE_OVERWRITE = `${DOC_TOOLS}
if (!doc) throw new Error('No open document to save.');
var s = __snap(doc);
if (!s.path || !(new File(s.path)).exists) return { neverSaved:true, name:doc.name };
var was = doc.saved;
doc.save();
return { path: doc.fullName.fsName, name: doc.name, hadChanges: !was };`;

// Save as a new file: the open document becomes that file (a new piece in a project, so
// later saves go there). Only when the person asked for exactly that.
export function saveAs(out: string): string {
  return `if (!doc) throw new Error('No open document to save.');
doc.saveAs(new File(${q(out)}), new IllustratorSaveOptions());
return { path: doc.fullName.fsName, name: doc.name };`;
}

// A copy as a new .ai; the open document stays as it is.
export function saveCopy(out: string, tmp: string): string {
  return `${DOC_TOOLS}
if (!doc) throw new Error('No open document to save.');
var src = doc, before = __snap(src), made;
if (__onDisk(src) && /\\.ai$/i.test(before.path)) {
  if (!(new File(before.path)).copy(new File(${q(out)}))) throw new Error('Could not copy the file.');
  made = 'from the saved file';
} else {
  made = __withCopy(src, ${q(tmp)}, function(dup){ dup.saveAs(new File(${q(out)}), new IllustratorSaveOptions()); });
}
var after = __snap(src);
return { made: made, unchanged: __sameSnap(before, after), written: (new File(${q(out)})).exists };`;
}

// Read-only print check of the document.
export const PREFLIGHT = `
if (!doc) throw new Error('No open document.');
var MM = 25.4/72, w = [], info = {};
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
return { document: doc.name, info: info, warnings: w };`;

export function undo(steps: number): string {
  return `if (!doc) throw new Error('No document is open in Illustrator.');
for (var i=0;i<${steps};i++) app.undo();
return ${steps};`;
}

// Create a new blank document (so you can komposit from scratch, not only edit an
// existing file). The new document stays in front: the person asked for it.
export function newDocument(width: number, height: number): string {
  return `var d = app.documents.add(DocumentColorSpace.RGB, ${Number(width)}, ${Number(height)});
__prev = null;
return { name: d.name };`;
}

// Open a file and make it the front document, or bring it forward if it's already open.
export function open(path: string): string {
  return `
var f = new File(${q(path)});
if (!f.exists) throw new Error("No file at " + f.fsName);
__prev = null;
for (var i = 0; i < app.documents.length; i++) {
  var p = null;
  try { p = app.documents[i].fullName.fsName; } catch (e) {}
  if (p === f.fsName) { app.documents[i].activate(); return { opened: app.documents[i].name, path: p, already: true }; }
}
var d = app.open(f); return { opened: d.name, path: f.fsName, already: false };`;
}

// Bring a file into the document: placed on the active artboard, centred; linked unless
// said otherwise.
export function place(path: string, linked: boolean): string {
  return `
if (!doc) throw new Error("No document is open in Illustrator to place into.");
var f = new File(${q(path)});
if (!f.exists) throw new Error("No file at " + f.fsName);
var item = doc.placedItems.add();
item.file = f;
var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()].artboardRect;
item.position = [(ab[0] + ab[2]) / 2 - item.width / 2, (ab[1] + ab[3]) / 2 + item.height / 2];
var size = [Math.round(item.width), Math.round(item.height)];
${linked ? "" : "item.embed();"}
return { placed: f.name, into: doc.name, linked: ${linked}, size: size };`;
}
