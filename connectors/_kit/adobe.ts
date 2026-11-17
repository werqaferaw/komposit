// What the connectors share: the context they're built with, status, dialogs, pictures and
// the call options. Illustrator, Photoshop and After Effects send their scripts through the
// transport; Premiere Pro sends them through its own panel (premiere/door.ts) and uses the
// rest (process facts, scratch folder, incident log, dialog watch, output rules).
import type { AppStatus, DocRef, Platform } from "../../protocol/common.ts";
import type { FileResult, Picture, RunResult } from "../../protocol/connector.ts";
import { agentMayPress, createDialogWatcher, dialogText, hasModal, layersMeanDialog, modalWindow, readDialog } from "./dialogwatch.ts";
import type { DialogWatcher } from "./dialogwatch.ts";
import type { Envelope } from "./envelope.ts";
import { outputFolder, safeBase, uniquePath } from "./files.ts";
import type { OutputRules } from "./files.ts";
import { createIncidentLog } from "./incidents.ts";
import type { IncidentLog, OnIncident } from "./incidents.ts";
import { createMacTransport } from "./mac.ts";
import { createRunner } from "./runner.ts";
import type { Runner } from "./runner.ts";
import { createScratch } from "./scratch.ts";
import type { Scratch } from "./scratch.ts";
import { KitError, errorCode, errorMessage, labelOf } from "./transport.ts";
import type { ScriptTransport } from "./transport.ts";
import { createWinTransport } from "./win.ts";

export interface ConnectorOptions {
  /** How scripts reach the apps. Default: AppleScript on a Mac, COM on Windows. Tests pass a fake. */
  transport?: ScriptTransport;
  /** Scratch folder for renders and result files. Default: <temp>/komposit. */
  scratchDir?: string;
  /** Where incidents go (an app that hung, crashed or threw). Default: nowhere. */
  onIncident?: OnIncident;
  /** Default folder for exports. Default: ~/Komposit Exports. */
  exportDir?: string;
  /** The home folder; exports stay inside it or a project folder. Default: os.homedir(). */
  home?: string;
  /** Project folders exports may also go into. */
  allowedRoots?: () => string[];
  /** Longest side of a render, in pixels. Default: 1024. */
  renderMaxPx?: number;
  /** The native helper (komposit-helper on a Mac, komposit-win.exe on Windows). */
  helperPath?: string;
  /** KompositWin.cs, to compile the Windows helper when none is built. */
  helperSource?: string;
  /** Where After Effects keeps its prefs (tests). */
  aePrefsDir?: string;
  /** Premiere Pro: the file its panel writes its address to. Default: premiere-panel.json
   *  under "dev.werq.komposit" in the person's application data. */
  premierePanelFile?: string;
  /** Premiere Pro: the CEP extensions folder its panel is installed in (to say why it isn't
   *  answering). Default: the person's own. */
  cepExtensionsDir?: string;
  /** Premiere Pro: reads CEP's PlayerDebugMode, for the same. Default: the system's setting. */
  cepDebugMode?: { read(): Promise<boolean> };
  /** Is the person in this app right now (core/runtime/frontapp.ts)? A dialog that comes up
   *  then is theirs: Komposit waits and never presses it. Default: never. */
  personIn?: (app: string) => boolean;
}

/** Optional last argument of the slow calls. Not in protocol/connector.ts yet. */
export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** A plain sentence while the app shows a dialog that blocks the step; null once it's gone. */
  onWait?: (reason: string | null) => void;
  /** The step's name in the app's undo history ("Komposit: Recolour the title"), for edits. */
  label?: string;
}

export interface Kit {
  platform: Platform;
  transport: ScriptTransport;
  scratch: Scratch;
  runner: Runner;
  incidents: IncidentLog;
  dialogs: DialogWatcher;
  rules: OutputRules;
  renderMaxPx: number;
}

export function createKit(platform: Platform, opts: ConnectorOptions = {}): Kit {
  const scratch = createScratch(opts.scratchDir);
  const transport =
    opts.transport ||
    (platform === "win"
      ? createWinTransport({ scratch, helperPath: opts.helperPath, helperSource: opts.helperSource, aePrefsDir: opts.aePrefsDir })
      : createMacTransport({ scratch, helperPath: opts.helperPath, aePrefsDir: opts.aePrefsDir }));
  const incidents = createIncidentLog(opts.onIncident, (app) => transport.isAppRunning(app));
  return {
    platform,
    transport,
    scratch,
    runner: createRunner({ transport, scratch, incidents }),
    incidents,
    dialogs: createDialogWatcher(transport, { ...(opts.personIn ? { personIn: opts.personIn } : {}) }),
    rules: { exportDir: opts.exportDir, home: opts.home, allowedRoots: opts.allowedRoots, platform },
    renderMaxPx: Number(opts.renderMaxPx) > 0 ? Number(opts.renderMaxPx) : 1024,
  };
}

