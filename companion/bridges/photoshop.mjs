// Adobe Photoshop bridge. Same transport as Illustrator (the script's value
// comes back): `do javascript` by bundle id on a Mac (version-independent),
// COM DoJavaScript on Windows.
import { join } from "node:path";
import { runViaStdout, activate as osActivate, scratchDir, readPng } from "./extendscript.mjs";
import { env } from "../env.mjs";
import { newOutputPath } from "./files.mjs";

const APP = "photoshop";

export const label = "Photoshop";
export const capabilities = { inspect: true, edit: true, render: true, export: ["png", "jpg"], save: ["copy", "overwrite"], selection: true };

export async function activate() {
  await osActivate(APP);
  return { ok: true };
}

// Create a new blank RGB document. Returns the new doc's name.
export async function newDocument({ width = 1080, height = 1080, name = "Untitled" } = {}) {
  await osActivate(APP);
  const res = await runViaStdout(
    APP,
    `app.displayDialogs = DialogModes.NO;
     var pu = app.preferences.rulerUnits; app.preferences.rulerUnits = Units.PIXELS;
     var d = app.documents.add(${Number(width)}, ${Number(height)}, 72, ${JSON.stringify(name)}, NewDocumentMode.RGB, DocumentFill.WHITE);
     app.preferences.rulerUnits = pu;
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
  try { p = d.fullName.fsName; } catch(e){ p = null; }
  docs.push({ name:d.name, path:p, active:d.name===activeName });
}
return { documents: docs };`,
  );
  if (!res.ok) throw new Error(res.error);
  return res.data.documents;
}

export async function inspect() {
  const res = await runViaStdout(
    APP,
    `
if (app.documents.length === 0) return { noDocument:true };
var prevU = app.preferences.rulerUnits; app.preferences.rulerUnits = Units.PIXELS;
var doc = app.activeDocument;
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
var data = { name:doc.name, width:rnd(doc.width), height:rnd(doc.height), resolution:rnd(doc.resolution), layers: walk(doc.layers, '') };
app.preferences.rulerUnits = prevU;
return data;`,
  );
  if (!res.ok) throw new Error(res.error);
  if (res.data.noDocument) return { text: "No document open in Photoshop.", image: null };
  return { text: JSON.stringify(res.data, null, 2), image: await render().then((r) => r.image).catch(() => null) };
}

// What the person has selected right now (fast, read-only): the selected
// layers (several at once, via the layer IDs Photoshop targets), what kind each
// is (text, smart object, group, adjustment, Background), whether it sits in a
// group, is clipped or has a mask, and any active marquee selection.
export async function selection() {
  const res = await runViaStdout(
    APP,
    `
if (app.documents.length === 0) return { noDocument:true };
var prevU = app.preferences.rulerUnits; app.preferences.rulerUnits = Units.PIXELS;
try {
var doc = app.activeDocument, out = { doc: doc.name, width: Number(doc.width), height: Number(doc.height) };
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
} finally { app.preferences.rulerUnits = prevU; }`,
    { timeoutMs: 8000 },
  );
  if (!res.ok) throw new Error(res.error);
  return { data: res.data, summary: summarizeSelection(res.data) };
}

export function summarizeSelection(d) {
  if (!d || d.noDocument) return "No document open in Photoshop.";
  const head = `Document "${d.doc}" (${Math.round(d.width)}×${Math.round(d.height)}px).`;
  const lines = (d.layers || []).map((l) => {
    const kind = { TEXT: "text layer", SMARTOBJECT: "smart object", NORMAL: "pixel layer", SOLIDFILL: "fill layer" }[l.kind] || (l.type === "group" ? "group" : (l.kind || "layer").toLowerCase().replace(/_/g, " ") + " layer");
    const bits = [`${kind} "${l.name}"`];
    if (l.text) bits.push(`text "${l.text.replace(/\s+/g, " ").slice(0, 60)}" ${l.font || ""} ${l.size || ""}px`.trim());
    if (l.children != null) bits.push(`${l.children} layers inside`);
    if (l.background) bits.push("the locked Background layer");
    else if (l.locked) bits.push("locked");
    if (!l.visible) bits.push("hidden");
    if (l.inGroup) bits.push(`in group "${l.inGroup}"`);
    if (l.clipped) bits.push("clipped to the layer below");
    if (l.mask) bits.push("has a layer mask");
    if (l.opacity != null && l.opacity !== 100) bits.push(`${l.opacity}% opacity`);
    if (l.bounds && l.bounds.every((v) => v === 0) && l.type !== "group") bits.push("empty (no pixels yet)");
    else if (l.bounds) bits.push(`bounds [${l.bounds.join(", ")}]px`);
    return `- ${bits.join(", ")}. ref: ${l.ref}`;
  });
  const sel = d.count ? `${d.count} layer${d.count === 1 ? "" : "s"} selected:\n${lines.join("\n")}` : "No layer selected.";
  const marquee = d.marquee
    ? `\nAn active marquee selection covers [${d.marquee.join(", ")}]px: pixel edits and fills should stay inside it unless asked otherwise.`
    : "";
  const qm = d.quickMask ? "\nQuick Mask mode is on." : "";
  return `${head} ${sel}${marquee}${qm}`;
}

export async function edit(code) {
  const res = await runViaStdout(APP, code, { timeoutMs: 180000 });
  return { ok: res.ok, result: res.data, error: res.error, logs: res.logs || [] };
}

