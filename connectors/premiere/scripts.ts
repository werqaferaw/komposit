// Premiere Pro's ExtendScript, ported from 1.0's bridges/premiere.mjs and handoff.mjs (each
// call there was checked live on Premiere Pro 26.5). The scripts are ordinary Premiere
// ExtendScript (ES3): the `app.project` DOM, plus the QE DOM for frames, effects and cuts.
//
// The document is the open project; the work happens in the request's sequence (the one open
// when it started, by its id: see guard). Premiere's
// scripts (and its QE DOM) only reach the ACTIVE project, so every call that names a project
// first checks, inside the same script, that it is the active one (guard below). A script
// sent to Premiere runs to its end without Premiere's interface in between, so that check
// can't go stale before the script's own code runs.
import type { DocRef } from "../../protocol/common.ts";
import type { Guard } from "../_kit/envelope.ts";
import { refLiteral } from "../_kit/adobe.ts";

const q = (s: unknown) => JSON.stringify(String(s));

/** Starts the message of the guard's refusals, so they come back as a plain sentence and are
 *  told apart from the script's own errors. */
export const REFUSED = "[komposit-refused] ";

// Quiet: a script's alert(), confirm() or prompt() would put a modal dialog up in Premiere and
// hold every later script until someone closes it. Inside Komposit's scripts they only log.
// (No // comments in here: the guard is joined onto one line.)
const QUIET = `
var alert = function(m){ log('Not shown (alert): ' + m); };
var confirm = function(m){ log('Not shown (confirm, answered no): ' + m); return false; };
var prompt = function(m){ log('Not shown (prompt, answered nothing): ' + m); return null; };`;

// Which open project a DocRef means: its path when it has one (Premiere's own, from
// documents), else its name (with or without .prproj).
const TARGET = `
function __kpSame(a, b){ if (!a || !b) return false; var x = String(a), y = String(b); try { x = new File(x).fsName; } catch(e){} try { y = new File(y).fsName; } catch(e){} if (x === y) return true; if (String($.os).indexOf('Windows') >= 0) return x.toLowerCase().replace(/\\//g, '\\\\') === y.toLowerCase().replace(/\\//g, '\\\\'); return false; }
function __kpBare(n){ return String(n || '').replace(/\\.prproj$/i, ''); }
function __kpIs(p, r){ if (!p) return false; if (r.path) return __kpSame(p.path, r.path); return __kpBare(p.name) === __kpBare(r.name); }
function __kpOpen(){ var o = [], a = app.project ? app.project.documentID : null; for (var i = 0; i < app.projects.numProjects; i++){ var p = app.projects[i]; o.push(p.name + (p.documentID === a ? ' (active)' : '')); } return o.length ? o.join(', ') : 'none'; }
function __kpWhy(r){ var act = app.project, open = null; for (var i = 0; i < app.projects.numProjects; i++){ if (__kpIs(app.projects[i], r)) { open = app.projects[i]; break; } } if (open) return r.name + ' is open in Premiere Pro, but the active project is ' + act.name + ', and Premiere only takes scripts in its active project, so nothing ran. Ask the person to click into ' + r.name + ' in Premiere Pro (or name ' + act.name + ' if that is the one to work in).'; return 'No open Premiere Pro project is ' + (r.path || r.name) + ' (open: ' + __kpOpen() + '), so nothing ran.'; }
var __kpSeqT = null;
function __kpSeqOf(part){ var p = app.project, hit = null, n = 0; if (!part || !p) return null; for (var i = 0; i < p.sequences.numSequences; i++){ var s = p.sequences[i]; if (part.id ? String(s.sequenceID) === String(part.id) : s.name === part.name){ if (part.id) return s; hit = s; n++; } } if (n > 1) throw new Error(${q(REFUSED)} + 'Two sequences in ' + p.name + ' are called ' + part.name + ', so Komposit cannot tell which to use. Nothing ran.'); if (hit) return hit; throw new Error(${q(REFUSED)} + 'The sequence ' + part.name + ' is not in ' + p.name + ' anymore, so nothing ran.'); }
function __kpTarget(){ return __kpSeqT || (app.project ? app.project.activeSequence : null); }
function __kpQe(){ var s = __kpTarget(), a = app.project ? app.project.activeSequence : null; app.enableQE(); if (s && (!a || String(a.sequenceID) !== String(s.sequenceID))) throw new Error(${q(REFUSED)} + 'The sequence this request works in, ' + s.name + ', is not the one open in the timeline' + (a ? ' (' + a.name + ' is)' : '') + ', and Premiere Pro draws frames and makes cuts only in the open one, so nothing ran. Ask the person to open ' + s.name + ' in Premiere Pro, or name ' + (a ? a.name : 'the open one') + ' as doc part to work there.'); return qe.project.getActiveSequence(); }`;

