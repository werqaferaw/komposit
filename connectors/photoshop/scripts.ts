// Photoshop's ExtendScript, ported from 1.0's bridges/photoshop.mjs and handoff.mjs.
// Every script runs inside the guard (quiet mode, the target document as `doc`).
import type { DocRef } from "../../protocol/common.ts";
import { UNDO_LABEL } from "../../protocol/connector.ts";
import type { Guard } from "../_kit/envelope.ts";
import { refLiteral } from "../_kit/adobe.ts";

const q = (s: unknown) => JSON.stringify(String(s));

// Quiet mode: displayDialogs = NO while Komposit's script runs (restored afterwards). The
// target document by its id (Photoshop's documentID, stable while it's open), else its
// path, else its name. Photoshop's Action Manager only works on the front document, so a
// target in the back is brought forward for the script and the person's front document is
// put back afterwards. Nothing is saved or repointed.
//
// With a label (edits, place), the code runs inside doc.suspendHistory: the whole step is one
// history state with that name ("Komposit: Recolour the title"), so the person's Undo takes it
// back in one go, a busy request doesn't push their own states out of the history, and
// Komposit's undo can tell its steps from theirs. suspendHistory runs a string, so the code is
// handed over through $.global and any error is carried back out and thrown again.
export function guard(doc?: DocRef, label?: string): Guard {
  return {
    ...(label ? { call: `__kpSuspend(doc, ${q(label)}, __kpFn)` } : {}),
    before: `var __dd = app.displayDialogs; app.displayDialogs = DialogModes.NO;
var __kpPath = function(d){ try { return d.fullName.fsName; } catch(e){ return null; } };
var __kpId = function(d){ try { return d.id === undefined ? null : String(d.id); } catch(e){ return null; } };
var __kpSame = function(a, b){ if (!a || !b) return false; var ia = __kpId(a); return ia !== null ? ia === __kpId(b) : (a.name === b.name && __kpPath(a) === __kpPath(b)); };
var __kpFind = function(ref){
  if (app.documents.length === 0) throw new Error('No document is open in Photoshop.');
  if (!ref) return app.activeDocument;
  var i, d;
  if (ref.id) { for (i=0;i<app.documents.length;i++){ if (__kpId(app.documents[i]) === ref.id) return app.documents[i]; } }
  if (ref.path) { for (i=0;i<app.documents.length;i++){ if (__kpPath(app.documents[i]) === ref.path) return app.documents[i]; } }
  if (!ref.id) { for (i=0;i<app.documents.length;i++){ d = app.documents[i]; if (d.name === ref.name && (!ref.path || __kpPath(d) === null)) return d; } }
  throw new Error(ref.name + ' is not open in Photoshop anymore.');
};
var __kpSuspend = function(d, label, fn){
  if (!d || typeof d.suspendHistory !== 'function') return fn();
  var g = $.global; g.__kpRun = fn; g.__kpRunOut = undefined; g.__kpRunErr = undefined;
  try { d.suspendHistory(label, 'try { $.global.__kpRunOut = $.global.__kpRun(); } catch (e) { $.global.__kpRunErr = e; }'); }
  finally { g.__kpRun = undefined; }
  var err = g.__kpRunErr, out = g.__kpRunOut; g.__kpRunErr = undefined; g.__kpRunOut = undefined;
  if (err) throw err;
  return out;
};`,
    setup: doc
      ? `var doc = __kpFind(${refLiteral(doc)}); var __prev = app.activeDocument; if (__kpSame(doc, __prev)) { __prev = null; } else { app.activeDocument = doc; }`
      : `var __prev = null; var doc = app.documents.length ? app.activeDocument : null;`,
    after: `try { if (__prev) app.activeDocument = __prev; } catch(e){} app.displayDialogs = __dd;`,
  };
}

export const DOCUMENTS = `
var docs = [], active = app.documents.length ? app.activeDocument : null;
for (var i=0;i<app.documents.length;i++){
  var d = app.documents[i];
  docs.push({ name:d.name, path:__kpPath(d), id:__kpId(d), active:__kpSame(d, active) });
}
return { documents: docs };`;

// "Show in": the target document stays in front (the guard would put the one that was in front
// back, so that's switched off here). The app itself comes forward from the transport.
export const SHOW = `if (!doc) return null; __prev = null; return doc.name;`;

export const DOC_NAME = `if (!doc) throw new Error('No document is open in Photoshop.'); return doc.name;`;

