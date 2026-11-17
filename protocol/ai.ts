// An AI adapter runs one turn of a chat with one AI (Claude Code on the person's plan,
// Codex on their ChatGPT plan, Komposit's own loop on keys or credits, any ACP agent).
// Adapters never touch apps or files: they reach Komposit's toolbox, which the core runs.
// Tool calls are reported by the toolbox itself, so adapters only report the AI's words,
// its session handle and usage.
import type { AiId, Effort, Usage } from "./common.ts";
import type { AiStatus } from "./wire.ts";

/** How the AI's own process starts Komposit's toolbox: run this command; it connects to the core. */
export interface ToolboxAccess {
  command: string;
  args: string[];
  /** Includes KOMPOSIT_PASS (this run's pass) and KOMPOSIT_SOCKET. */
  env: Record<string, string>;
  /** Names the AI may call, as the toolbox lists them (for allow-lists like --allowedTools). */
  toolNames: string[];
}

export interface TurnInput {
  chatId: string;
  turnId: string;
  text: string;
  images: { path: string; mime: string }[];
  effort: Effort;
  /** Komposit's instructions for this AI (stable for the whole chat). */
  system: string;
  /** Live context for this turn (selection, open files, the board), put before the message. */
  context?: string;
  /** The adapter's own session/thread id from the previous turn, to resume. */
  session?: string;
  toolbox: ToolboxAccess;
  /** A private working folder for the AI process (never the person's files). */
  workDir: string;
  /** Extra folders the AI may read (a project folder). */
  readDirs?: string[];
}

export type AiEvent =
  | { type: "note"; text: string }
  | { type: "text"; text: string }
  | { type: "final"; text: string }
  /** `resetsAt` (epoch ms), with kind "limit": when the plan's limit resets, when the AI says. */
  | { type: "error"; message: string; kind?: "signin" | "limit" | "broken" | "other"; resetsAt?: number }
  | { type: "session"; session: string }
  | { type: "usage"; usage: Usage };

export interface TurnOutcome {
  outcome: "done" | "stopped" | "error";
  session?: string;
  usage?: Usage;
  /** The stored session couldn't be resumed. The adapter may already have started a fresh one
   *  inside this same turn: then `session` is that new one and the caller stores it (and gives
   *  the next context in full, as for a new chat). Without `session`, the next turn starts fresh. */
  resumeFailed?: boolean;
}

/** Talking to a turn while it runs, like Claude Code in a terminal. The caller passes an empty
 *  object as runTurn's fourth argument; an adapter that can take more input sets `say` and
 *  `interrupt` while the turn can take them, and clears them (null) when it ends. Adapters that
 *  can't leave them unset: then messages wait for the next turn and stop aborts the signal. */
export interface TurnControl {
  /** A message the person typed while it works; the AI picks it up after the step it is on.
   *  False when the turn can't take it (then it becomes a turn of its own). */
  say?: ((text: string, id?: string | null) => boolean) | null;
  /** Stop now (Esc): the turn ends as stopped and the session keeps everything so far.
   *  Returns the messages it hadn't picked up yet (they go back to the person), or null when
   *  it can't (then abort the signal). */
  interrupt?: (() => { unsent: string[] } | null) | null;
  /** Set by the caller: the AI picked up a message sent with say(). `afterReply`: it had
   *  already finished its reply, so what follows is a further reply in the same turn. */
  onPickedUp?: (id: string | null, text: string, afterReply: boolean) => void;
}

export interface AiAdapter {
  id: AiId;
  label: string;
  /** `fresh`: don't reuse a recent answer (right after the person signed in, say). */
  status(opts?: { fresh?: boolean }): Promise<AiStatus>;
  /** Runs until the AI finishes, fails, or `signal` aborts (then it must stop its processes). */
  runTurn(input: TurnInput, emit: (event: AiEvent) => void, signal: AbortSignal, control?: TurnControl): Promise<TurnOutcome>;
}