/**
 * Quiet mode always; with a DocRef, a refusal unless it names the ACTIVE project (an open
 * project that isn't active, one that isn't open, or a name two open projects share).
 *
 * The sequence: Komposit's scripts and K work in __kpTarget(), the DocRef's part found by its
 * sequenceID (or name), not "whatever is in the timeline now", so a person who opens another
 * sequence while a request works isn't edited by mistake. Without a part, the active sequence,
 * as before. What only works in the open sequence (QE: frames, cuts, effects by QE) goes
 * through __kpQe(), which refuses plainly when the request's sequence isn't the open one
 * instead of opening it in the person's timeline.
 */
export function guard(doc?: DocRef): Guard {
  return {
    before: QUIET + TARGET,
    setup: doc
      ? `var __kpRef = ${refLiteral(doc)};
if (!app.project || !app.project.path) throw new Error(${q(REFUSED)} + 'No project is open in Premiere Pro, so nothing ran.');
if (!__kpIs(app.project, __kpRef)) throw new Error(${q(REFUSED)} + __kpWhy(__kpRef));
if (!__kpRef.path){ var __kpN = 0; for (var __kpI = 0; __kpI < app.projects.numProjects; __kpI++){ if (__kpBare(app.projects[__kpI].name) === __kpBare(__kpRef.name)) __kpN++; } if (__kpN > 1) throw new Error(${q(REFUSED)} + 'Two open Premiere Pro projects are called ' + __kpRef.name + ': pass its path too, so the right one is used. Nothing ran.'); }
__kpSeqT = __kpSeqOf(__kpRef.part);`
      : ``,
    after: ``,
  };
}

