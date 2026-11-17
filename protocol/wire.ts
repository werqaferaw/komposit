// What the window (and later the phone) can ask the core, and what the core pushes back.
// Carried as JSON-RPC 2.0 messages (see rpc.ts) over any Transport: a MessagePort inside
// the app, the sealed relay for the phone, or memory in tests.
import type { AiId, AppStatus, DocRef, Effort, MediaRef, Platform } from "./common.ts";
import type { ChatEvent } from "./events.ts";

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
  ai: AiId;
  /** Apps this chat may use; null = every app. */
  apps: string[] | null;
  running: boolean;
  lastSeq: number;
}

export interface SendParams {
  /** Omit to start a new chat. */
  chatId?: string;
  text: string;
  /** Files the person attached: a path on this computer, or media already in the record. */
  attachments?: { path?: string; mediaId?: string; name?: string; role?: "use" | "ref" }[];
  ai?: AiId;
  effort?: Effort;
  apps?: string[] | null;
  projectId?: string;
  /** The document the file chip points this message at. */
  doc?: DocRef;
}

export interface RecentFile {
  path: string;
  name: string;
  app?: string;
  usedAt: number;
  thumb?: MediaRef;
}

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  hasBrief: boolean;
  /** False when the folder isn't there any more (moved, renamed, or its drive is out). */
  exists?: boolean;
}

/** One app's open documents, for the file chip and "@" (docs.open). `state`: "open" (its
 *  documents, the one in front `active`; maybe none), "busy" (working on a step, so it wasn't
 *  asked; ask again in a moment), "closed" (not running; never asked, since asking would open
 *  it), "unavailable" (running but out of reach: a dialog, a permission; `reason` says which). */
export interface OpenDocsEntry {
  app: string;
  label: string;
  state: "open" | "busy" | "closed" | "unavailable";
  docs: (DocRef & { active: boolean })[];
  reason?: string;
}

/** One running chat, as every AI and the window see it. */
export interface BoardEntry {
  chatId: string;
  title: string;
  app?: string;
  doc?: DocRef;
  step?: string;
  since: number;
}

export interface AiStatus {
  id: AiId;
  label: string;
  available: boolean;
  signedIn?: boolean;
  plan?: string;
  version?: string;
  /** One plain sentence when it can't be used yet. */
  reason?: string;
  /** Installed but can't start (an update that didn't finish); `reinstall` is the command that fixes it. */
  broken?: boolean;
  reinstall?: string;
  /** "plan": the person's own AI program on their own plan (Claude Code, Codex, Gemini CLI).
   *  "key": Komposit's own loop on the person's API key, which stays on this computer. */
  kind?: "plan" | "key";
  /** An API key AI: the model it runs, and the provider's current models to offer. */
  model?: string;
  models?: string[];
  /** An API key AI with a key saved: its last four characters, to recognise it by (never more). */
  keyHint?: string;
}

/** What saving, testing or removing an API key answers. `message`: one plain sentence (why it
 *  didn't work, or which model it will run). The key itself never comes back. */
export interface KeyResult {
  ok: boolean;
  message?: string;
  /** The AI's status after it. */
  status?: AiStatus;
}

export interface AccountInfo {
  signedIn: boolean;
  email?: string;
  name?: string;
  /** The person's picture as a data: URL (the core fetches it from the gateway). */
  picture?: string;
  /** One plain sentence when the account changed by itself (the sign-in ended). */
  note?: string;
}

export interface Settings {
  ai: AiId;
  effort: Effort;
  theme: "light" | "dark" | "system";
  onboarded: boolean;
  /** One anonymous count per message to Komposit's gateway (which apps, which AI, how it ended,
   *  roughly how long; never who, what was written or any file). On unless the person turns it
   *  off; off sends nothing. */
  usageStats?: boolean;
  /** The small progress window over the person's apps while a request runs. On unless false. */
  overlay?: boolean;
  [key: string]: unknown;
}

/** The `data` of a call refused because the person isn't signed in: `chats.send` and
 *  `apps.newDocument` (anything that runs the AI or works in an app) need an account; everything
 *  else can be looked at signed out. The error's message is the plain sentence to show. The
 *  window shows the sign-in card where the person is and keeps what they typed. */
export const SIGN_IN_REFUSAL = "signin";
export interface RefusalData { kind: typeof SIGN_IN_REFUSAL }

/** Is this error (from a call) a refusal for sign-in? */
export function refusedForSignIn(e: unknown): boolean {
  const data = (e as { data?: unknown } | null)?.data as Partial<RefusalData> | undefined;
  return !!data && typeof data === "object" && data.kind === SIGN_IN_REFUSAL;
}

export interface FileEntry { name: string; path: string; kind: "file" | "folder"; app?: string }

export interface Methods {
  /** `features` includes "signin": using Komposit (sending, making documents) needs an account. */
  hello: { params: { client: "window" | "phone" | "test"; version: string }; result: { version: string; platform: Platform; features: string[] } };

  "chats.list": { params: { projectId?: string; limit?: number }; result: ChatSummary[] };
  "chats.get": { params: { chatId: string }; result: ChatSummary };
  "chats.events": { params: { chatId: string; since?: number }; result: ChatEvent[] };
  "chats.send": { params: SendParams; result: { chatId: string; turnId: string; queued: boolean } };
  "chats.stop": { params: { chatId: string }; result: { stopped: boolean } };
  /** A message waiting in the queue (not one already handed to the running AI): "edit" takes it
   *  back out (an 'unqueued' event, why "edit", so the window puts it back in the box), "remove"
   *  drops it, "now" stops the running request and sends it at once (the rest of the queue
   *  follows). `ok` false: it isn't waiting any more (it went, or was handed to the AI). */
  "chats.queue": { params: { chatId: string; queueId: string; action: "edit" | "remove" | "now" }; result: { ok: boolean } };
  "chats.rename": { params: { chatId: string; title: string }; result: { ok: true } };
  "chats.delete": { params: { chatId: string }; result: { ok: true } };
  "chats.setApps": { params: { chatId: string; apps: string[] | null }; result: { ok: true } };
  "chats.setProject": { params: { chatId: string; projectId: string | null }; result: { ok: true } };