/** The envelope's data, or a KitError with its plain message. */
export function dataOf<T = any>(env: Envelope): T {
  if (!env.ok) throw new KitError(env.error || "The app didn't say what went wrong.", env.code);
  return env.data as T;
}

/** An envelope as the contract's RunResult (with a part the step made, from the guard). */
export function runResult(env: Envelope): RunResult {
  const made = env.ok ? madeOf(env.facts?.made) : null;
  return { ok: env.ok, ...(env.ok ? { result: env.data } : {}), ...(env.error ? { error: env.error } : {}), logs: env.logs || [], ...(made ? { made } : {}) };
}

function madeOf(v: unknown): { id: string; name: string } | null {
  if (!v || typeof v !== "object") return null;
  const m = v as { id?: unknown; name?: unknown };
  return m.id != null && typeof m.name === "string" ? { id: String(m.id), name: m.name } : null;
}

/** A new file's path. The folder is checked first, so a refused folder never reaches the
 *  app; the document's name is only asked for when no name was given. */
export async function outputPath(
  kit: Kit,
  { outputDir, name, ext, fallback }: { outputDir?: string; name?: string; ext: string; fallback?: string },
  docName?: () => Promise<string>,
): Promise<string> {
  const folder = outputFolder(outputDir, kit.rules);
  return uniquePath(folder, safeBase(name || (docName ? await docName() : ""), fallback), ext);
}

/** A thrown error as a FileResult. */
export function fileFailure(e: unknown): FileResult {
  return { ok: false, error: errorMessage(e) };
}

/** Run `fn` with the dialog watch on, when the caller wants to hear about dialogs. */
export async function watching<T>(kit: Kit, app: string, call: CallOptions | undefined, fn: () => Promise<T>): Promise<T> {
  const stop = call?.onWait ? kit.dialogs.watch(app, (text) => call.onWait?.(text)) : null;
  try {
    return await fn();
  } finally {
    if (stop) stop();
  }
}

// PNG: width and height are the first two fields of IHDR (bytes 16-23, big-endian).
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

export function pngPicture(bytes: Uint8Array): Picture {
  const size = pngSize(bytes);
  return { bytes, mime: "image/png", ...(size || {}) };
}

/** A DocRef for the ExtendScript side: only plain strings. */
export function refLiteral(doc?: DocRef): string {
  if (!doc) return "null";
  const part = doc.part?.name ? { id: doc.part.id != null ? String(doc.part.id) : null, name: String(doc.part.name) } : null;
  return JSON.stringify({ name: String(doc.name || ""), path: doc.path ? String(doc.path) : null, id: doc.id != null ? String(doc.id) : null, part });
}

const MOD_DEVICE: Record<Platform, string> = { mac: "Mac", win: "PC" };

// Ready means: running, allowed, free of dialogs (a dialog holds every script; Photoshop can
// open with "Scratch Disk Low" up, live test Nov 16) and (After Effects) started and able to
// hand results back. No script is sent to find out.
export async function appStatus(kit: Kit, app: string): Promise<AppStatus> {
  const label = labelOf(app);
  const t = kit.transport;
  const [installedPath, running] = await Promise.all([t.installedPath(app).catch(() => null), t.isAppRunning(app).catch(() => false)]);
  const installed = !!installedPath || running;
  const base: AppStatus = { app, label, installed, running, ready: false };
  if (!running) return { ...base, reason: installed ? `${label} isn't open.` : `${label} isn't installed on this ${MOD_DEVICE[kit.platform]}.` };
  const auth = await t.automationState(app).catch(() => "unknown");
  if (auth === "denied") {
    return { ...base, reason: `Komposit isn't allowed to control ${label}. Turn it on in System Settings > Privacy & Security > Automation.` };
  }
  if (app === "aftereffects") {
    const r = await kit.runner.aeReady({ waitMs: 0 });
    if (!r.ok) {
      const reason = r.code === "AE_DIALOG" ? "After Effects is showing a dialog, and won't run scripts until it's closed." : r.message;
      return { ...base, reason };
    }
    if (t.aeScriptWrites() === false) {
      return {
        ...base,
        reason: `After Effects' scripting setting is off: turn on "Allow Scripts to Write Files and Access Network" in ${t.aeScriptSettings}.`,
      };
    }
  } else {
    const modal = modalWindow(await t.appWindows(app).catch(() => null));
    if (modal) {
      // A modal-layer window is only a guess (Illustrator keeps one up all the time): the AI
      // is told the app is blocked only when the system lists a dialog, the window has a
      // title, or the system can't look.
      const read = await readDialog(t, app);
      if (layersMeanDialog(app, read, modal)) {
        const title = modal.title || read.info?.title;
        return { ...base, reason: `${label} is showing a dialog${title ? ` (${title})` : ""}, and won't run scripts until it's closed.` };
      }
    }
  }
  return { ...base, ready: true };
}

