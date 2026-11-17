// After Effects' ExtendScript, ported from 1.0's bridges/aftereffects.mjs and handoff.mjs.
// Every script runs inside the guard: dialogs suppressed, and (when a DocRef names a
// saved project) a check that it is the project After Effects has open.
import type { DocRef } from "../../protocol/common.ts";
import type { Guard } from "../_kit/envelope.ts";
import { refLiteral } from "../_kit/adobe.ts";

const q = (s: unknown) => JSON.stringify(String(s));

// Quiet mode, new in v2: app.beginSuppressDialogs() before, app.endSuppressDialogs(false)
// after (false: don't show the suppressed alerts afterwards either). After Effects'
// dialogs are the #1 failure in 1.0's incident log (49 of 85): a modal alert from a
// script error blocks every later script until someone closes it.
// After Effects has one project open; a DocRef with a path must be that project.
//
// The comp: `comp` (and __kpComp) is the comp the request works in, found by its id (or its
// name) from the DocRef's part, never "whatever the person is viewing", so a person who opens
// another comp while a request works isn't edited or rendered by mistake. Without a part, the
// comp in the viewer (activeItem), as before. A part that's gone is said plainly; nothing else
// is used instead.
//
// A comp a script makes and leaves on its own (not a layer in another comp) is reported back
// (facts.made, the newest, or the one the script opened itself), so the request can go on in
// it. It isn't opened in the person's viewer: that's theirs (live test, Nov 16, found render
// showing the old comp; the request's part now does what opening it did).
//
// With a label (edits), the whole step is one undo group with that name ("Komposit: ..."), so
// the person's Undo takes it back in one go and sees whose step it was. Groups nest: an edit's
// own beginUndoGroup goes inside Komposit's.
export function guard(doc?: DocRef, label?: string): Guard {
  return {
    before: `app.beginSuppressDialogs(); var __kpUG = false;
var __kpName = function(p){ return (p && p.file) ? decodeURI(p.file.name) : 'Untitled Project'; };
var __kpPath = function(p){ return (p && p.file) ? p.file.fsName : null; };
var __kpCompOf = function(part){
  if (!part) return null;
  var p = app.project, hit = null, n = 0;
  for (var i = 1; i <= p.numItems; i++){ var it = p.item(i); if (!(it instanceof CompItem)) continue; if (part.id ? String(it.id) === String(part.id) : it.name === part.name){ if (part.id) return it; hit = it; n++; } }
  if (n > 1) throw new Error("Two comps in the project are called " + part.name + ", so Komposit can't tell which to use. Nothing ran.");
  if (hit) return hit;
  throw new Error("The comp " + part.name + " isn't in the project anymore.");
};
var __kpHad = {}; try { for (var __kpI = 1; __kpI <= app.project.numItems; __kpI++){ var __kpIt = app.project.item(__kpI); if (__kpIt instanceof CompItem) __kpHad[__kpIt.id] = true; } } catch(e){}`,
    setup:
      `var __kpRef = ${refLiteral(doc)};` +
      (doc?.path ? ` if (__kpPath(app.project) !== __kpRef.path) throw new Error(__kpRef.name + " isn't open in After Effects anymore: the project open there is " + __kpName(app.project) + ".");` : "") +
      ` var __kpComp = __kpCompOf(__kpRef && __kpRef.part); if (!__kpComp) { var __kpA = app.project ? app.project.activeItem : null; __kpComp = (__kpA && __kpA instanceof CompItem) ? __kpA : null; } var comp = __kpComp;` +
      (label ? ` app.beginUndoGroup(${q(label)}); __kpUG = true;` : ""),
    after: `try { var __kpNew = null, __kpAct = app.project.activeItem;
for (var __kpJ = 1; __kpJ <= app.project.numItems; __kpJ++){ var __kpC = app.project.item(__kpJ); if (__kpC instanceof CompItem && !__kpHad[__kpC.id] && __kpC.usedIn.length === 0 && (!__kpNew || __kpC.id > __kpNew.id)) __kpNew = __kpC; }
if (__kpAct instanceof CompItem && !__kpHad[__kpAct.id]) __kpNew = __kpAct;
if (__kpNew) __kpFacts.made = { id: String(__kpNew.id), name: __kpNew.name }; } catch(e){}
if (__kpUG) { try { app.endUndoGroup(); } catch(e){} }
try { app.endSuppressDialogs(false); } catch(e){}`,
  };
}

