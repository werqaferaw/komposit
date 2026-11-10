// Adobe After Effects bridge. After Effects has NO return channel for scripts
// (AppleScript `DoScript` on a Mac, `AfterFX.exe -r` on Windows) — so every call
// WRITES its JSON result to a temp file that the shared transport reads back
// (runViaFile). Render takes frames and an MP4 preview through the queue.
//
// On a Mac, scripts go to the After Effects that's open, whatever its year
// (platform/mac.mjs: aeTarget); AE_APP overrides the app name.
import { join } from "node:path";
import { runViaFile, activate as osActivate, scratchDir, readPng } from "./extendscript.mjs";
import { env } from "../env.mjs";
import { newOutputPath } from "./files.mjs";

const APP = "aftereffects";

export const label = "After Effects";
export const capabilities = { inspect: true, edit: true, render: true, export: ["png", "mp4"], save: ["overwrite"], selection: true, motion: true };

export async function activate() {
  await osActivate(APP);
  return { ok: true };
}

// Create a new comp (AE's equivalent of a new document). Returns its name.
export async function newDocument({ width = 1920, height = 1080, name = "Komposit Comp", duration = 10, fps = 30 } = {}) {
  await osActivate(APP);
  const res = await runViaFile(
    APP,
    `app.beginUndoGroup('New comp');
     var c = app.project.items.addComp(${JSON.stringify(name)}, ${Number(width)}, ${Number(height)}, 1, ${Number(duration)}, ${Number(fps)});
     c.openInViewer();
     app.endUndoGroup();
     return { name: c.name };`,
  );
  if (!res.ok) throw new Error(res.error);
  return { ok: true, name: res.data.name };
}

export async function listDocuments() {
  const res = await runViaFile(
    APP,
    `
var p = app.project, name = (p && p.file) ? p.file.name : (p ? 'Untitled Project' : null);
var comps = [];
if (p){ for (var i=1;i<=p.numItems;i++){ var it=p.item(i); if (it instanceof CompItem) comps.push(it.name); } }
return { documents: name ? [{ name:name, path:(p.file?p.file.fsName:null), active:true, comps:comps }] : [] };`,
  );
  if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
  return res.data.documents;
}

export async function inspect() {
  const res = await runViaFile(
    APP,
    `
var p = app.project;
if (!p) return { noDocument:true };
function rnd(n){ return Math.round(Number(n)*100)/100; }
var comp = (p.activeItem && p.activeItem instanceof CompItem) ? p.activeItem : null;
if (!comp){ for (var j=1;j<=p.numItems;j++){ if (p.item(j) instanceof CompItem){ comp = p.item(j); break; } } }
var items = [];
for (var i=1;i<=p.numItems;i++){ var it=p.item(i); items.push({ id:it.id, name:it.name, type:it.typeName || String(it.typename) }); }
var data = { project: p.file ? p.file.name : 'Untitled Project', items: items };
if (comp){
  var layers = [];
  for (var k=1;k<=comp.numLayers;k++){
    var L = comp.layer(k);
    layers.push({ ref:'comp.layer('+k+')', index:k, name:L.name, enabled:L.enabled,
      inPoint:rnd(L.inPoint), outPoint:rnd(L.outPoint), type:String(L.matchName||'') });
  }
  data.activeComp = { name:comp.name, w:comp.width, h:comp.height, duration:rnd(comp.duration),
    frameRate:rnd(comp.frameRate), time:rnd(comp.time), numLayers:comp.numLayers, layers:layers };
}
return data;`,
  );
  if (!res.ok) throw new Error(res.error);
  if (res.data.noDocument) return { text: "No project open in After Effects.", image: null };
  return { text: JSON.stringify(res.data, null, 2), image: await render().then((r) => r.image).catch(() => null) };
}

