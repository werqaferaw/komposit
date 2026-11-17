// The transport: how a script reaches an Adobe app on this operating system, and the few
// process and window facts the connectors need around it. One interface, two
// implementations (mac.ts: AppleScript; win.ts: COM through komposit-win.exe and
// AfterFX.exe), and a fake in the tests. Nothing else in connectors/ runs osascript,
// pgrep, tasklist or COM.
import type { Platform } from "../../protocol/common.ts";

/** One of an app's windows. Layer 8 is a modal dialog, 0 a normal window, on both systems. */
export interface WindowInfo {
  w: number;
  h: number;
  layer: number;
  title?: string;
}
export type WindowMap = Map<number, WindowInfo>;

/** A dialog or sheet as the system's accessibility layer reads it. */
export interface DialogBox {
  kind?: string;
  title?: string;
  text?: string[];
  buttons?: string[];
  fields?: number;
}
export interface DialogsRead {
  dialogs?: DialogBox[];
  /** The Accessibility permission is off, so nothing could be read. */
  denied?: boolean;
  error?: string;
}

export type AutomationState = "allowed" | "denied" | "ask" | "not-running" | "unknown";

export interface RunJsxOptions {
  /** "stdout": the app returns the script's last expression (Illustrator, Photoshop).
   *  "file": the app returns nothing and the script writes its result file (After Effects). */
  via?: "stdout" | "file";
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ScriptTransport {
  readonly platform: Platform;
  /** Where After Effects' "Allow Scripts to Write Files and Access Network" lives, in the app's menus. */
  readonly aeScriptSettings: string;
  /** Run an ExtendScript source string in the app. Resolves with what the app returned (stdout);
   *  rejects with an Error whose message is a plain sentence where the cause is known, and a
   *  `code` such as AUTOMATION_DENIED, SESSION_LOST, APP_NOT_INSTALLED, APP_BUSY, APP_GONE. */
  runJsx(app: string, source: string, opts?: RunJsxOptions): Promise<string>;
  isAppRunning(app: string): Promise<boolean>;
  appPid(app: string): Promise<number | null>;
  /** Seconds since the process started (0 if unknown on a Mac, a large number on Windows). */
  processUptime(pid: number): Promise<number>;
  /** id -> window, or null when the list can't be read. */
  appWindows(app: string): Promise<WindowMap | null>;
  dialogs?(app: string): Promise<DialogsRead>;
  answerDialog?(app: string, how: { button?: string; key?: "return" | "escape" }): Promise<{ ok: boolean; reason?: string }>;
  /** A PNG of one window (a dialog that exposes no text). */
  dialogShot?(windowId: number): Promise<Uint8Array | null>;
  /** Where the app is installed, or null. */
  installedPath(app: string): Promise<string | null>;
  /** Bring the app to the front (starts it if it isn't running). Best effort. */
  activateApp(app: string): Promise<void>;
  /** The OS permission to control the app. Never asks: reading only. */
  automationState(app: string): Promise<AutomationState>;
  /** After Effects' "Allow Scripts to Write Files and Access Network" from its prefs file:
   *  true, false, or null when unknown. */
  aeScriptWrites(): boolean | null;
}

/** App ids of the scripting connectors. */
export type AdobeApp = "illustrator" | "photoshop" | "aftereffects";

export const LABEL: Record<string, string> = {
  illustrator: "Illustrator",
  photoshop: "Photoshop",
  aftereffects: "After Effects",
  premiere: "Premiere Pro",
};

export function labelOf(app: string): string {
  return LABEL[app] || app;
}

/** An Error with a machine-readable code beside its plain-sentence message. */
export class KitError extends Error {
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export function errorCode(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : undefined;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
