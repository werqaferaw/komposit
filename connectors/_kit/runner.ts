// Runs one wrapped ExtendScript call and always answers with an envelope: the script's
// own {ok, error, logs, data}, or {ok: false, error: <plain sentence>, code} when the app
// couldn't be reached. Two return channels (see envelope.ts):
//   stdout  Illustrator / Photoshop: the app returns the envelope;
//   file    After Effects: the script writes the envelope to a scratch file, read back here.
import { existsSync, readFileSync } from "node:fs";
import { createAeReady, modalDialogUp, theirDialogText } from "./dialogwatch.ts";
import type { AeReadiness } from "./dialogwatch.ts";
import { codeLineBase, parseEnvelope, wrap } from "./envelope.ts";
import type { Envelope, Guard } from "./envelope.ts";
import { withHint } from "./hints.ts";
import { classify } from "./incidents.ts";
import type { IncidentLog } from "./incidents.ts";
import { rmQuiet } from "./scratch.ts";
import type { Scratch } from "./scratch.ts";
import { errorCode, errorMessage, labelOf } from "./transport.ts";
import type { ScriptTransport } from "./transport.ts";

export interface ScriptCall {
  timeoutMs?: number;
  signal?: AbortSignal;
  guard?: Guard;
  /** After Effects: a dialog up before the script is sent (the person's: one Komposit's step
   *  caused would have come up during a step) is waited out for up to this long, saying so
   *  through onWait, instead of failing at once. Default 0: fail at once (reads, status). */
  dialogWaitMs?: number;
  onWait?: (reason: string | null) => void;
}

export interface Runner {
  stdout(app: string, code: string, call?: ScriptCall): Promise<Envelope>;
  file(app: string, code: string, call?: ScriptCall): Promise<Envelope>;
  /** After Effects open, started and free of dialogs? waitMs 0 = look once. */
  aeReady(opts?: { waitMs?: number }): Promise<AeReadiness>;
}

const PLAIN_CODES = new Set(["AUTOMATION_DENIED", "SESSION_LOST", "APP_NOT_INSTALLED", "APP_BUSY", "APP_GONE", "NO_HELPER", "TIMEOUT", "SPAWN", "UNKNOWN_APP"]);