  "asks.answer": { params: { askId: string; optionId: string }; result: { ok: boolean } };
  "board.get": { params: Record<string, never>; result: BoardEntry[] };

  "workspace.get": { params: Record<string, never>; result: { apps: AppStatus[]; recent: RecentFile[] } };
  "files.list": { params: { dir?: string }; result: { dir: string; entries: FileEntry[] } };
  "files.open": { params: { path: string }; result: { ok: boolean; message?: string } };
  /** Shows a file selected in its folder (Finder, Explorer). Only in places Komposit reads and
   *  writes (the home folder, design folders, projects); anything else gets a plain sentence. */
  "files.reveal": { params: { path: string }; result: { ok: boolean; message?: string } };
  /** What's open in each app (or in `app` only), in the core's order of apps, for pointing a
   *  message at a file. Read through each app's lane with a time limit; an app busy with a step
   *  answers "busy" instead of making anyone wait. Looking, so no account is needed. */
  "docs.open": { params: { app?: string }; result: OpenDocsEntry[] };
  /** "Show in <App>": brings the app forward with this document in front (without `doc`, the
   *  app as it is). Through the app's lane, so it never lands in the middle of a step. */
  "docs.show": { params: { app: string; doc?: DocRef }; result: { ok: boolean; message?: string } };
  /** The window lost or got focus (the person went to one of their apps, or came back). The
   *  answer: the creative app they were in most recently, which "this" means under All apps. */
  "window.focus": { params: { focused: boolean }; result: { recentApp: string | null } };
  /** Opens the app itself (the apps panel's "Open"), or brings it to the front when it's running. */
  "apps.launch": { params: { app: string }; result: { ok: boolean; message?: string } };
  /** `seconds`: an After Effects comp's length. `doc`: the document that was made (After Effects:
   *  the project, with the new comp in `comp`), so the next message can go to it. */
  "apps.newDocument": { params: { app: string; width?: number; height?: number; seconds?: number }; result: { ok: boolean; message?: string; doc?: DocRef & { comp?: string } } };
  /** Komposit's own plugin inside an app that needs one (AppStatus.plugin: Premiere Pro's
   *  panel). "install" puts it in, or updates an older copy (only ever on the person's press);
   *  "remove" takes it out (Settings); "state" only reads. `status`: the app's status after it,
   *  fresh. `message`: one plain sentence when it didn't work. Needs no account. */
  "apps.plugin": { params: { app: string; action: "state" | "install" | "remove" }; result: { ok: boolean; message?: string; status: AppStatus } };

  "projects.list": { params: Record<string, never>; result: ProjectInfo[] };
  /** Without `root`, the core asks the shell to show a folder picker. Null when cancelled. */
  "projects.create": { params: { root?: string; name?: string }; result: ProjectInfo | null };
  "projects.get": { params: { projectId: string }; result: ProjectInfo & { files: RecentFile[] } };
  "projects.remove": { params: { projectId: string }; result: { ok: true } };

  /** `fresh`: check again now instead of using a recent answer (after signing in). */
  "ai.list": { params: { fresh?: boolean }; result: AiStatus[] };
  /** An API key for an AI that runs on one (kind "key": "api-anthropic", "api-openai",
   *  "api-gemini", "api-openrouter"). The key is checked with that provider, and only that
   *  provider, before it is kept (encrypted with this computer's keychain); it never goes to
   *  Komposit's servers and is never logged. Without `key`, the saved one stays and only `model`
   *  changes; `model` "" goes back to the provider's default. */
  "ai.setKey": { params: { ai: AiId; key?: string; model?: string }; result: KeyResult };
  /** Checks a key with its provider without keeping it (`key`), or the saved one (no `key`). */
  "ai.testKey": { params: { ai: AiId; key?: string; model?: string }; result: KeyResult };
  /** Forgets the saved key. */
  "ai.deleteKey": { params: { ai: AiId }; result: KeyResult };
  "account.get": { params: Record<string, never>; result: AccountInfo };
  /** Opens the system browser for Google, through Komposit's gateway; resolves signed in, or
   *  fails with a plain sentence when it didn't finish (cancelled, too slow, unavailable). */
  "account.signIn": { params: Record<string, never>; result: AccountInfo };
  /** Ends the session at the gateway, then forgets it here. */
  "account.signOut": { params: Record<string, never>; result: AccountInfo };

  "settings.get": { params: Record<string, never>; result: Settings };
  "settings.set": { params: Partial<Settings>; result: Settings };

  /** For clients that can't use komposit-media:// (the phone). */
  "media.get": { params: { id: string }; result: { mime: string; base64: string } };
  /** Keeps a pasted or dropped picture (no path on disk) so it can go with a message as
   *  `attachments: [{ mediaId }]`. Kinds: those in MEDIA_EXT. */
  "media.put": { params: { name?: string; mime: string; base64: string }; result: MediaRef };
}

export interface Notifications {
  event: ChatEvent;
  "chats.changed": { chatId: string };
  "board.changed": BoardEntry[];
  "workspace.changed": Record<string, never>;
  "account.changed": AccountInfo;
}

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]["params"];
export type Result<M extends Method> = Methods[M]["result"];