// The project, its comps, and the comp being viewed (activeItem; the only comp when the
// Project panel has focus and there's just one) as its part.
export const DOCUMENTS = `
var p = app.project;
var comps = [], only = null, n = 0, part = null;
if (p){ for (var i=1;i<=p.numItems;i++){ var it=p.item(i); if (it instanceof CompItem) { comps.push(it.name); only = it; n++; } } }
var a = p ? p.activeItem : null;
if (a && a instanceof CompItem) part = { id: String(a.id), name: a.name };
else if (n === 1) part = { id: String(only.id), name: only.name };
return { documents: p ? [{ name:__kpName(p), path:__kpPath(p), active:true, comps:comps, part:part }] : [] };`;

export const INSPECT = `
var p = app.project;
if (!p) return { noDocument:true };
function rnd(n){ return Math.round(Number(n)*100)/100; }
var comp = __kpComp;
if (!comp){ for (var j=1;j<=p.numItems;j++){ if (p.item(j) instanceof CompItem){ comp = p.item(j); break; } } }
var items = [];
for (var i=1;i<=p.numItems;i++){ var it=p.item(i); items.push({ id:it.id, name:it.name, type:it.typeName || String(it.typename) }); }
var data = { appVersion: String(app.version), project: __kpName(p), items: items };
if (comp){
  var layers = [];
  for (var k=1;k<=comp.numLayers;k++){
    var L = comp.layer(k);
    layers.push({ ref:'comp.layer('+k+')', index:k, name:L.name, enabled:L.enabled,
      inPoint:rnd(L.inPoint), outPoint:rnd(L.outPoint), type:String(L.matchName||'') });
  }
  data.comp = { id:comp.id, name:comp.name, w:comp.width, h:comp.height, duration:rnd(comp.duration),
    frameRate:rnd(comp.frameRate), time:rnd(comp.time), numLayers:comp.numLayers, layers:layers };
}
return data;`;

// What the person has selected right now (read-only): in the request's comp, its playhead and
// work area, the selected layers (type, timing, parent, text), and the selected properties
// with their keyframes, each with a ref usable in a run. Without an active comp, what's
// selected in the Project panel.
export const SELECTION = `
var p = app.project;
if (!p) return { noDocument:true };
function rnd(n){ return Math.round(Number(n)*100)/100; }
var out = { project: __kpName(p) };
var comp = __kpComp;
if (!comp){
  out.kind = 'project'; out.items = [];
  for (var i=0;i<p.selection.length && i<20;i++){ var it=p.selection[i]; out.items.push({ name:it.name, type:it.typeName }); }
  return out;
}
out.kind = 'comp';
out.comp = { name:comp.name, w:comp.width, h:comp.height, duration:rnd(comp.duration), fps:rnd(comp.frameRate), time:rnd(comp.time),
  workArea:[rnd(comp.workAreaStart), rnd(comp.workAreaStart+comp.workAreaDuration)] };
function layerType(L){
  try { if (L instanceof TextLayer) return 'text'; } catch(e){}
  try { if (L instanceof ShapeLayer) return 'shape'; } catch(e){}
  try { if (L instanceof CameraLayer) return 'camera'; } catch(e){}
  try { if (L instanceof LightLayer) return 'light'; } catch(e){}
  try { if (L.nullLayer) return 'null'; } catch(e){}
  try { if (L.adjustmentLayer) return 'adjustment'; } catch(e){}
  try { if (L.source instanceof CompItem) return 'precomp'; } catch(e){}
  try { if (L.source && L.source.mainSource instanceof SolidSource) return 'solid'; } catch(e){}
  return 'footage';
}
var sl = comp.selectedLayers; out.layers = [];
for (var k=0;k<sl.length && k<25;k++){
  var L = sl[k], rec = { ref:'comp.layer('+L.index+')', index:L.index, name:L.name, type:layerType(L), inPoint:rnd(L.inPoint), outPoint:rnd(L.outPoint) };
  try { if (L.parent) rec.parent = L.parent.name; } catch(e){}
  try { if (L.locked) rec.locked = true; } catch(e){}
  try { if (!L.enabled) rec.hidden = true; } catch(e){}
  try { if (L.threeDLayer) rec.threeD = true; } catch(e){}
  if (rec.type === 'text'){ try { rec.text = String(L.property('Source Text').value.text).substr(0,120); } catch(e){} }
  if (rec.type === 'precomp'){ try { rec.source = L.source.name; } catch(e){} }
  out.layers.push(rec);
}
var sp = comp.selectedProperties; out.props = [];
for (var q=0;q<sp.length && out.props.length<20;q++){
  var pr = sp[q];
  if (pr.propertyType !== PropertyType.PROPERTY) continue;
  var lay = pr.propertyGroup(pr.propertyDepth), names = [], ref = 'comp.layer('+lay.index+')';
  for (var dd=pr.propertyDepth-1; dd>=1; dd--){ var g = pr.propertyGroup(dd); names.push(g.name); ref += '.property(' + '"' + g.matchName + '"' + ')'; }
  names.push(pr.name); ref += '.property(' + '"' + pr.matchName + '"' + ')';
  var rec2 = { layer:lay.name, path:names.join(' > '), ref:ref, keys:pr.numKeys };
  try { var sk = pr.selectedKeys; rec2.selectedKeys = sk.length; var ts=[]; for (var s=0;s<sk.length && s<8;s++) ts.push(rnd(pr.keyTime(sk[s]))); rec2.selectedKeyTimes = ts; } catch(e){}
  try { if (pr.expressionEnabled && pr.expression) rec2.expression = String(pr.expression).substr(0,120); } catch(e){}
  try { if (pr.numKeys === 0) { var v = pr.value; rec2.value = (v instanceof Array) ? v.join(', ') : String(v); } } catch(e){}
  out.props.push(rec2);
}
return out;`;