// Shared helpers for Komposit's own scripts (1.0's LIB, verbatim).
export const LIB = `
var TPS = 254016000000;
function rnd(n){ return Math.round(Number(n)*100)/100; }
function secs(t){ try { return rnd(t.seconds); } catch(e){ return null; } }
function fps(seq){ try { return rnd(1/seq.getSettings().videoFrameRate.seconds); } catch(e){ return null; } }
// The sequence's in/out range in seconds, or null when none is set (Premiere
// reports an unset point as a large negative number).
function inOut(s){
  try {
    var i = s.getInPointAsTime().seconds, u = s.getOutPointAsTime().seconds, d = Number(s.end)/TPS;
    if (i < 0) i = 0; if (u < 0 || u > d) u = d;
    if (u > i && (i > 0.01 || u < d - 0.01)) return [rnd(i), rnd(u)];
  } catch(e){}
  return null;
}
function seqInfo(s){
  var st = s.getSettings();
  var o = { name:s.name, id:s.sequenceID, w:st.videoFrameWidth, h:st.videoFrameHeight, fps:fps(s), frameTicks:st.videoFrameRate.ticks,
    duration:rnd(Number(s.end)/TPS), playhead:secs(s.getPlayerPosition()),
    videoTracks:s.videoTracks.numTracks, audioTracks:s.audioTracks.numTracks };
  var r = inOut(s); if (r) o.inOut = r;
  return o;
}
function clipRec(c, ref){
  var r = { ref:ref, name:c.name, start:secs(c.start), end:secs(c.end), srcIn:secs(c.inPoint), srcOut:secs(c.outPoint) };
  try { if (c.projectItem) r.source = c.projectItem.name; } catch(e){}
  try { if (c.disabled) r.disabled = true; } catch(e){}
  try { var sp = c.getSpeed(); if (sp && Math.abs(sp - 1) > 0.001) r.speed = Math.round(sp * 100) + '%'; } catch(e){}
  try { if (c.isSpeedReversed()) r.reversed = true; } catch(e){}
  try { if (c.isSelected()) r.selected = true; } catch(e){}
  try {
    var fx = [];
    for (var k=0;k<c.components.numItems;k++){ var n = c.components[k].displayName; if (n !== 'Opacity' && n !== 'Motion' && n !== 'Volume' && n !== 'Channel Volume' && n !== 'Panner' && n !== 'Time Remapping') fx.push(n); }
    if (fx.length) r.effects = fx;
  } catch(e){}
  return r;
}
function tracks(s, kind, maxClips){
  var T = kind === 'video' ? s.videoTracks : s.audioTracks, out = [];
  for (var i=0;i<T.numTracks;i++){
    var t = T[i], rec = { ref:'seq.'+kind+'Tracks['+i+']', name:t.name, clips:[] };
    try { if (t.isMuted()) rec.muted = true; } catch(e){}
    try { if (t.isLocked()) rec.locked = true; } catch(e){}
    var prevEnd = null, gaps = [];
    for (var j=0;j<t.clips.numItems && j<maxClips;j++){
      var c = t.clips[j];
      rec.clips.push(clipRec(c, rec.ref+'.clips['+j+']'));
      // Gaps between clips, tick-exact: displayed times are rounded, so a
      // 2-millisecond gap would otherwise look like a clean cut.
      if (prevEnd !== null){ var g = Number(c.start.ticks) - prevEnd; if (g > TPS / 10000) gaps.push({ before:'clips['+j+']', at:rnd(prevEnd/TPS), seconds:Math.round(g/TPS*1000)/1000 }); }
      prevEnd = Number(c.end.ticks);
    }
    if (gaps.length) rec.gaps = gaps;
    try { var trs = []; for (var q=0;q<t.transitions.numItems && q<40;q++){ var tr = t.transitions[q]; trs.push({ name:tr.name, start:secs(tr.start), end:secs(tr.end) }); } if (trs.length) rec.transitions = trs; } catch(e){}
    if (t.clips.numItems > maxClips) rec.more = t.clips.numItems - maxClips;
    if (rec.clips.length || i === 0) out.push(rec);
  }
  return out;
}
function markers(s, max){
  var out = [];
  try { var m = s.markers.getFirstMarker(); while (m && out.length < max){ var r = { start:secs(m.start), name:m.name }; if (m.end && m.end.seconds > m.start.seconds) r.end = secs(m.end); if (m.comments) r.comments = String(m.comments).substr(0,120); out.push(r); m = s.markers.getNextMarker(m); } } catch(e){}
  return out;
}
function itemType(it){
  if (it.type === ProjectItemType.BIN) return 'bin';
  try { if (it.isSequence()) return 'sequence'; } catch(e){}
  return 'clip';
}
function walkBin(bin, path, out, depth){
  for (var i=0;i<bin.children.numItems && out.length<150;i++){
    var it = bin.children[i], ty = itemType(it), p = (path ? path+'/' : '')+it.name, rec = { path:p, type:ty };
    if (ty === 'clip'){ try { var mp = it.getMediaPath(); if (mp) rec.media = mp; } catch(e){} }
    out.push(rec);
    if (ty === 'bin' && depth < 4) walkBin(it, p, out, depth+1);
  }
  return out;
}
`;

export const DOCUMENTS = `${LIB}
var out = [], active = app.project ? app.project.documentID : null;
for (var i=0;i<app.projects.numProjects;i++){
  var p = app.projects[i], seqs = [], rec;
  for (var k=0;k<p.sequences.numSequences;k++) seqs.push(p.sequences[k].name);
  rec = { name:p.name, path:p.path, active:p.documentID === active, sequences:seqs };
  if (rec.active && p.activeSequence) rec.part = { id:String(p.activeSequence.sequenceID), name:p.activeSequence.name };
  out.push(rec);
}
return { documents: out };`;

