// A connector is one folder per creative app (connectors/<app>/). It knows how to reach
// its app (the "door") and how each toolbox verb is done there. The core never names an
// app: it loads connectors and talks to them through this interface.
import type { AppStatus, DocRef } from "./common.ts";

export type Door =
  | "vendor-mcp" // the app's own AI door (Affinity, Blender, Resolve, Adobe later)
  | "in-app-plugin" // Komposit's plugin inside the app (Premiere's CEP panel)
  | "os-script" // AppleScript on Mac / COM on Windows (Illustrator, Photoshop, After Effects)
  | "file-format"
  | "accessibility"
  | "screen";

export interface ConnectorManifest {
  id: string; // "illustrator"
  label: string; // "Illustrator"
  maker: string; // "Adobe"
  platforms: ("mac" | "win")[];
  door: Door;
  /** Language `run` code is written in. */
  language: "extendscript" | "javascript" | "python" | "lua" | "none";
  capabilities: {
    inspect: boolean;
    run: boolean;
    render: boolean;
    export: string[]; // formats, e.g. ["png", "jpg", "svg", "pdf"]
    save: string[]; // modes, e.g. ["copy", "overwrite", "as"]
    undo: boolean;
    selection?: boolean;
    preflight?: boolean;
    /** listen: hears sound on this computer. A file (ListenOptions.path) in any app that has
     *  it; a timeline (Premiere Pro's sequence, After Effects' comp) where there is one. */
    listen?: boolean;
    newDocument?: boolean;
    open?: boolean;
    place?: boolean;
    dialog?: boolean;
    /** Only one document can be open at a time (After Effects projects). */
    singleDocument?: boolean;
    /** undo reads the app's history and refuses a step that isn't Komposit's (Photoshop's
     *  history states carry Komposit's names). Without it the core decides from what it saw. */
    undoOwn?: boolean;
  };
  /** Tool names whose calls are heavy (renders, exports, an inspect that draws a picture) and go
   *  through the heavy-work governor. */
  heavy?: string[];
  /** What a document's part is called, when it has parts a request works in (DocRef.part):
   *  "comp" in After Effects, "sequence" in Premiere Pro. */
  partLabel?: string;
}

export interface Picture {
  /** PNG or JPEG bytes. */
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  width?: number;
  height?: number;
}

export interface RunResult {
  ok: boolean;
  /** Whatever the script returned. */
  result?: unknown;
  /** Plain sentence. */
  error?: string;
  logs?: string[];
  /** A new part of the document the code made and left on its own (After Effects: a comp that
   *  isn't a layer in another), by id: the request may go on in it. */
  made?: { id: string; name: string };
}

export interface FileResult {
  ok: boolean;
  path?: string;
  /** What the file is good for. */
  note?: string;
  warnings?: string[];
  error?: string;
  /** True when the open document was left exactly as it was. */
  sourceUnchanged?: boolean;
}

export interface ListenOptions {
  /** A media file to listen to (absolute path) instead of the timeline. */
  path?: string;
  /** From this second (default: the start). */
  from?: number;
  /** Up to this second (default: the end). */
  to?: number;
  /** The shortest pause worth listing, seconds (default 0.6). */
  pauses?: number;
}

export interface ListenResult {
  /** What was heard, in plain numbers, for the AI. */
  text: string;
  /** The sound as a picture: one row per track, beats and sections marked. */
  picture?: Picture;
  /** The same facts as data (what edits get as K.heard). */
  heard?: unknown;
}

/** How Komposit's steps start in an app's undo history ("Komposit: Recolour the title"), so they
 *  can be told from the person's own. */
export const UNDO_LABEL = "Komposit: ";

/** Optional last argument of the slow calls (run, render, exportCopy). */
export interface ConnectorCallOptions {
  /** Stops the call (the script itself may still finish inside the app). */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** A plain sentence while the app shows a dialog that blocks the call; null once it's gone. */
  onWait?: (reason: string | null) => void;
  /** The step's name in the app's undo history, for edits ("Komposit: Recolour the title"):
   *  where the app can, the whole edit is one undo step with this name. */
  label?: string;
}

