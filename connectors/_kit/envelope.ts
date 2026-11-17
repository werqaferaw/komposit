// Running ExtendScript in the Adobe apps, the same way on every platform.
//
// Every script is wrapped in a {ok, error, logs, data} envelope, then handed to the
// transport (AppleScript on a Mac, COM or AfterFX.exe on Windows). Two return channels,
// because the apps differ:
//   - Illustrator / Photoshop return the wrapped script's last expression, so the
//     envelope comes straight back ("stdout");
//   - After Effects returns nothing, so the wrapped script WRITES its JSON envelope to a
//     file that is read back ("file").
//
// A guard can be put around the person's code: `before` runs first (quiet mode on),
// `setup` inside the try (find the target document), `after` in the finally (put the
// active document back, quiet mode off). The guard can tell Komposit what it noticed by
// setting fields of `__kpFacts` (they come back as the envelope's `facts`). All three sit on the line that opens the
// function, so the line numbers in error messages still match the code that was sent.

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

export interface Guard {
  /** Before the try: switch quiet mode on (and remember the old setting). */
  before?: string;
  /** Inside the try, before the code: find the target document. */
  setup?: string;
  /** In the finally: put things back. Each statement should guard itself. */
  after?: string;
  /** How the code is run, as an expression: the code is the function `__kpFn` then (Photoshop
   *  runs it inside suspendHistory, one named history state). Default: called straight away. */
  call?: string;
}

export interface WrapOptions {
  /** Write the envelope to this file instead of returning it (After Effects). */
  write?: string | null;
  /** Compile the code with eval inside the try, so a SYNTAX error is caught and returned
   *  too. After Effects needs this: it reports uncaught script errors as a modal alert, and
   *  while that's open it ignores every later script. Windows uses it for every app, so a
   *  syntax error comes back with its message and line, not a bare COM error. */
  viaEval?: boolean;
  guard?: Guard;
}

export interface Envelope {
  ok: boolean;
  error: string | null;
  logs: string[];
  data: unknown;
  /** Set by the runner, never by the script: why the script could not run (AE_DIALOG...). */
  code?: string;
  /** What the guard noticed about the step (After Effects: a comp it made), from `__kpFacts`. */
  facts?: Record<string, unknown>;
}

const oneLine = (s: string | undefined) => (s ? s.replace(/\s*\n\s*/g, " ").trim() : "");

/** The function body that runs `userCode` inside the guard. Starts on the opening line, which
 *  also gets `lead` (one line of code: the line mark, JSON). */
function guarded(userCode: string, guard: Guard | undefined, lead: string): string {
  const before = oneLine(guard?.before);
  const setup = oneLine(guard?.setup);
  const after = oneLine(guard?.after);
  const call = oneLine(guard?.call);
  if (!before && !setup && !after && !call) return ` ${lead}\n${userCode}\n`;
  if (call) return ` ${lead} ${before} try { ${setup} var __kpFn = function(){\n${userCode}\n}; return ${call}; } finally { ${after} }\n`;
  return ` ${lead} ${before} try { ${setup} return (function(){\n${userCode}\n})(); } finally { ${after} }\n`;
}

// ES3 has no JSON either. Scripts the AI writes reach for JSON.stringify and JSON.parse all
// the time, so each script gets its own (a local variable, nothing global changes; an app that
// has JSON keeps its own).
const JSON_LOCAL = `
var __kpJ = (typeof JSON !== 'undefined' && JSON && JSON.stringify) ? JSON : {
  stringify: function(v){ return v === undefined ? undefined : __encode(v); },
  parse: function(s){ return eval('(' + s + ')'); }
};
`;

// Wrap user code in a {ok,error,logs,data} envelope.
//
// Line numbers: the app counts lines from the top of the whole script, so an error in the
// code's first line used to come back as "(line 39)" (Illustrator, Nov 16: every line number
// the AI saw was 38 too high). The envelope gives the line in the code it was sent instead:
// counted from the line before it, which is known here when the script runs as it is (Mac
// Illustrator and Photoshop), and read with ExtendScript's $.line when it's compiled with
// eval (After Effects, Windows), where the app may count from the eval'd text. A line outside
// the code (the guard's own lines) is left out when it's known, and kept as it was when not.
export function wrap(userCode: string, { write = null, viaEval = false, guard }: WrapOptions = {}): string {
  const emit = write
    ? `var __f = new File(${JSON.stringify(write)}); __f.encoding = 'UTF-8'; __f.open('w'); __f.write(__out); __f.close();`
    : `__out;`;
  const lines = userCode.split("\n").length;
  const lead = `var JSON = __kpJ;${viaEval ? " try { __kpBase = $.line; } catch (__e) {}" : ""}`;
  const body = guarded(userCode, guard, lead);
  const head = `
${JSON_ENCODER}
${JSON_LOCAL}
var __logs = [];
function log(m){ __logs.push(String(m)); }
var __kpFacts = {};
var __result = { ok: true, error: null, logs: __logs, data: null };
var __kpBase = __KP_BASE__, __kpKnown = ${viaEval ? "false" : "true"}, __kpLines = ${lines};
try {
  __result.data = `;
  const call = viaEval ? `eval(${JSON.stringify("(function(){" + body + "})")})()` : `(function(){${body}  })()`;
  const tail = `;
} catch (e) {
  __result.ok = false;
  __result.error = (e && e.message) ? e.message : String(e);
  if (e && e.line) {
    var __ln = (typeof __kpBase === 'number') ? e.line - __kpBase : e.line;
    if (__ln >= 1 && __ln <= __kpLines) __result.error += ' (line ' + __ln + ')';
    else if (!__kpKnown || typeof __kpBase !== 'number') __result.error += ' (line ' + e.line + ')';
  }
}
__result.logs = __logs;
for (var __kpF in __kpFacts) { if (__kpFacts.hasOwnProperty(__kpF)) { __result.facts = __kpFacts; break; } }
var __out;
try { __out = __encode(__result); }
catch (e) { __out = __encode({ ok:false, error:'Result not serializable — return only plain strings/numbers/arrays/objects: ' + ((e&&e.message)?e.message:String(e)), logs:__logs, data:null }); }
${emit}
`;
  // Run as it is: the head's last line is the opening line; the code starts on the next.
  const base = viaEval ? "null" : String(head.split("\n").length);
  return head.replace("__KP_BASE__", base) + call + tail;
}

/** The line just before the code in a script wrap() made to run as it is (no eval), or null.
 *  For errors the app reports about the whole script (a syntax error on a Mac). */
export function codeLineBase(wrapped: string): number | null {
  const m = /var __kpBase = (\d+),/.exec(wrapped);
  return m ? Number(m[1]) : null;
}

export function parseEnvelope(raw: string, label: string): Envelope {
  const text = String(raw ?? "").replace(/^﻿/, "").trim();
  try {
    const v = JSON.parse(text) as Partial<Envelope> | null;
    if (v && typeof v === "object" && typeof v.ok === "boolean") {
      const facts = v.facts && typeof v.facts === "object" && !Array.isArray(v.facts) ? { facts: v.facts as Record<string, unknown> } : {};
      return { ok: v.ok, error: v.error ?? null, logs: Array.isArray(v.logs) ? v.logs.map(String) : [], data: v.data ?? null, ...facts };
    }
  } catch {}
  // A plain sentence; what came back goes in the logs (the AI may make sense of it).
  return {
    ok: false,
    error: text ? `${label} sent back something Komposit couldn't read.` : `${label} sent nothing back.`,
    logs: text ? [text.slice(0, 2000)] : [],
    data: null,
    code: "UNREADABLE",
  };
}
