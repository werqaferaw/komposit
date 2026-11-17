// Things that went wrong inside the apps: an app that stopped answering, crashed, or
// threw while running a script, with the script that was running.
//
// It's for whoever improves the connectors, not for the model: nothing here is fed back
// into prompts automatically (a model-written "lesson" can be wrong and would then repeat
// forever). The core decides where incidents go (1.0 kept incidents.jsonl); a person reads
// them, confirms the pattern, and adds the fix to the app's guide.md by hand.
import { errorCode, errorMessage } from "./transport.ts";

export type IncidentKind = "timeout" | "crash" | "app-error" | "script-error" | "blocked";

export interface Incident {
  at: string;
  app: string;
  kind: IncidentKind;
  code?: string;
  message: string;
  script?: string;
}

export type OnIncident = (incident: Incident) => void;

export function appKey(target = ""): string {
  const t = String(target).toLowerCase();
  if (t.includes("illustrator")) return "illustrator";
  if (t.includes("photoshop")) return "photoshop";
  if (t.includes("after effects") || t.includes("aftereffects")) return "aftereffects";
  if (t.includes("premiere")) return "premiere";
  return t || "unknown";
}

// What kind of failure a transport error message describes (osascript on a Mac, COM or
// AfterFX.exe on Windows).
export function classify(message = ""): IncidentKind {
  const m = String(message);
  if (/didn't answer in time|-1712|timed out/i.test(m)) return "timeout";
  if (/-609|-903|connection is invalid|isn.t running|not running/i.test(m)) return "crash";
  if (/0x800706BA|0x80010108|RPC server is unavailable|disconnected from its clients/i.test(m)) return "crash";
  return "app-error";
}

// A long script keeps its start and its end: the code the AI wrote for the step is at the end,
// after the chat's helpers (edit's helpers go in front of it).
function clipScript(s: string): string {
  if (s.length <= 4000) return s;
  return `${s.slice(0, 1500)}\n/* ... ${s.length - 4000} characters left out ... */\n${s.slice(-2500)}`;
}

export interface IncidentLog {
  /** One incident. Never throws: logging must not break a turn. */
  record(i: { app: string; kind: IncidentKind; message?: string | null; script?: string; code?: string }): void;
  /** After a transport failure: log it, upgrading to "crash" if the app is gone. A person's
   *  stop and a declined permission aren't incidents. */
  failure(app: string, err: unknown, script?: string): Promise<void>;
}

export function createIncidentLog(onIncident: OnIncident | undefined, isRunning: (app: string) => Promise<boolean>): IncidentLog {
  const record: IncidentLog["record"] = ({ app, kind, message, script, code }) => {
    if (!onIncident) return;
    try {
      onIncident({
        at: new Date().toISOString(),
        app: appKey(app),
        kind,
        ...(code ? { code } : {}),
        message: String(message || "").slice(0, 2000),
        ...(script ? { script: clipScript(String(script)) } : {}),
      });
    } catch {}
  };
  return {
    record,
    async failure(app, err, script) {
      if (!onIncident) return;
      const code = errorCode(err);
      const message = errorMessage(err);
      if (code === "AUTOMATION_DENIED" || code === "STOPPED" || message === "stopped") return;
      let kind = classify(message);
      try {
        if (kind !== "crash" && !(await isRunning(appKey(app)))) kind = "crash";
      } catch {}
      record({ app, kind, message, code, script });
    },
  };
}