export const INSPECT = `${LIB}
var p = app.project;
if (!p || !p.path) return { noDocument:true };
var data = { appVersion:String(app.version), project:p.name, path:p.path, items:walkBin(p.rootItem, '', [], 0), sequences:[] };
for (var i=0;i<p.sequences.numSequences;i++) data.sequences.push(p.sequences[i].name);
var s = __kpTarget();
if (s){
  data.sequence = seqInfo(s);
  data.sequence.video = tracks(s, 'video', 40);
  data.sequence.audio = tracks(s, 'audio', 40);
  var mk = markers(s, 40); if (mk.length) data.sequence.markers = mk;
}
return data;`;

// What the person has selected right now: the clips selected on the timeline (with refs
// usable in an edit), the playhead, and otherwise what's selected in the Project panel.
export const SELECTION = `${LIB}
var p = app.project;
if (!p || !p.path) return { noDocument:true };
var out = { project:p.name };
var s = __kpTarget();
if (s){
  out.sequence = seqInfo(s);
  var sel = s.getSelection(), clips = [];
  var ids = {}; for (var a=0;a<sel.length;a++){ try { ids[sel[a].nodeId] = 1; } catch(e){} }
  var kinds = ['video','audio'];
  for (var q=0;q<2 && clips.length<25;q++){
    var T = kinds[q] === 'video' ? s.videoTracks : s.audioTracks;
    for (var i=0;i<T.numTracks;i++) for (var j=0;j<T[i].clips.numItems;j++){
      var c = T[i].clips[j]; if (!ids[c.nodeId]) continue;
      var r = clipRec(c, 'seq.'+kinds[q]+'Tracks['+i+'].clips['+j+']'); r.kind = kinds[q]; clips.push(r);
    }
  }
  out.clips = clips; out.count = sel.length;
}
try {
  var v = app.getCurrentProjectViewSelection();
  if (v && v.length){ out.projectItems = []; for (var k=0;k<v.length && k<20;k++) out.projectItems.push({ name:v[k].name, type:itemType(v[k]) }); }
} catch(e){}
return out;`;

export const SEQ_INFO = `${LIB}
var s = app.project && __kpTarget();
if (!s) throw new Error('No sequence open in Premiere Pro.');
return seqInfo(s);`;

// Premiere's Events pop-up. Every frame exported here is an info event ("Exported frame
// <path>."), and Premiere pops each one up at the bottom right of its window while its
// General setting "Show Event Indicator" is on. Its key is fe.status.showErrorOverlay, and
// Premiere reads it as each event comes in (Premiere Pro 26.5: FE::StatusBar::
// OnEventReceived); with it off, info events only go to the Events panel (errors still pop
// up). So the scripts that export frames turn it off for this session only (not saved), and
// return what it was; once the frames are in and their events are past, the connector puts
// it back (restoreEvents). Nothing here can stop a frame: if the setting can't be read or
// changed, the frames come as before, pop-ups and all. Only a setting that is on is touched.
export const EVENTS_KEY = "fe.status.showErrorOverlay";
const HUSH = `
function hushEvents(){ try { var P = app.properties, k = ${q(EVENTS_KEY)}; if (!P || P.isPropertyReadOnly(k)) return null; var was = P.doesPropertyExist(k) ? String(P.getProperty(k)) : 'true'; if (was !== 'true') return null; P.setProperty(k, 'false', false, true); return was; } catch(e){ return null; } }
function unhushEvents(was){ if (was === null) return; try { app.properties.setProperty(${q(EVENTS_KEY)}, was, true, false); } catch(e){} }`;

/** Puts the Events pop-up setting back as it was before frames were exported (HUSH). */
export function restoreEvents(was: string): string {
  return `${HUSH}
unhushEvents(${q(was)});
var now = null; try { now = String(app.properties.getProperty(${q(EVENTS_KEY)})); } catch(e){}
return { events: now };`;
}

