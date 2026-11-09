// A local log of things that went wrong inside the design apps: an app that
// stopped answering, crashed, or threw while running a script. One JSON line
// per incident in <data>/incidents.jsonl, with the script that was running.
//
// It's for whoever improves the harness, not for the model: nothing here is
// fed back into prompts automatically (a model-written "lesson" can be wrong
// and would then repeat forever). Read it with `npm run incidents`, confirm
// the pattern, and add the fix to harness/guidance.mjs by hand.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR } from "./config.mjs";
import platform from "./platform/index.mjs";

export const INCIDENTS = join(DATA_DIR, "incidents.jsonl");
const MAX_BYTES = 2 * 1024 * 1024;

export function appKey(target = "") {
  const t = String(target).toLowerCase();
  if (t.includes("illustrator")) return "illustrator";
  if (t.includes("photoshop")) return "photoshop";
  if (t.includes("after effects") || t.includes("aftereffects")) return "aftereffects";
  return t || "unknown";
}

// Is the app still alive? (Process checks live in the platform layer.)
export function isRunning(app) {
  return platform.isAppRunning(app);
}

// What kind of failure a transport error message describes (osascript on a
// Mac, COM or AfterFX.exe on Windows).
export function classify(message = "") {
  const m = String(message);
  if (/didn't answer in time|-1712|timed out/i.test(m)) return "timeout";
  if (/-609|-903|connection is invalid|isn.t running|not running/i.test(m)) return "crash";
  if (/0x800706BA|0x80010108|RPC server is unavailable|disconnected from its clients/i.test(m)) return "crash";
  return "app-error";
}

// Append one incident. Never throws: logging must not break a turn.
export function recordIncident({ app, kind, message, script, code } = {}) {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    if (existsSync(INCIDENTS) && statSync(INCIDENTS).size > MAX_BYTES) renameSync(INCIDENTS, INCIDENTS + ".1");
    const row = {
      at: new Date().toISOString(),
      app: appKey(app),
      kind,
      code: code || undefined,
      message: String(message || "").slice(0, 2000),
      script: script ? String(script).slice(0, 4000) : undefined,
    };
    appendFileSync(INCIDENTS, JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch {}
}

// After an osascript failure: log it, upgrading to "crash" if the app is gone.
export async function recordFailure(target, err, script) {
  const app = appKey(target);
  let kind = classify(err?.message);
  if (err?.code === "AUTOMATION_DENIED" || err?.message === "stopped") return;
  if (kind !== "crash" && !(await isRunning(app))) kind = "crash";
  recordIncident({ app, kind, message: err?.message, code: err?.code, script });
}

export function readIncidents() {
  if (!existsSync(INCIDENTS)) return [];
  return readFileSync(INCIDENTS, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// `node companion/incidents.mjs`: group incidents by app, kind and message.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = readIncidents();
  if (!rows.length) { console.log(`No incidents logged (${INCIDENTS}).`); process.exit(0); }
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.app} | ${r.kind} | ${String(r.message).split("\n").pop().replace(/\d+/g, "#").slice(0, 140)}`;
    const g = groups.get(key) || { n: 0, last: r };
    g.n++; g.last = r; groups.set(key, g);
  }
  console.log(`${rows.length} incidents in ${INCIDENTS}\n`);
  for (const [key, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${String(g.n).padStart(4)}x  ${key}\n       last ${g.last.at}`);
    if (g.last.script) console.log("       script: " + g.last.script.split("\n").slice(0, 6).join("\n               "));
    console.log();
  }
}
