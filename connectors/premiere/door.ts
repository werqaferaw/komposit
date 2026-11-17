// The door into Premiere Pro: Komposit's panel inside it (panel/bridge.js), reached over
// 127.0.0.1 with the port and per-run token the panel writes to its address file. Every
// call answers with an envelope (envelope.ts), never a thrown transport error: the script's
// own {ok, error, logs, data}, or {ok: false, error: <plain sentence>, code}.
//
// node:http, not fetch: fetch gives up on an answer after 300 s, and an export can take
// longer. The timeout here is the caller's.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { parseEnvelope } from "../_kit/envelope.ts";
import type { Envelope } from "../_kit/envelope.ts";
import type { IncidentLog } from "../_kit/incidents.ts";
import { KitError, errorCode, errorMessage } from "../_kit/transport.ts";

const LABEL = "Premiere Pro";

export interface PanelAddress {
  port: number;
  token: string;
  pid?: number;
  /** The panel's own version. */
  bridge?: string;
  host?: { appName?: string; appVersion?: string };
}

/** The running panel's address, or null when there's none (or it isn't one). */
export function readAddress(file: string): PanelAddress | null {
  try {
    const a = JSON.parse(readFileSync(file, "utf8"));
    if (!a || !Number.isInteger(a.port) || a.port <= 0 || a.port > 65535) return null;
    if (typeof a.token !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(a.token)) return null;
    return a as PanelAddress;
  } catch {
    return null;
  }
}

// The panel's process (Premiere's CEP engine) is still there. An address left behind by a
// Premiere that quit or crashed is never sent the token or a script.
function alive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || pid! <= 0) return true; // unknown: the token decides
  try {
    process.kill(pid!, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The address, when the panel that wrote it may still be running. */
function liveAddress(file: string): PanelAddress | null {
  const a = readAddress(file);
  return a && alive(a.pid) ? a : null;
}

interface Answer {
  status: number;
  json: any;
}

/** One request to the panel. Rejects with a KitError: UNREACHABLE (nothing there), DROPPED
 *  (the line closed mid-call), TIMEOUT, STOPPED. */
function ask(addr: PanelAddress, method: "GET" | "POST", path: string, body: string | null, timeoutMs: number, signal?: AbortSignal): Promise<Answer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new KitError("stopped", "STOPPED"));
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const req = request(
      {
        host: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "x-komposit-token": addr.token,
          ...(body != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try { json = JSON.parse(text); } catch { json = null; }
          finish(() => resolve({ status: res.statusCode || 0, json }));
        });
        res.on("error", (e) => finish(() => reject(new KitError(`The line to ${LABEL} closed: ${e.message}`, "DROPPED"))));
      },
    );
    const timer = setTimeout(() => {
      finish(() => reject(new KitError(`${LABEL} didn't answer in time. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.`, "TIMEOUT")));
      req.destroy();
    }, timeoutMs);
    const onAbort = () => {
      finish(() => reject(new KitError("stopped", "STOPPED")));
      req.destroy();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Refused: nothing listens there (Premiere quit, or the panel hasn't started this time).
    // Anything else after the request went out: the line dropped mid-call.
    req.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      finish(() => reject(new KitError(`The panel's line closed (${code || e.message}).`, code === "ECONNREFUSED" ? "UNREACHABLE" : "DROPPED")));
    });
    if (body != null) req.write(body);
    req.end();
  });
}

export type PingResult =
  | { ok: true; bridge?: string; host?: { appName?: string; appVersion?: string } }
  | { ok: false; why: "no-address" | "unreachable" | "token" | "timeout" | "not-the-panel" };

export interface PanelDoor {
  /** The panel's address file. */
  readonly file: string;
  /** Is the panel answering? Reads only; nothing reaches Premiere's scripting. */
  ping(timeoutMs?: number): Promise<PingResult>;
  /** Run a wrapped script (envelope.ts wrap) in Premiere. `unreachable` gives the plain
   *  sentence for when the panel can't be reached (status' reason). */
  run(source: string, opts: { timeoutMs: number; signal?: AbortSignal; script: string; unreachable: () => Promise<string> }): Promise<Envelope>;
}

export function createPanelDoor({ file, incidents }: { file: string; incidents: IncidentLog }): PanelDoor {
  return {
    file,

    async ping(timeoutMs = 1500) {
      const addr = liveAddress(file);
      if (!addr) return { ok: false, why: "no-address" };
      try {
        const r = await ask(addr, "GET", "/status", null, timeoutMs);
        if (r.status === 401) return { ok: false, why: "token" };
        if (r.status !== 200 || !r.json?.ok) return { ok: false, why: "not-the-panel" };
        return { ok: true, ...(r.json.bridge ? { bridge: String(r.json.bridge) } : {}), ...(r.json.host ? { host: r.json.host } : {}) };
      } catch (e) {
        return { ok: false, why: errorCode(e) === "TIMEOUT" ? "timeout" : "unreachable" };
      }
    },

    async run(source, { timeoutMs, signal, script, unreachable }) {
      const notThere = async (): Promise<Envelope> => ({ ok: false, error: await unreachable(), code: "PANEL_UNREACHABLE", logs: [], data: null });
      const addr = liveAddress(file);
      if (!addr) return notThere();
      let r: Answer;
      try {
        r = await ask(addr, "POST", "/eval", JSON.stringify({ script: source }), timeoutMs, signal);
      } catch (e) {
        const code = errorCode(e);
        if (code === "STOPPED") {
          return { ok: false, error: `Stopped before ${LABEL} answered. The step may still finish inside the app, so check before retrying.`, code: "STOPPED", logs: [], data: null };
        }
        if (code === "TIMEOUT") {
          incidents.record({ app: "premiere", kind: "timeout", code, message: errorMessage(e), script });
          return { ok: false, error: errorMessage(e), code, logs: [], data: null };
        }
        if (code === "DROPPED") {
          // Premiere quit or crashed while the script ran.
          incidents.record({ app: "premiere", kind: "crash", code, message: errorMessage(e), script });
          return { ok: false, error: `${LABEL} stopped answering in the middle of the step. It may have crashed or quit; check it, then try again.`, code: "APP_GONE", logs: [], data: null };
        }
        // Nothing there: Premiere quit, or it hasn't started the panel this time.
        return notThere();
      }
      // An older run's token: Premiere was restarted and the address file is stale.
      if (r.status === 401 || r.status === 403) return notThere();
      if (r.status !== 200 || !r.json?.ok) {
        const why = r.json?.error ? String(r.json.error) : `HTTP ${r.status}`;
        incidents.record({ app: "premiere", kind: "app-error", code: "PANEL_ERROR", message: why, script });
        return { ok: false, error: `Komposit's panel in ${LABEL} refused the script (${why}).`, code: "PANEL_ERROR", logs: [], data: null };
      }
      const raw = String(r.json.result ?? "");
      if (/^EvalScript error/.test(raw)) {
        incidents.record({ app: "premiere", kind: "script-error", code: "EVALSCRIPT", message: raw, script });
        return { ok: false, error: `${LABEL} couldn't run the script (it gave no reason).`, code: "EVALSCRIPT", logs: [], data: null };
      }
      return parseEnvelope(raw, LABEL);
    },
  };
}