/** A transport failure as one plain sentence for the person (and the AI). */
export function plainError(app: string, err: unknown): { message: string; code: string } {
  const label = labelOf(app);
  const code = errorCode(err) || "APP_ERROR";
  const msg = errorMessage(err);
  if (code === "STOPPED" || msg === "stopped") return { message: `Stopped before ${label} answered. The step may still finish inside the app, so check before retrying.`, code: "STOPPED" };
  if (PLAIN_CODES.has(code)) return { message: msg, code };
  const kind = classify(msg);
  if (kind === "timeout") {
    return { message: `${label} didn't answer in time. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.`, code: "TIMEOUT" };
  }
  if (kind === "crash") return { message: `${label} stopped answering. It may have crashed or quit; open it again, then try again.`, code: "APP_GONE" };
  // What the app said, without the transport's wrapping and numbers.
  const said = msg
    .replace(/^.*?\(osascript exit -?\d+\):\s*/s, "")
    .replace(/^.*?error \((COM|[A-Z_0-9]+)\):\s*/s, "")
    .replace(/^\d+:\d+: execution error:\s*/i, "")
    .replace(/^.*?got an error:\s*/i, "")
    .replace(/\s*\(-?\d+\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { message: said ? `${label} couldn't run the script: ${said.replace(/\.$/, "")}.` : `${label} couldn't run the script.`, code: "APP_ERROR" };
}

/** An app's "Line: N->" (a script that didn't compile, on a Mac) as the line in the code that
 *  was sent: "(line n): <the code there>". Unchanged when the line isn't in the code. */
export function codeLine(message: string, wrapped: string | undefined, code: string): string {
  const base = wrapped ? codeLineBase(wrapped) : null;
  if (base == null) return message;
  return message.replace(/[.\s]*Line: (\d+)\s*->\s*/, (all, n: string) => {
    const at = Number(n) - base;
    return at >= 1 && at <= code.split("\n").length ? ` (line ${at}): ` : all;
  });
}

export function createRunner({ transport, scratch, incidents, aeDialogPollMs = 2000 }: { transport: ScriptTransport; scratch: Scratch; incidents: IncidentLog; aeDialogPollMs?: number }): Runner {
  const aeReady = createAeReady(transport);

  // Script errors inside the app go to the incident log too (as the app said them); the AI
  // gets the error with a hint after it when it's a common one (hints.ts).
  function noted(app: string, env: Envelope, code: string): Envelope {
    if (env && env.ok === false) {
      incidents.record({ app, kind: env.code ? "blocked" : "script-error", code: env.code, message: env.error, script: code });
      if (!env.code && env.error) return { ...env, error: withHint(app, env.error) };
    }
    return env;
  }

  async function failed(app: string, err: unknown, code: string, wrapped?: string): Promise<Envelope> {
    await incidents.failure(app, err, code);
    const p = plainError(app, err);
    let message = p.message;
    // A syntax error stops the whole script before the envelope runs, so the app gives the
    // line in the whole script ("Line: 41->"): put it in the code's own lines.
    if (p.code === "APP_ERROR") message = withHint(app, codeLine(message, wrapped, code));
    return { ok: false, error: message, code: p.code, logs: [], data: null };
  }

  return {
    aeReady,

    // Illustrator / Photoshop: the result comes back as the script's value. On Windows the
    // code is compiled with eval inside the envelope (as After Effects' always is), so a
    // syntax error comes back as an error with its message and line, not a bare COM error.
    async stdout(app, code, { timeoutMs, signal, guard } = {}) {
      let raw: string;
      let source: string | undefined;
      try {
        source = wrap(code, { viaEval: transport.platform === "win", guard });
        raw = await transport.runJsx(app, source, { via: "stdout", timeoutMs, signal });
      } catch (e) {
        return failed(app, e, code, source);
      }
      return noted(app, parseEnvelope(raw, labelOf(app)), code);
    },

    // After Effects: no return channel; the script writes its result to a file.
    async file(app, code, { timeoutMs, signal, guard, dialogWaitMs = 0, onWait } = {}) {
      // Never send After Effects a script while it's starting or showing a dialog. A step waits
      // for a dialog that's up (the person's) to close, saying so, then goes ahead.
      let ready = await aeReady();
      if (!ready.ok && ready.code === "AE_DIALOG" && dialogWaitMs > 0) {
        const until = Date.now() + dialogWaitMs;
        let said = "";
        while (!ready.ok && ready.code === "AE_DIALOG" && Date.now() < until && !signal?.aborted) {
          const text = theirDialogText(app, ready.dialog ?? null);
          if (text !== said) { said = text; try { onWait?.(text); } catch { /* the listener's own */ } }
          await new Promise((r) => setTimeout(r, aeDialogPollMs));
          ready = await aeReady();
        }
        if (said) try { onWait?.(null); } catch { /* the listener's own */ }
      }
      if (!ready.ok) return noted(app, { ok: false, error: ready.message || "After Effects isn't ready.", code: ready.code, logs: [], data: null }, code);
      const out = scratch.name("result", "json");
      try {
        await transport.runJsx(app, wrap(code, { write: out, viaEval: true, guard }), { via: "file", timeoutMs, signal });
      } catch (e) {
        rmQuiet(out);
        return failed(app, e, code);
      }
      if (!existsSync(out)) {
        // DoScript returns at once without running anything while a dialog is up.
        if (await modalDialogUp(transport, app)) {
          return noted(
            app,
            { ok: false, error: "After Effects is showing a dialog, and won't run scripts until it's closed. Close it in After Effects, then try again.", code: "AE_DIALOG", logs: [], data: null },
            code,
          );
        }
        // The usual cause: After Effects blocks scripts from writing files until "Allow
        // Scripts to Write Files and Access Network" is on (it's off by default), and the
        // result comes back through a file.
        return noted(
          app,
          {
            ok: false,
            error: `After Effects ran the script but couldn't hand the result back. In After Effects, open ${transport.aeScriptSettings} and turn on "Allow Scripts to Write Files and Access Network", then try again.`,
            code: "AE_SCRIPT_FILES",
            logs: [],
            data: null,
          },
          code,
        );
      }
      const raw = readFileSync(out, "utf8").replace(/^﻿/, "").trim();
      rmQuiet(out);
      return noted(app, parseEnvelope(raw, labelOf(app)), code);
    },
  };
}