// Frames of the request's sequence as PNGs (it must be the open one: QE), at the given times (seconds; null = the playhead).
// Read-only: the playhead doesn't move. Premiere writes each file a moment after the call
// returns, and may add ".png" itself; the connector waits for complete files. `quiet`: what
// the Events pop-up setting was, when this script turned it off (HUSH), else null.
export function frames(times: (number | null)[], outs: string[]): string {
  return `${LIB}${HUSH}
var s = app.project && __kpTarget();
if (!s) throw new Error('No sequence open in Premiere Pro.');
var qs = __kpQe();
if (!qs) throw new Error('No sequence open in Premiere Pro.');
var st = s.getSettings(), times = ${JSON.stringify(times)}, outs = ${JSON.stringify(outs)}, dur = Number(s.end)/TPS, got = [];
var quiet = hushEvents();
try {
  for (var i=0;i<times.length;i++){
    var t = new Time();
    if (times[i] === null) t = s.getPlayerPosition(); else t.seconds = Math.max(0, Math.min(times[i], dur - 1/fps(s)));
    qs.exportFramePNG(t.getFormatted(st.videoFrameRate, st.videoDisplayFormat), outs[i]);
    got.push(secs(t));
  }
} catch(e){ unhushEvents(quiet); throw e; }
return { times:got, w:st.videoFrameWidth, h:st.videoFrameHeight, sequence:s.name, quiet:quiet };`;
}

// Watching a stretch: a frame at each time, and which clip is on top there (the highest video
// track with an enabled clip at that time), with the second of its source the frame shows.
// `quiet` as in frames().
export function watch(times: number[], outs: string[]): string {
  return `${LIB}${HUSH}
var s = __kpTarget();
if (!s) throw new Error('No sequence open in Premiere Pro.');
var qs = __kpQe();
var st = s.getSettings(), times = ${JSON.stringify(times)}, outs = ${JSON.stringify(outs)}, ft = Number(st.videoFrameRate.ticks), rate = fps(s), from = [];
var quiet = hushEvents();
try {
for (var i=0;i<times.length;i++){
  var t = new Time(); t.ticks = String(Math.round(times[i] * rate) * ft);
  qs.exportFramePNG(t.getFormatted(st.videoFrameRate, st.videoDisplayFormat), outs[i]);
  var hit = null;
  for (var v=s.videoTracks.numTracks-1; v>=0 && !hit; v--){
    var T = s.videoTracks[v];
    for (var c=0;c<T.clips.numItems;c++){ var k = T.clips[c]; if (k.start.seconds <= times[i] + 0.0005 && k.end.seconds > times[i] + 0.0005){ var off = false; try { off = k.disabled; } catch(e){} if (!off) hit = { v:v, c:c, name:k.name, start:rnd(k.start.seconds), end:rnd(k.end.seconds), src:rnd(k.inPoint.seconds + (times[i] - k.start.seconds)) }; break; } }
  }
  from.push(hit);
}
} catch(e){ unhushEvents(quiet); throw e; }
return { from: from, quiet: quiet };`;
}

// Premiere's own H.264 "Match Source" export presets. Their file names change between
// versions, even in point updates ("Match Source - High bitrate", "00 - Match Source -
// Medium bitrate", "01 - ..."), so they are found by what they say, in the H.264 folder
// (4E49434B_48323634) under the app.
const FIND_PRESET = `
function findPreset(want){
  var base = Folder(app.path).fsName, sub = '/MediaIO/systempresets/4E49434B_48323634', dirs = [base + sub, base + '/Contents' + sub, base + '/..' + sub], files = [], i, j;
  for (i=0;i<dirs.length && !files.length;i++){ var d = Folder(dirs[i]); if (d.exists){ var fl = d.getFiles('*.epr'); for (j=0;j<fl.length;j++) files.push(fl[j]); } }
  if (!files.length) throw new Error('Could not find the H.264 export presets of Premiere Pro under ' + base);
  for (i=0;i<want.length;i++) for (j=0;j<files.length;j++) if (want[i].test(decodeURI(files[j].name))) return files[j].fsName;
  return files[0].fsName;
}
`;
const PRESET_WANT = {
  full: "[/match source.*medium bitrate/i, /match source.*high bitrate/i, /match source/i]",
  preview: "[/match source.*low bitrate/i, /match source.*medium bitrate/i, /match source/i]",
};

