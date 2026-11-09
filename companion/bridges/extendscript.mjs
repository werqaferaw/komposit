// Running ExtendScript in the Adobe apps, the same way on every platform.
//
// Every script is wrapped in a {ok, error, logs, data} envelope, then handed to
// the platform layer (AppleScript on a Mac, COM or AfterFX.exe on Windows).
// Two return channels, because the apps differ:
//   - Illustrator / Photoshop return the wrapped script's last expression, so
//     the envelope comes straight back (runViaStdout);
//   - After Effects returns nothing, so the wrapped script WRITES its JSON
//     envelope to a file that is read back here (runViaFile).
import { readFileSync, existsSync } from "node:fs";
import platform from "../platform/index.mjs";
import { recordFailure, recordIncident, appKey } from "../incidents.mjs";
import { scratchDir, readPng, scratchName, rmQuiet } from "../scratch.mjs";

export { scratchDir, readPng };

// ES3 has no JSON — inject our own serializer into every script.
export const JSON_ENCODER = `
function __q(s){
  s = String(s); var out = '"';
  for (var i=0;i<s.length;i++){
    var c = s.charAt(i), cc = s.charCodeAt(i);
    if (c === '"') out += '\\\\"';
    else if (c === '\\\\') out += '\\\\\\\\';
    else if (c === '\\n') out += '\\\\n';
    else if (c === '\\r') out += '\\\\r';
    else if (c === '\\t') out += '\\\\t';
    else if (cc < 32){ var h = cc.toString(16); while(h.length<4) h='0'+h; out += '\\\\u'+h; }
    else out += c;
  }
  return out + '"';
}
function __encode(v){
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return __q(v);
  if (v instanceof Array){
    var a = []; for (var i=0;i<v.length;i++) a.push(__encode(v[i]));
    return '[' + a.join(',') + ']';
  }
  if (t === 'object'){
    var o = []; for (var k in v){ if (v.hasOwnProperty(k)) o.push(__q(k)+':'+__encode(v[k])); }
    return '{' + o.join(',') + '}';
  }
  return __q(String(v));
}
`;

// Wrap user code in a {ok,error,logs,data} envelope.
// viaEval: compile the code with eval inside the try, so a SYNTAX error is
// caught and returned too. After Effects needs this: it reports uncaught script
// errors as a modal alert, and while that's open it ignores every later script.
export function wrap(userCode, { write = null, viaEval = false } = {}) {
  const emit = write
    ? `var __f = new File(${JSON.stringify(write)}); __f.encoding = 'UTF-8'; __f.open('w'); __f.write(__out); __f.close();`
    : `__out;`;
  return `
${JSON_ENCODER}
var __logs = [];
function log(m){ __logs.push(String(m)); }
var __result = { ok: true, error: null, logs: __logs, data: null };
try {
  __result.data = ${viaEval ? `eval(${JSON.stringify("(function(){\n" + userCode + "\n})")})()` : `(function(){
${userCode}
  })()`};
} catch (e) {
  __result.ok = false;
  __result.error = (e && e.message) ? e.message : String(e);
  if (e && e.line) { __result.error += ' (line ' + e.line + ')'; }
}
__result.logs = __logs;
var __out;
try { __out = __encode(__result); }
catch (e) { __out = __encode({ ok:false, error:'Result not serializable — return only plain strings/numbers/arrays/objects: ' + ((e&&e.message)?e.message:String(e)), logs:__logs, data:null }); }
${emit}
`;
}

export function parseEnvelope(raw, appName) {
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, error: `Unparseable ${appName} output: ${raw}`, logs: [], data: null };
  }
}

// The app id ("illustrator") from an id or an older AppleScript target string.
function idOf(app) {
  return appKey(app);
}

// Illustrator / Photoshop: the result comes back as the script's value.
// On Windows the code is compiled with eval inside the envelope (as After
// Effects' always is), so a syntax error comes back as an error with its
// message and line, not as a bare COM error code.
export async function runViaStdout(app, userCode, opts = {}) {
  const id = idOf(app);
  let raw;
  try { raw = await platform.runJsx(id, wrap(userCode, { viaEval: platform.name === "win" }), { ...opts, via: "stdout" }); }
  catch (e) { await recordFailure(id, e, userCode); throw e; }
  return noteScriptError(id, parseEnvelope(raw, platform.target(id)), userCode);
}

// Script errors inside the app go to the incident log too (see incidents.mjs).
function noteScriptError(app, env, userCode) {
  if (env && env.ok === false) recordIncident({ app, kind: env.code ? "blocked" : "script-error", code: env.code, message: env.error, script: userCode });
  return env;
}

// After Effects: no return channel — the script writes its result to a file.
export async function runViaFile(app, userCode, opts = {}) {
  const id = idOf(app);
  // Never send After Effects a script while it's starting or showing a dialog.
  const { aeReady } = await import("../dialogwatch.mjs");
  const ready = await aeReady();
  if (!ready.ok) return noteScriptError(id, { ok: false, error: ready.message, code: ready.code, logs: [], data: null }, userCode);
  const out = scratchName("result", "json");
  try { await platform.runJsx(id, wrap(userCode, { write: out, viaEval: true }), { ...opts, via: "file" }); }
  catch (e) { await recordFailure(id, e, userCode); throw e; }
  if (!existsSync(out)) {
    // DoScript returns at once without running anything while a dialog is up.
    const { modalDialogUp } = await import("../dialogwatch.mjs");
    if (await modalDialogUp("aftereffects")) {
      return noteScriptError(id, {
        ok: false,
        error: "After Effects is showing a dialog, and won't run scripts until it's closed. Close it in After Effects, then try again.",
        code: "AE_DIALOG",
        logs: [],
        data: null,
      }, userCode);
    }
    // The usual cause: After Effects blocks scripts from writing files until
    // "Allow Scripts to Write Files and Access Network" is on (it's off by
    // default), and the result comes back through a file.
    return noteScriptError(id, {
      ok: false,
      error:
        `After Effects ran the script but couldn't hand the result back. In After Effects, open ${platform.aeScriptSettings} and turn on "Allow Scripts to Write Files and Access Network", then try again.`,
      code: "AE_SCRIPT_FILES",
      logs: [],
      data: null,
    }, userCode);
  }
  const raw = readFileSync(out, "utf8").replace(/^﻿/, "").trim();
  rmQuiet(out);
  return noteScriptError(id, parseEnvelope(raw, platform.target(id)), userCode);
}

// Bring an app to the front (best-effort; also launches it if not running).
export function activate(app) {
  return platform.activateApp(idOf(app));
}