export const INSPECT = `
if (!doc) return { noDocument:true };
var prevU = app.preferences.rulerUnits; app.preferences.rulerUnits = Units.PIXELS;
try {
function rnd(n){ return Math.round(Number(n)*10)/10; }
function walk(layers, path){
  var out = [];
  for (var i=0;i<layers.length;i++){
    var L = layers[i], rec = { ref:(path?path+'/':'')+i, name:L.name, type:String(L.typename), visible:L.visible, opacity:rnd(L.opacity) };
    try{ var b=L.bounds; rec.bounds=[rnd(b[0]),rnd(b[1]),rnd(b[2]),rnd(b[3])]; }catch(e){}
    try{ if (L.kind) rec.kind = String(L.kind); }catch(e){}
    if (L.typename === 'LayerSet'){ rec.children = walk(L.layers, rec.ref); }
    out.push(rec);
  }
  return out;
}
return { appVersion:String(app.version), name:doc.name, id:__kpId(doc), width:rnd(doc.width), height:rnd(doc.height), resolution:rnd(doc.resolution), layers: walk(doc.layers, '') };
} finally { app.preferences.rulerUnits = prevU; }`;

// What the person has selected right now (fast, read-only): the selected layers (several
// at once, via the layer IDs Photoshop targets), what kind each is (text, smart object,
// group, adjustment, Background), whether it sits in a group, is clipped or has a mask,
// and any active marquee selection.
export const SELECTION = `
if (!doc) return { noDocument:true };
var prevU = app.preferences.rulerUnits; app.preferences.rulerUnits = Units.PIXELS;
try {
var out = { doc: doc.name, width: Number(doc.width), height: Number(doc.height) };
function rnd(n){ return Math.round(Number(n)*10)/10; }
var ids = {}, nIds = 0;
try {
  var r = new ActionReference();
  r.putProperty(charIDToTypeID('Prpr'), stringIDToTypeID('targetLayersIDs'));
  r.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  var lst = executeActionGet(r).getList(stringIDToTypeID('targetLayersIDs'));
  for (var i=0;i<lst.count;i++){ ids[lst.getReference(i).getIdentifier()] = 1; nIds++; }
} catch(e){}
if (!nIds){ try { ids[doc.activeLayer.id] = 1; nIds = 1; } catch(e){} }
function hasMask(id){ try { var r2 = new ActionReference(); r2.putIdentifier(charIDToTypeID('Lyr '), id); return executeActionGet(r2).getBoolean(stringIDToTypeID('hasUserMask')); } catch(e){ return false; } }
var found = [];
function walk(layers, path){
  for (var i=0;i<layers.length && found.length<25;i++){
    var L = layers[i], ref = (path?path+'/':'')+i;
    if (ids[L.id]){
      var rec = { ref: ref, name: L.name, type: L.typename === 'LayerSet' ? 'group' : 'layer', visible: L.visible };
      try { rec.kind = String(L.kind).replace('LayerKind.', ''); } catch(e){}
      try { if (L.isBackgroundLayer) rec.background = true; } catch(e){}
      try { if (L.allLocked) rec.locked = true; } catch(e){}
      try { var b = L.bounds; rec.bounds = [rnd(b[0]),rnd(b[1]),rnd(b[2]),rnd(b[3])]; } catch(e){}
      try { rec.opacity = rnd(L.opacity); } catch(e){}
      try { if (L.grouped) rec.clipped = true; } catch(e){}
      try { if (L.parent.typename === 'LayerSet') rec.inGroup = L.parent.name; } catch(e){}
      if (L.typename === 'LayerSet') rec.children = L.layers.length;
      if (rec.kind === 'TEXT'){ try { var ti = L.textItem; rec.text = String(ti.contents).substr(0,160); rec.font = ti.font; rec.size = rnd(ti.size); } catch(e){} }
      if (hasMask(L.id)) rec.mask = true;
      found.push(rec);
    }
    if (L.typename === 'LayerSet') walk(L.layers, ref);
  }
}
walk(doc.layers, '');
out.layers = found; out.count = nIds;
try { var sb = doc.selection.bounds; out.marquee = [rnd(sb[0]),rnd(sb[1]),rnd(sb[2]),rnd(sb[3])]; } catch(e){}
try { if (doc.quickMaskMode) out.quickMask = true; } catch(e){}
return out;
} finally { app.preferences.rulerUnits = prevU; }`;

// Save for Web marks the document as changed (seen on Photoshop 2026 in the live test),
// and Photoshop's saved flag can't be set back. So a document with no unsaved changes is
// exported from a flattened duplicate, closed straight after, and stays as it was; one that
// already has changes is exported directly (nothing more can change for it).
function saveForWeb(out: string): string {
  return `var __kpWas = false; try { __kpWas = doc.saved === true; } catch(e){}
var __kpT = doc;
if (__kpWas) __kpT = doc.duplicate('Komposit preview', true);
try { __kpT.exportDocument(new File(${q(out)}), ExportType.SAVEFORWEB, o); }
finally { if (__kpT !== doc) { try { __kpT.close(SaveOptions.DONOTSAVECHANGES); } catch(e){} try { app.activeDocument = doc; } catch(e){} } }`;
}