// What the person has selected right now (read-only): the active comp and its
// playhead and work area, the selected layers (type, timing, parent, text),
// and the selected properties with their keyframes, each with a ref usable in
// an edit. Without an active comp, what's selected in the Project panel.
export async function selection() {
  const res = await runViaFile(
    APP,
    `
var p = app.project;
if (!p) return { noDocument:true };
function rnd(n){ return Math.round(Number(n)*100)/100; }
var out = { project: p.file ? decodeURI(p.file.name) : 'Untitled Project' };
var comp = (p.activeItem && p.activeItem instanceof CompItem) ? p.activeItem : null;
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
return out;`,
    { timeoutMs: 8000 },
  );
  if (!res.ok) throw new Error(res.error);
  return { data: res.data, summary: summarizeSelection(res.data) };
}

export function summarizeSelection(d) {
  if (!d || d.noDocument) return "No project open in After Effects.";
  if (d.kind === "project") {
    const items = d.items.length ? d.items.map((i) => `${i.type} "${i.name}"`).join(", ") : "nothing";
    return `Project "${d.project}". No comp is active (the timeline isn't focused). Selected in the Project panel: ${items}.`;
  }
  const c = d.comp;
  const head = `Comp "${c.name}" ${c.w}×${c.h}, ${c.duration}s at ${c.fps}fps; playhead at ${c.time}s; work area ${c.workArea[0]}–${c.workArea[1]}s.`;
  const layers = d.layers.length
    ? `${d.layers.length} layer${d.layers.length === 1 ? "" : "s"} selected:\n` +
      d.layers
        .map((l) => {
          const bits = [`${l.type} layer "${l.name}" (#${l.index})`, `${l.inPoint}–${l.outPoint}s`];
          if (l.text) bits.push(`text "${l.text.replace(/\s+/g, " ").slice(0, 60)}"`);
          if (l.source) bits.push(`precomp of "${l.source}"`);
          if (l.parent) bits.push(`parented to "${l.parent}"`);
          if (l.threeD) bits.push("3D");
          if (l.locked) bits.push("locked");
          if (l.hidden) bits.push("hidden");
          return `- ${bits.join(", ")}. ref: ${l.ref}`;
        })
        .join("\n")
    : "No layers selected.";
  const props = d.props.length
    ? "\nSelected properties:\n" +
      d.props
        .map((p) => {
          const bits = [`"${p.layer}" > ${p.path}`];
          if (p.keys) bits.push(`${p.keys} keyframe${p.keys === 1 ? "" : "s"}${p.selectedKeys ? `, ${p.selectedKeys} selected at ${p.selectedKeyTimes.join("s, ")}s` : ""}`);
          else if (p.value != null) bits.push(`value ${p.value}`);
          if (p.expression) bits.push(`expression: ${p.expression}`);
          return `- ${bits.join(", ")}. ref: ${p.ref}`;
        })
        .join("\n")
    : "";
  return `${head} ${layers}${props}`;
}

export async function edit(code) {
  const res = await runViaFile(APP, code, { timeoutMs: 180000 });
  return { ok: res.ok, result: res.data, error: res.error, logs: res.logs || [] };
}

// ExtendScript helpers shared by render and export.
const AE_TOOLS = `
function __comp(){
  var p = app.project;
  var comp = (p.activeItem && p.activeItem instanceof CompItem) ? p.activeItem : null;
  if (!comp){ for (var j=1;j<=p.numItems;j++){ if (p.item(j) instanceof CompItem){ comp = p.item(j); break; } } }
  if (!comp) throw new Error('No comp to render.');
  return comp;
}
// saveFrameToPng writes in the background: wait for the file to appear and stop growing.
function __frame(comp, t, path){
  var f = new File(path); if (f.exists) f.remove();
  comp.saveFrameToPng(Math.min(Math.max(0, t), Math.max(0, comp.duration - comp.frameDuration)), f);
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

// Render so the agent can SEE the result, and optionally so the person can
// WATCH it:
//   default        the current frame (one PNG);
//   frames: N      N frames spread across the work area (2-8), for checking motion;
//   video: true    also a short half-resolution MP4 of the work area (max 10 s)
//                  that the chat plays.
export async function render({ frames = 1, video = false } = {}) {
  const n = Math.max(1, Math.min(8, Math.round(Number(frames) || 1)));
  const stamp = Date.now();
  const paths = Array.from({ length: n }, (_, i) => join(scratchDir(), `ae_render_${stamp}_${i}.png`));
  const videoPath = video ? join(scratchDir(), `ae_preview_${stamp}.mp4`) : null;
  const res = await runViaFile(
    APP,
    `${AE_TOOLS}