// H.264 of the request's sequence through Premiere's own encoder (no Media Encoder needed).
// Full: the in/out range or the whole sequence, nothing changed. Preview: at most 10 s from
// around the playhead, low bitrate; the in and out points are set for it and put back.
export function encode(out: string, preview: boolean): string {
  return `${LIB}${FIND_PRESET}
var s = app.project && __kpTarget();
if (!s) throw new Error('No sequence open in Premiere Pro.');
var f = findPreset(${preview ? PRESET_WANT.preview : PRESET_WANT.full});
var dur = Number(s.end)/TPS, range = inOut(s), which = app.encoder.ENCODE_ENTIRE;
var oldIn = s.getInPointAsTime().ticks, oldOut = s.getOutPointAsTime().ticks;
if (${preview ? "true" : "false"}){
  var ph = s.getPlayerPosition().seconds, a = Math.max(0, Math.min(ph, dur - 10)), b = Math.min(dur, a + 10);
  if (range && range[1] - range[0] <= 10){ a = range[0]; b = range[1]; }
  s.setInPoint(a); s.setOutPoint(b); which = app.encoder.ENCODE_IN_TO_OUT;
} else if (range) which = app.encoder.ENCODE_IN_TO_OUT;
var ok;
try { ok = s.exportAsMediaDirect(${q(out)}, f, which); }
finally { if (${preview ? "true" : "false"}){ s.setInPoint(oldIn); s.setOutPoint(oldOut); } }
return { result: String(ok), range: which === app.encoder.ENCODE_ENTIRE ? 'entire sequence' : 'in to out', preset: decodeURI(File(f).name), sequence: s.name, w: s.getSettings().videoFrameWidth, h: s.getSettings().videoFrameHeight };`;
}

// Save the project itself (Cmd+S): only from the save tool, when the person asked.
export const SAVE_OVERWRITE = `
var p = app.project;
if (!p || !p.path) throw new Error('No project is open in Premiere Pro.');
p.save();
return { path: p.path, name: p.name };`;

// Save as: Premiere writes the project to the new file, opens it from there and closes the
// one from before (identical); the file from before keeps what it last saved. `switched`:
// the open project is already the new file (Premiere may take a moment).
export function saveAs(path: string): string {
  return `
var p = app.project, was = p.name, wasPath = p.path;
p.saveAs(${q(path)});
var f = new File(${q(path)});
if (!f.exists) throw new Error('Premiere Pro did not save the project as ' + f.fsName + '.');
var now = app.project;
return { path: f.fsName, name: decodeURI(f.name), was: was, wasPath: wasPath, switched: !!(now && __kpSame(now.path, f.fsName)) };`;
}

// A copy that leaves the open project as it is: Premiere's scripts have no "save a copy" for
// a whole project (saveAs moves the open project to the new file), so this writes the active
// sequence and the media it uses as a new project (Sequence.exportAsProject).
export function saveCopy(path: string): string {
  return `
var s = __kpTarget();
if (!s) throw new Error('Open the sequence to copy first: a copy holds the active sequence and the media it uses.');
if (typeof s.exportAsProject !== 'function') throw new Error('This Premiere Pro has no scripted copy of a sequence as a project (Premiere Pro ' + app.version + ').');
var r = s.exportAsProject(${q(path)});
return { sequence: s.name, project: app.project.name, result: String(r) };`;
}

export const ACTIVE_SEQUENCE_NAME = `
var s = app.project && __kpTarget();
if (!s) throw new Error('No sequence open in Premiere Pro.');
return s.name;`;

// Premiere's DOM has no undo; the QE DOM's is used. One QE step isn't always one script
// action.
export function undo(steps: number): string {
  return `
app.enableQE();
if (typeof qe.project.undo !== 'function') throw new Error('Premiere has no scripted undo. Press Cmd+Z (Ctrl+Z) in Premiere Pro.');
var n = 0;
for (var i=0;i<${steps};i++){ qe.project.undo(); n++; }
return n;`;
}

