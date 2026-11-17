// The record of a chat: an append-only list of events. The window, the phone, history,
// stats and debugging all read this same list. Events are numbered per chat (`seq`, from 1),
// so any client can catch up with `chats.events {since}` after a reconnect.
import type { MediaRef, Usage, DocRef } from "./common.ts";

export interface ChatEvent<T = unknown> {
  chatId: string;
  seq: number;
  ts: number;
  type: ChatEventType;
  turnId?: string;
  data: T;
}

export type ChatEventType =
  | "user_message"
  | "queued"
  | "unqueued"
  | "turn_started"
  | "note"
  | "text"
  | "step_started"
  | "step_waiting"
  | "step_finished"
  | "ask"
  | "ask_answered"
  | "result"
  | "final"
  | "error"
  | "turn_finished"
  | "title"
  | "apps_changed"
  | "project_changed";

export interface UserMessageData {
  text: string;
  attachments: MediaRef[];
  ai: string;
  effort: string;
  /** Set when this message waited in the queue first: the same id as its 'queued' event, so a
   *  client can swap the queued bubble for the message. */
  queueId?: string;
  /** The document the person pointed the message at (the file chip). */
  doc?: DocRef;
}
/** A message typed while a turn ran. `waits`: "step" when it went to the running AI, which reads
 *  it after the step it is on (plain words for the same AI and file); "turn" when it waits and
 *  becomes a request of its own once this one ends (attachments, another file, another AI).
 *  It carries what the composer had: attachments with their roles, and the file it points at. */
export interface QueuedData { text: string; position: number; queueId: string; attachments?: MediaRef[]; doc?: DocRef; waits?: "step" | "turn" }
/** Queued messages handed back to the person, to send again or change. `why`: the turn was
 *  stopped, interrupted (Komposit closed) or hit the AI's limit, or the person took one back to
 *  edit it ("edit": it goes back into the message box) or removed it ("remove": gone). */
export interface UnqueuedData {
  messages: { queueId?: string; text: string; attachments: MediaRef[]; doc?: DocRef }[];
  why?: "stopped" | "interrupted" | "limit" | "edit" | "remove";
}
export interface TurnStartedData { ai: string; effort: string; apps: string[] | null }
/** Progress text from the AI between steps ("Checking the layout"). */
export interface NoteData { text: string }
/** Streamed assistant text (may arrive in several pieces; the final event has the whole reply). */
export interface TextData { text: string }
export interface StepStartedData {
  stepId: string;
  tool: string;
  /** Plain-language label: "Looking at the document", "Exporting a PNG". */
  label: string;
  app?: string;
  doc?: DocRef;
  input?: unknown;
}
/** A step is waiting on something outside Komposit (a dialog in the app, the app's queue). */
export interface StepWaitingData { stepId: string; reason: string }
export interface StepFinishedData {
  stepId: string;
  ok: boolean;
  ms: number;
  /** The finished step in words ("Looked at the document"); it takes the started label's
   *  place, so a finished step reads as one line, as in 1.0. */
  label?: string;
  /** An extra detail under the label ("1080 × 1350, 6 layers"), when there is one. */
  summary?: string;
  /** Plain sentence; never an error code. */
  error?: string;
  media?: MediaRef[];
  /** Files the step wrote (an export, a saved copy, the document saved): the window lists them
   *  under Outputs in its Files panel. Absent when it wrote nothing (and on older records). */
  files?: OutputFile[];
}
/** A file a step wrote, as the app reported it. */
export interface OutputFile {
  path: string;
  /** "export": a new file from the document (PNG, PDF...); "save": the document itself, or a
   *  copy of it, in its app's own format. */
  kind: "export" | "save";
  /** The format, from the name: "pdf", "png", "ai". */
  format: string;
  bytes?: number;
  /** What the app said the file is good for, when it said. */
  note?: string;
  /** An exported picture, kept in the record so the window can show the file itself. */
  preview?: MediaRef;
}
export interface AskOption { id: string; label: string; recommended?: boolean }
export interface AskData {
  askId: string;
  kind: "approval" | "choice" | "app" | "question";
  question: string;
  options: AskOption[];
  detail?: string;
}
/** `by`: who settled it. "timeout" = nobody answered in time; "stopped" = the turn was stopped
 *  or ended first. Both mean the default (safe) option stood. */
export interface AskAnsweredData { askId: string; optionId: string; by: "window" | "phone" | "timeout" | "stopped" }
/** The latest picture/video of the work, shown as the turn's result. */
export interface ResultData { media: MediaRef[]; note?: string }
export interface FinalData { text: string }
/** `resetsAt` (epoch ms), with kind "limit": when the AI's plan limit resets, when it said so;
 *  `ai`: the AI that hit it. */
export interface ErrorData { message: string; kind?: "ai" | "app" | "limit" | "signin" | "internal"; resetsAt?: number; ai?: string }
export interface TurnFinishedData {
  outcome: "done" | "stopped" | "error" | "interrupted";
  ms: number;
  steps: number;
  usage?: Usage;
}
export interface TitleData { title: string }
export interface AppsChangedData { apps: string[] | null }
export interface ProjectChangedData { projectId: string | null }