// A PNG of the flattened canvas via Save for Web.
export function render(out: string): string {
  return `
if (!doc) throw new Error('No open document to render.');
var o = new ExportOptionsSaveForWeb();
o.format = SaveDocumentType.PNG; o.PNG8 = false; o.transparency = true;
${saveForWeb(out)}
return 'ok';`;
}

export function exportImage(format: "png" | "jpg", out: string): string {
  const opt = format === "jpg" ? `o.format = SaveDocumentType.JPEG; o.quality = 85;` : `o.format = SaveDocumentType.PNG; o.PNG8 = false;`;
  return `
if (!doc) throw new Error('No open document to export.');
var o = new ExportOptionsSaveForWeb(); ${opt}
${saveForWeb(out)}
return 'ok';`;
}

// Save the document over its own file (Cmd+S / Ctrl+S).
export const SAVE_OVERWRITE = `
if (!doc) throw new Error('No open document to save.');
var p = null;
try { p = doc.fullName.fsName; } catch(e) { return { neverSaved:true, name:doc.name }; }
doc.save();
return { path: p, name: doc.name };`;

// "as": the open document becomes the new file. "copy": saveAs(asCopy = true), which
// leaves the open document as it is.
export function saveLayered(out: string, asCopy: boolean): string {
  return `
if (!doc) throw new Error('No open document to save.');
var o = new PhotoshopSaveOptions();
o.layers = true; o.embedColorProfile = true; o.maximizeCompatibility = true;
doc.saveAs(new File(${q(out)}), o, ${asCopy ? "true" : "false"}, Extension.LOWERCASE);
${asCopy ? `return { written: (new File(${q(out)})).exists };` : `return { path: doc.fullName.fsName, name: doc.name };`}`;
}

// Step back through Komposit's own history states (each edit is one, named "Komposit: ..."),
// from the one the document is at, never past the first. A state that isn't Komposit's (the
// person's brush stroke, say) stops it before anything changes: Komposit only takes back its
// own steps.
export function undo(steps: number): string {
  return `if (!doc) throw new Error('No document is open in Photoshop.');
var hs = doc.historyStates, cur = doc.activeHistoryState, at = -1, i;
for (i = hs.length - 1; i >= 0; i--) { if (hs[i] == cur) { at = i; break; } }
if (at < 0) { for (i = hs.length - 1; i >= 0; i--) { if (cur && hs[i].name === cur.name) { at = i; break; } } }
if (at < 0) at = hs.length - 1;
var n = Math.min(${steps}, at);
for (i = 0; i < n; i++) {
  var nm = String(hs[at - i].name);
  if (nm.indexOf(${q(UNDO_LABEL)}) !== 0) throw new Error(${q(UNDO_REFUSED)} + 'The latest step in ' + doc.name + "'s history is " + nm + ", not one of Komposit's, so nothing was undone: Komposit only takes back its own changes.");
}
if (n > 0) doc.activeHistoryState = hs[at - n];
return n;`;
}

/** Starts the message of undo's refusal (the latest history state is the person's). */
export const UNDO_REFUSED = "[komposit-not-ours] ";

// Create a new blank RGB document; it stays in front (the person asked for it).
export function newDocument(width: number, height: number, name: string): string {
  return `var pu = app.preferences.rulerUnits; app.preferences.rulerUnits = Units.PIXELS;
try { var d = app.documents.add(${Number(width)}, ${Number(height)}, 72, ${q(name)}, NewDocumentMode.RGB, DocumentFill.WHITE); }
finally { app.preferences.rulerUnits = pu; }
__prev = null;
return { name: d.name, id: __kpId(d) };`;
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
  if (p === f.fsName) { app.activeDocument = app.documents[i]; return { opened: app.documents[i].name, path: p, id: __kpId(app.documents[i]), already: true }; }
}
var d = app.open(f); return { opened: d.name, path: f.fsName, id: __kpId(d), already: false };`;
}

// Bring a file into the document as a smart object (Place Embedded unless linked).
export function place(path: string, linked: boolean): string {
  return `
if (!doc) throw new Error("No document is open in Photoshop to place into.");
var f = new File(${q(path)});
if (!f.exists) throw new Error("No file at " + f.fsName);
var desc = new ActionDescriptor();
desc.putPath(charIDToTypeID("null"), f);
${linked ? 'desc.putBoolean(charIDToTypeID("Lnkd"), true);' : ""}
desc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
var off = new ActionDescriptor();
off.putUnitDouble(charIDToTypeID("Hrzn"), charIDToTypeID("#Pxl"), 0);
off.putUnitDouble(charIDToTypeID("Vrtc"), charIDToTypeID("#Pxl"), 0);
desc.putObject(charIDToTypeID("Ofst"), charIDToTypeID("Ofst"), off);
executeAction(charIDToTypeID("Plc "), desc, DialogModes.NO);
var L = doc.activeLayer;
return { placed: f.name, into: doc.name, layer: L.name, linked: ${linked}, smartObject: L.kind == LayerKind.SMARTOBJECT };`;
}