// Render a specific OPEN document by name (preview of a non-active doc). Activates
// it, exports via Save-for-Web, then restores the previously active document.
export async function renderNamed(name) {
  const out = join(scratchDir(), `ps_rn_${Date.now()}.png`);
  const res = await runViaStdout(
    APP,
    `if (app.documents.length === 0) throw new Error('No open document.');
var prev = app.activeDocument;
var target = null;
for (var i=0;i<app.documents.length;i++){ if (app.documents[i].name === ${JSON.stringify(name)}){ target = app.documents[i]; break; } }
if (!target) throw new Error('Not open: ' + ${JSON.stringify(name)});
app.activeDocument = target;
var o = new ExportOptionsSaveForWeb(); o.format = SaveDocumentType.PNG; o.PNG8 = false; o.transparency = true;
target.exportDocument(new File(${JSON.stringify(out)}), ExportType.SAVEFORWEB, o);
try { app.activeDocument = prev; } catch(e){}
return 'ok';`,
  );
  if (!res.ok) throw new Error(res.error);
  return { image: { media_type: "image/png", data: readPng(out).toString("base64") }, note: "canvas" };
}

// Non-destructive PNG via Save-for-Web export (does not alter the open doc).
export async function render() {
  const out = join(scratchDir(), `ps_render_${Date.now()}.png`);
  const res = await runViaStdout(
    APP,
    `
if (app.documents.length === 0) throw new Error('No open document to render.');
var o = new ExportOptionsSaveForWeb();
o.format = SaveDocumentType.PNG; o.PNG8 = false; o.transparency = true;
app.activeDocument.exportDocument(new File(${JSON.stringify(out)}), ExportType.SAVEFORWEB, o);
return 'ok';`,
  );
  if (!res.ok) throw new Error(res.error);
  return { image: { media_type: "image/png", data: readPng(out).toString("base64") }, note: "flattened canvas" };
}

export async function exportCopy({ format = "png", name, outputDir } = {}) {
  const f = String(format || "png").toLowerCase().replace("jpeg", "jpg");
  if (!capabilities.export.includes(f)) throw new Error(`Photoshop export supports png and jpg; not "${format}".`);
  const out = newOutputPath({ outputDir, name: name || (await activeDocName()), ext: f });
  const opt = f === "jpg" ? `o.format = SaveDocumentType.JPEG; o.quality = 85;` : `o.format = SaveDocumentType.PNG; o.PNG8 = false;`;
  const res = await runViaStdout(
    APP,
    `
if (app.documents.length===0) throw new Error('No open document to export.');
var o = new ExportOptionsSaveForWeb(); ${opt}
app.activeDocument.exportDocument(new File(${JSON.stringify(out)}), ExportType.SAVEFORWEB, o);
return 'ok';`,
  );
  if (!res.ok) throw new Error(res.error);
  const what = f === "jpg" ? "JPG, flattened, for screens" : "PNG, flattened, for screens";
  return { path: out, format: f, note: `${what}. Not a print file.`, warnings: [], documentUnchanged: true };
}

// Save: "overwrite" saves the file itself (Cmd+S / Ctrl+S); "copy" writes a .psd with
// saveAs(asCopy = true), which leaves the open document as it is.
export async function saveDocument({ mode = "copy", name, outputDir } = {}) {
  if (mode === "overwrite") {
    const res = await runViaStdout(
      APP,
      `
if (app.documents.length===0) throw new Error('No open document to save.');
var d = app.activeDocument, p = null;
try { p = d.fullName.fsName; } catch(e) { return { neverSaved:true, name:d.name }; }
d.save();
return { path: p, name: d.name };`,
      { timeoutMs: 300000 },
    );
    if (!res.ok) throw new Error(res.error);
    if (res.data.neverSaved) throw new Error(`"${res.data.name}" has never been saved, so there is no original to overwrite. Save a copy instead.`);
    return { path: res.data.path, mode: "overwrite", note: `Saved "${res.data.name}" over the original file.`, warnings: [] };
  }
  const base = (await activeDocName()) + " copy";
  const out = newOutputPath({ outputDir, name: name || base, ext: "psd" });
  const res = await runViaStdout(
    APP,
    `
if (app.documents.length===0) throw new Error('No open document to save.');
app.displayDialogs = DialogModes.NO;
var d = app.activeDocument, o = new PhotoshopSaveOptions();
o.layers = true; o.embedColorProfile = true; o.maximizeCompatibility = true;
d.saveAs(new File(${JSON.stringify(out)}), o, true, Extension.LOWERCASE);
return { written: (new File(${JSON.stringify(out)})).exists };`,
    { timeoutMs: 300000 },
  );
  if (!res.ok) throw new Error(res.error);
  if (!res.data.written) throw new Error("Photoshop reported no error but wrote no file.");
  return { path: out, mode: "copy", note: "Saved a layered .psd copy. The open document is unchanged.", warnings: [], documentUnchanged: true };
}

async function activeDocName() {
  const res = await runViaStdout(APP, `if (app.documents.length===0) throw new Error('No open document.'); return app.activeDocument.name;`);
  if (!res.ok) throw new Error(res.error);
  return String(res.data || "document").replace(/\.[a-z0-9]{2,4}$/i, "");
}

export async function undo() {
  const res = await runViaStdout(
    APP,
    `
var d = app.activeDocument;
if (d.historyStates.length > 1) d.activeHistoryState = d.historyStates[d.historyStates.length - 2];
return 'ok';`,
  );
  return { ok: res.ok, error: res.error };
}