// Import into the project (a "Komposit" bin), then onto the request's sequence at its playhead,
// on the lowest video track with nothing there. Dialogs suppressed.
export function place(path: string, addToSequence = true): string {
  return `
var p = app.project;
if (!p || !p.path) throw new Error("No project is open in Premiere Pro to bring the file into.");
var f = new File(${q(path)});
if (!f.exists) throw new Error("No file at " + f.fsName);
var bin = null;
for (var i = 0; i < p.rootItem.children.numItems; i++) { var c = p.rootItem.children[i]; if (c.type === ProjectItemType.BIN && c.name === "Komposit") { bin = c; break; } }
if (!bin) bin = p.rootItem.createBin("Komposit");
var before = bin.children.numItems;
p.importFiles([f.fsName], true, bin, false);
var item = null;
for (var k = bin.children.numItems - 1; k >= 0 && k >= before - 1; k--) { var it = bin.children[k]; if (it.name === f.name || it.name === decodeURI(f.name) || k >= before) { item = it; break; } }
if (!item) throw new Error("Premiere Pro didn't import " + decodeURI(f.name));
var seq = __kpTarget(), at = null, track = null;
if (${addToSequence !== false} && seq) {
  at = seq.getPlayerPosition().seconds;
  var T = seq.videoTracks, pick = -1;
  for (var t = 0; t < T.numTracks && pick < 0; t++) {
    var busy = false;
    for (var j = 0; j < T[t].clips.numItems; j++) { var cl = T[t].clips[j]; if (cl.start.seconds <= at + 0.001 && cl.end.seconds > at + 0.001) { busy = true; break; } }
    if (!busy && !T[t].isLocked()) pick = t;
  }
  if (pick < 0) pick = T.numTracks - 1;
  T[pick].overwriteClip(item, at);
  track = "V" + (pick + 1);
}
return { placed: decodeURI(f.name), item: item.name, bin: bin.name, addedTo: track ? seq.name : null, track: track, at: at === null ? null : Math.round(at * 100) / 100, project: p.name };`;
}

// Open a project (.prproj). One that's already open is left as it is (not brought forward).
// `active`: it is the active project now (a project Premiere opens becomes the active one,
// though it may take a moment).
export function open(path: string): string {
  return `
var f = new File(${q(path)});
if (!f.exists) throw new Error("No file at " + f.fsName);
for (var i = 0; i < app.projects.numProjects; i++) { if (File(app.projects[i].path).fsName === f.fsName) return { name: app.projects[i].name, path: app.projects[i].path, already: true, active: !!(app.project && app.projects[i].documentID === app.project.documentID) }; }
if (!app.openDocument(f.fsName, true, true, true)) throw new Error("Premiere Pro didn't open " + decodeURI(f.name));
return { name: decodeURI(f.name), path: f.fsName, already: false, active: !!(app.project && __kpSame(app.project.path, f.fsName)) };`;
}

// Listening (ported from 1.0's listen()): the request's sequence as a timeline of sound. Each
// audio clip with its media file, where it sits, its in and out point (so its speed shows),
// and whether it's disabled, nested or reversed (those aren't followed). Read-only.
export const LISTEN_LAYOUT = `${LIB}
var p = app.project; if (!p || !p.path) return { noDocument:true };
var s = __kpTarget(); if (!s) return { noSequence:true };
var out = { project:p.path, name:s.name, id:String(s.sequenceID), duration:Number(s.end)/TPS, audio:[], video:[] };
for (var i=0;i<s.audioTracks.numTracks;i++){
  var t = s.audioTracks[i], rec = { index:i, name:t.name, clips:[] };
  try { if (t.isMuted()) rec.muted = true; } catch(e){}
  for (var j=0;j<t.clips.numItems && j<800;j++){
    var c = t.clips[j], r = { name:c.name, start:c.start.seconds, end:c.end.seconds, srcIn:c.inPoint.seconds, srcOut:c.outPoint.seconds };
    try { if (c.disabled) r.disabled = true; } catch(e){}
    try { if (c.isSpeedReversed()) r.nested = true; } catch(e){}
    try { var it = c.projectItem; if (it){ var nested = false; try { nested = it.isSequence(); } catch(e2){} if (nested) r.nested = true; else { var mp = it.getMediaPath(); if (mp) r.path = mp; } } } catch(e3){}
    rec.clips.push(r);
  }
  out.audio.push(rec);
}
for (var v=0;v<s.videoTracks.numTracks;v++){ var vt = s.videoTracks[v], names = []; for (var k=0;k<vt.clips.numItems && k<3;k++) names.push(vt.clips[k].name); out.video.push({ index:v, name:vt.name, clips:vt.clips.numItems, first:names }); }
return out;`;

/** The active project's saved file (where Premiere keeps its transcripts), or null. */
export const PROJECT_PATH = `var p = app.project; return p && p.path ? p.path : null;`;