var comp = __comp(), paths = ${JSON.stringify(paths)}, times = [];
if (paths.length === 1){ times.push(comp.time); }
else {
  var a = comp.workAreaStart, d = comp.workAreaDuration - comp.frameDuration;
  for (var i=0;i<paths.length;i++) times.push(a + d * i / (paths.length - 1));
}
for (var j=0;j<paths.length;j++) __frame(comp, times[j], paths[j]);
var v = ${videoPath ? `__mp4(comp, ${JSON.stringify(videoPath)}, true, 10)` : "null"};
var tr = []; for (var k=0;k<times.length;k++) tr.push(Math.round(times[k]*100)/100);
return { comp: comp.name, times: tr, video: v };`,
    { timeoutMs: video ? 600000 : 180000 },
  );
  if (!res.ok) throw new Error(res.error);
  const images = paths.map((p) => ({ media_type: "image/png", data: readPng(p).toString("base64") }));
  const d = res.data;
  const note =
    n === 1
      ? "current comp frame"
      : `${n} frames of "${d.comp}" at ${d.times.join("s, ")}s`;
  return {
    image: images[Math.floor((images.length - 1) / 2)],
    images,
    note: videoPath ? `${note}; preview video of ${d.video.seconds}s from ${d.video.start}s (half resolution) is in the chat` : note,
    video: videoPath,
  };
}

// AE's "documents" are comps, not named files — just render the active comp.
export async function renderNamed() {
  return render();
}

export async function exportCopy({ format = "png", name, outputDir } = {}) {
  const f = String(format || "png").toLowerCase();
  if (!capabilities.export.includes(f)) throw new Error(`After Effects export supports png (one frame) and mp4 (the work area); not "${format}".`);
  const out = newOutputPath({ outputDir, name, ext: f, fallback: f === "mp4" ? "komposit-video" : "komposit-frame" });
  const res = await runViaFile(
    APP,
    `${AE_TOOLS}
var comp = __comp();
${f === "mp4" ? `var v = __mp4(comp, ${JSON.stringify(out)}, false, 0); return { comp: comp.name, seconds: v.seconds, start: v.start, w: comp.width, h: comp.height };`
  : `__frame(comp, comp.time, ${JSON.stringify(out)}); return { comp: comp.name, time: Math.round(comp.time*100)/100 };`}`,
    { timeoutMs: f === "mp4" ? 1800000 : 120000 },
  );
  if (!res.ok) throw new Error(res.error);
  const d = res.data || {};
  const note =
    f === "mp4"
      ? `H.264 MP4 of "${d.comp}", ${d.w}×${d.h}, the work area (${d.seconds}s from ${d.start}s). Rendered through the render queue; your own queued items were paused and put back.`
      : `PNG of one frame of "${d.comp}" at ${d.time}s. A still, not a video.`;
  return { path: out, format: f, note, warnings: [], documentUnchanged: true };
}

// Save the project file (Cmd+S / Ctrl+S). After Effects
// has no scriptable "save a copy" that leaves the project where it is.
export async function saveDocument({ mode = "overwrite" } = {}) {
  if (mode !== "overwrite") throw new Error("After Effects can't save a copy from Komposit; use File > Save a Copy.");
  const res = await runViaFile(
    APP,
    `
var f = app.project.file;
if (!f) return { neverSaved: true };
app.project.save();
return { path: f.fsName, name: f.name };`,
    { timeoutMs: 300000 },
  );
  if (!res.ok) throw new Error(res.error);
  if (res.data.neverSaved) throw new Error("This project has never been saved, so there is no file to overwrite. Use File > Save As in After Effects.");
  return { path: res.data.path, mode: "overwrite", note: `Saved the project "${decodeURIComponent(res.data.name)}".`, warnings: [] };
}

export async function undo() {
  const res = await runViaFile(
    APP,
    `try { app.executeCommand(app.findMenuCommandId('Undo')); } catch(e){ throw new Error('Undo failed: '+e); } return 'ok';`,
  );
  return { ok: res.ok, error: res.error };
}
