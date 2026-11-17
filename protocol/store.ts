// The record's interface (implemented in core/record with SQLite). Synchronous on purpose:
// one writer (the core), small rows, and SQLite is fastest that way.
import type { AiId, MediaRef, Usage } from "./common.ts";
import type { ChatEvent, ChatEventType } from "./events.ts";
import type { Settings } from "./wire.ts";

export interface ChatRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
  ai: AiId;
  effort: string;
  apps: string[] | null;
  /** Each adapter's session/thread id, to resume. */
  sessions: Record<string, string>;
  /** Imported from Komposit 1.0. */
  legacyId?: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  /** What the AI has already been shown of the project (so later turns send only changes). */
  seen?: Record<string, unknown>;
}

/** A script helper the AI keeps for a chat (edit's `helpers`): the names it defines, and its code. */
export interface ScriptHelper {
  names: string[];
  code: string;
}

export interface Store {
  chats: {
    create(init: Partial<ChatRow> & { ai: AiId }): ChatRow;
    get(id: string): ChatRow | undefined;
    list(opts?: { projectId?: string; limit?: number }): ChatRow[];
    update(id: string, patch: Partial<ChatRow>): ChatRow;
    delete(id: string): void;
  };
  events: {
    append<T>(chatId: string, type: ChatEventType, data: T, turnId?: string): ChatEvent<T>;
    since(chatId: string, seq?: number): ChatEvent[];
    lastSeq(chatId: string): number;
  };
  media: {
    put(bytes: Uint8Array, mime: string, name?: string): MediaRef;
    /** Absolute path of the stored file (for the komposit-media:// handler). */
    path(id: string): string | undefined;
    get(id: string): { bytes: Uint8Array; mime: string } | undefined;
  };
  settings: {
    get(): Settings;
    set(patch: Partial<Settings>): Settings;
  };
  projects: {
    create(init: { name: string; root: string }): ProjectRow;
    get(id: string): ProjectRow | undefined;
    list(): ProjectRow[];
    update(id: string, patch: Partial<ProjectRow>): ProjectRow;
    remove(id: string): void;
  };
  approvals: {
    grant(projectId: string, kind: string, scope: string): void;
    has(projectId: string, kind: string, scope: string): boolean;
  };
  /** The AI's own message history, byte-exact (Claude rejects edited history). */
  aiHistory: {
    append(chatId: string, adapter: string, entries: string[]): void;
    read(chatId: string, adapter: string): string[];
  };
  /** Each chat's script helpers, per app. Deleted with the chat. */
  helpers: {
    get(chatId: string, app: string): ScriptHelper[];
    set(chatId: string, app: string, list: ScriptHelper[]): void;
  };
  usage: {
    add(row: { chatId: string; turnId: string; ai: string; usage?: Usage; ms: number; outcome: string }): void;
    totals(sinceMs?: number): { turns: number; inputTokens: number; outputTokens: number };
  };
  close(): void;
}