// ExtendScript helpers shared by render and export.
const AE_TOOLS = `
function __comp(){
  var p = app.project;
  var comp = __kpComp;
  if (!comp){ for (var j=1;j<=p.numItems;j++){ if (p.item(j) instanceof CompItem){ comp = p.item(j); break; } } }
  if (!comp) throw new Error('No comp to render.');
  return comp;
}
// After Effects 2023 and later: saveFrameToPng makes an empty file at once and hands back a
// task; wait() draws the frame there and then (about 50 ms on After Effects 2026). Without it
// the frame is drawn only after the script ends, so watching the file waited out its limit
// (about 26 s a frame; live test, Nov 16). Older versions write the file in the background:
// wait for it to appear and stop growing.
function __frame(comp, t, path){
  var f = new File(path); if (f.exists) f.remove();
  var task = comp.saveFrameToPng(Math.min(Math.max(0, t), Math.max(0, comp.duration - comp.frameDuration)), f);
  if (task && task.wait){ task.wait(); if (!f.exists || f.length <= 0) throw new Error('Frame render produced no picture.'); return; }
  var tries = 0; while (!f.exists && tries < 200){ $.sleep(100); tries++; }
  if (!f.exists) throw new Error('Frame render produced no file.');
  var last = -1, stable = 0; while (stable < 2 && tries < 260){ var sz = f.length; if (sz === last && sz > 0) stable++; else stable = 0; last = sz; $.sleep(100); tries++; }
}
// Render the comp's work area to an H.264 .mp4 through the render queue. The
// queue renders everything queued, so the person's own queued items are paused
// and restored, and Komposit's temporary item is removed afterwards.
function __mp4(comp, path, half, maxSec){
  var rq = app.project.renderQueue, paused = [], item = null;
  for (var i=1;i<=rq.numItems;i++){ var it = rq.item(i); if (it.status === RQItemStatus.QUEUED){ it.render = false; paused.push(it); } }
  try {
    item = rq.items.add(comp);
    var dur = comp.workAreaDuration; if (maxSec && dur > maxSec) dur = maxSec;
    item.timeSpanStart = comp.workAreaStart; item.timeSpanDuration = dur;
    if (half){ try { item.setSettings({ 'Resolution': [2, 2] }); } catch(e){} }
    var om = item.outputModule(1), tpl = null, ts = om.templates;
    for (var t=0;t<ts.length;t++){ if (/H\\.264/i.test(ts[t])){ if (!tpl || /Match Render Settings/i.test(ts[t])) tpl = ts[t]; } }
    if (tpl) om.applyTemplate(tpl);
    else { try { om.setSettings({ 'Format': 'H.264' }); } catch(e){ throw new Error('This After Effects has no H.264 output module.'); } }
    om.file = new File(path);
    rq.render();
  } finally {
    try { if (item) item.remove(); } catch(e){}
    for (var k=0;k<paused.length;k++){ try { paused[k].render = true; } catch(e){} }
  }
  var out = new File(path);
  if (!out.exists) throw new Error('The render queue produced no video.');
  return { seconds: Math.round(dur*100)/100, start: Math.round(comp.workAreaStart*100)/100 };
}
`;