// Read or answer a dialog that blocks the app. The agent may only acknowledge or cancel:
// what saves, discards or replaces work is the person's to answer. And only a dialog a Komposit
// step caused: one that was up before the step, or came up while the person was in the app, is
// theirs (`theirs`), and nothing is pressed in it. Esc is a Cancel button where the dialog has
// one; a key is only sent to an app that's already in front (Komposit never brings it forward
// to send one: the person may be working in another app).
export async function answerOrRead(kit: Kit, app: string, action: "read" | "press", button?: string): Promise<{ ok: boolean; text?: string; buttons?: string[]; theirs?: boolean }> {
  const label = labelOf(app);
  const read = await readDialog(kit.transport, app);
  const info = read.info;
  const up = !!info || (hasModal(await kit.transport.appWindows(app).catch(() => null)) && layersMeanDialog(app, read));
  const theirs = up && (await kit.dialogs.whose(app)) === "person";
  const mark = theirs ? { theirs: true } : {};
  if (action === "read") {
    if (info?.denied) {
      return { ok: false, text: `${label} may be showing a dialog, but Komposit can't read dialogs until it's allowed under System Settings > Privacy & Security > Accessibility.`, buttons: [], ...mark };
    }
    const whose = theirs ? ` It's the person's (it was up before Komposit's step, or came up while they were working in ${label}): don't press anything in it; wait for them, or tell them what it asks.` : "";
    if (!info) {
      return { ok: true, text: up ? dialogText(app, null) + whose : `${label} isn't showing a dialog Komposit can see, so it's ready for scripts.`, buttons: [], ...mark };
    }
    return { ok: true, text: dialogText(app, info) + whose, buttons: info.buttons, ...mark };
  }
  const b = String(button || "").trim();
  if (!b) return { ok: false, text: "Say which button to press." };
  if (theirs) return { ok: false, text: `${label}'s dialog is the person's (it was up before Komposit's step, or came up while they were working in ${label}), so Komposit doesn't press anything in it. Wait for them to close it, or tell them what it asks.`, theirs: true };
  if (!agentMayPress(b)) return { ok: false, text: `"${b}" saves, discards or replaces work, so it's the person's to press. Ask them to answer the dialog.` };
  if (!kit.transport.answerDialog) return { ok: false, text: `Komposit can't answer ${label}'s dialogs on this computer yet. Ask the person to answer it.` };
  const esc = /^(esc|escape)$/i.test(b);
  const cancel = esc ? info?.buttons.find((x) => /^cancel$/i.test(x.trim())) : undefined;
  const how = esc && !cancel ? { key: "escape" as const } : { button: cancel || b };
  const r = await kit.transport.answerDialog(app, how).catch((e) => ({ ok: false, reason: errorMessage(e) }));
  if (r.ok) return { ok: true, text: `Pressed "${cancel || b}" in ${label}'s dialog.` };
  if (r.reason === "not in front") return { ok: false, text: `Komposit only sends Esc to ${label} when it's already in front, and it isn't (the person may be working elsewhere). Press a button by name, or ask the person to close it.` };
  if (r.reason === "no such button") return { ok: false, text: `${label}'s dialog has no "${b}" button.${info?.buttons.length ? ` Its buttons: ${info.buttons.join(", ")}.` : ""}` };
  return { ok: false, text: `Komposit couldn't press "${b}" in ${label}'s dialog. Ask the person to answer it.` };
}

/** Error code, for callers that branch on why (tests, the core's retry rules). */
export { errorCode };