export interface Connector {
  manifest: ConnectorManifest;
  status(): Promise<AppStatus>;
  /** `comps`: an After Effects project's compositions (its one document is the project).
   *  `sequences`: a Premiere Pro project's sequences. The active document's `part` is the one
   *  being viewed (After Effects' active comp, Premiere Pro's active sequence): a request fixes
   *  it at its first step there (DocRef.part). */
  documents(): Promise<(DocRef & { active: boolean; comps?: string[]; sequences?: string[] })[]>;
  /** A text map of the document (with refs the AI can use in code) and usually a picture. */
  inspect(doc?: DocRef): Promise<{ text: string; picture?: Picture }>;
  selection?(doc?: DocRef): Promise<{ summary: string; data?: unknown }>;
  /** Run code in the app's own language against the document. Never saves. */
  run(code: string, doc?: DocRef, call?: ConnectorCallOptions): Promise<RunResult>;
  /** `pictures`: every frame when several were asked for (`picture` is the middle one). */
  render(doc?: DocRef, opts?: { frames?: number; video?: boolean }, call?: ConnectorCallOptions): Promise<{ picture?: Picture; pictures?: Picture[]; videoPath?: string; note?: string }>;
  /** Writes a NEW file; never overwrites, never repoints the open document. */
  exportCopy(opts: { doc?: DocRef; format: string; name?: string; outputDir?: string; options?: Record<string, unknown> }, call?: ConnectorCallOptions): Promise<FileResult>;
  /** Only when the person asked to save. */
  save(opts: { doc?: DocRef; mode: string; name?: string; outputDir?: string }): Promise<FileResult>;
  undo(doc?: DocRef, steps?: number): Promise<RunResult>;
  preflight?(doc?: DocRef): Promise<{ text: string; issues: unknown[] }>;
  /** Hear sound: one media file (`path`, in the file's own seconds), or the document's
   *  timeline (the request's sequence or comp, in its seconds). Read-only: measured on this
   *  computer, nothing changes in the app. What it heard stays with the connector for the next
   *  edits (K.heard). */
  listen?(opts: ListenOptions, doc?: DocRef, call?: ConnectorCallOptions): Promise<ListenResult>;
  /** After Effects makes a comp in the open project: it returns the project, with `comp`. */
  /** `seconds`: the length of a new After Effects comp (other apps ignore it). */
  newDocument?(opts: { width?: number; height?: number; name?: string; seconds?: number }): Promise<DocRef & { comp?: string }>;
  open?(path: string): Promise<DocRef>;
  /** Bring a file from elsewhere into a document (Illustrator art into Photoshop, etc.). */
  place?(opts: { file: string; into?: DocRef; linked?: boolean }): Promise<FileResult>;
  /** Known-good recipes for the AI, by topic; no topic = the index. */
  guide?(topic?: string): Promise<string>;
  /** "Show in <App>": bring the app forward with this document in front (the person asked to
   *  see it). Without `doc`, the app as it is. Changes nothing in the document. */
  show?(doc?: DocRef): Promise<void>;
  /** Read or answer a dialog that blocks the app. `theirs`: the dialog is the person's (up
   *  before Komposit's step, or it came up while they were in the app): nothing is pressed. */
  dialog?(action: "read" | "press", button?: string): Promise<{ ok: boolean; text?: string; buttons?: string[]; theirs?: boolean }>;
  /** Komposit's own plugin inside the app (door "in-app-plugin": Premiere Pro's panel). Its
   *  state is in status().plugin. Called only when the person presses Install, Update or Remove. */
  plugin?: AppPlugin;
}

export interface AppPlugin {
  /** Copies the plugin in (or replaces an older copy) and lets the app load it. The app loads
   *  it at its next start. Throws a plain sentence when it can't. */
  install(): Promise<void>;
  /** Takes it out again. */
  remove(): Promise<void>;
}