// Render so the agent can SEE the result, and optionally so the person can WATCH it:
//   default        the current frame (one PNG);
//   frames: N      N frames spread across the work area (2-8), for checking motion;
//   video: true    also a short half-resolution MP4 of the work area (max 10 s).
export function render(paths: string[], videoPath: string | null): string {
  return `${AE_TOOLS}
var comp = __comp(), paths = ${JSON.stringify(paths)}, times = [];
if (paths.length === 1){ times.push(comp.time); }
else {
  var a = comp.workAreaStart, d = comp.workAreaDuration - comp.frameDuration;
  for (var i=0;i<paths.length;i++) times.push(a + d * i / (paths.length - 1));
}
for (var j=0;j<paths.length;j++) __frame(comp, times[j], paths[j]);
var v = ${videoPath ? `__mp4(comp, ${q(videoPath)}, true, 10)` : "null"};
var tr = []; for (var k=0;k<times.length;k++) tr.push(Math.round(times[k]*100)/100);
return { comp: comp.name, times: tr, video: v };`;
}

export function exportCopy(format: "png" | "mp4", out: string): string {
  return `${AE_TOOLS}
var comp = __comp();
${
  format === "mp4"
    ? `var v = __mp4(comp, ${q(out)}, false, 0); return { comp: comp.name, seconds: v.seconds, start: v.start, w: comp.width, h: comp.height };`
    : `__frame(comp, comp.time, ${q(out)}); return { comp: comp.name, time: Math.round(comp.time*100)/100 };`
}`;
}

// Save the project file (Cmd+S / Ctrl+S). After Effects has no scriptable "save a copy"
// that leaves the project where it is.
export const SAVE_OVERWRITE = `
var f = app.project.file;
if (!f) return { neverSaved: true };
app.project.save();
return { path: f.fsName, name: decodeURI(f.name) };`;

// Edit > Undo is command 16. findMenuCommandId('Undo') found another menu's item on After
// Effects 2026 (2371), which ran without error and undid nothing (live test, Nov 16).
export function undo(steps: number): string {
  return `var n = 0;
for (var i=0;i<${steps};i++){ try { app.executeCommand(16); n++; } catch(e){ if (!n) throw new Error('Undo failed: '+e); break; } }
return n;`;
}

// Create a new comp (After Effects' equivalent of a new document).
export function newComp(name: string, width: number, height: number, duration: number, fps: number): string {
  return `app.beginUndoGroup('New comp');
try {
  var c = app.project.items.addComp(${q(name)}, ${Number(width)}, ${Number(height)}, 1, ${Number(duration)}, ${Number(fps)});
  c.openInViewer();
} finally { app.endUndoGroup(); }
return { comp: c.name, name: __kpName(app.project), path: __kpPath(app.project) };`;
}

// Import a file into the project, then add it to the request's comp, if any. A layered
// Photoshop or Illustrator file comes in as a composition (not opened in the viewer).
export function place(path: string, { asComp = true, addToComp = true }: { asComp?: boolean; addToComp?: boolean } = {}): string {
  return `
var f = new File(${q(path)});
if (!f.exists) throw new Error("No file at " + f.fsName);
var io = new ImportOptions(f);
var ext = String(f.name.split(".").pop()).toLowerCase();
var layered = ext === "psd" || ext === "ai" || ext === "eps" || ext === "pdf";
if (${asComp !== false} && layered && io.canImportAs(ImportAsType.COMP_CROPPED_LAYERS)) io.importAs = ImportAsType.COMP_CROPPED_LAYERS;
else if (${asComp !== false} && layered && io.canImportAs(ImportAsType.COMP)) io.importAs = ImportAsType.COMP;
else if (io.canImportAs(ImportAsType.FOOTAGE)) io.importAs = ImportAsType.FOOTAGE;
var target = __kpComp;
app.beginUndoGroup("Komposit: bring in " + f.name);
try {
  var item = app.project.importFile(io);
  var layerName = null;
  if (${addToComp !== false} && target && (target instanceof CompItem) && target !== item) { layerName = target.layers.add(item).name; }
  return { placed: decodeURI(f.name), item: item.name, kind: (item instanceof CompItem) ? "composition" : "footage", addedTo: layerName ? target.name : null, layer: layerName, project: __kpName(app.project) };
} finally { app.endUndoGroup(); }`;
}
