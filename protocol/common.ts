// Shared shapes used across the protocol. Types only: this folder is imported by the
// UI (browser), the core (Node), connectors and the bridge, so nothing here may use
// Node or DOM APIs except in rpc.ts, which is plain JavaScript.

export type Platform = "mac" | "win";
export type AiId = "claude-code" | "codex" | "komposit" | (string & {});
export type Effort = "low" | "medium" | "high";

/** A picture, video or file kept in the record's media store, named by its content hash.
 *  The window loads it from `komposit-media://local/<id>` (a standard scheme, so the id sits
 *  in the path after the fixed host "local"); the phone asks `media.get`. */
export interface MediaRef {
  id: string;
  mime: string;
  name?: string;
  width?: number;
  height?: number;
  bytes?: number;
  /** A file the person attached: "use" goes into their document, "ref" is only for the AI to
   *  look at. Absent on renders and on attachments from before roles were kept. */
  role?: "use" | "ref";
}

/** A document open in (or saved from) a creative app. `path` when it's saved, otherwise the
 *  app's own id or its window name. Tools always target a DocRef, never "whatever is in front". */
export interface DocRef {
  app: string;
  name: string;
  path?: string;
  id?: string;
  /** The part of the document a request works in, by the app's own id when known, else by
   *  name: an After Effects comp, a Premiere Pro sequence. Without it, the one being viewed. */
  part?: { id?: string; name: string };
}

export interface AppStatus {
  app: string;
  label: string;
  installed: boolean;
  running: boolean;
  /** Running and answering scripts (no dialog up, permission granted, setting on). */
  ready: boolean;
  /** One plain sentence when not ready, e.g. "After Effects is showing a dialog." */
  reason?: string;
  version?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  /** What the AI's own program says the work cost at API prices (Claude Code's figure; on a
   *  plan nothing extra is charged). Absent when it doesn't say. */
  costUsd?: number;
}

/** File extension for each media type the record stores. */
export const MEDIA_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};

/** Where a media file lives inside the data folder: media/<first 2 hex>/<sha256>.<ext>.
 *  Null for anything that isn't a well-formed media id (blocks path tricks). */
export function mediaPath(id: string): string | null {
  if (!/^[a-f0-9]{64}\.(png|jpg|webp|gif|svg|mp4|mov|pdf|wav|mp3)$/.test(id)) return null;
  return `media/${id.slice(0, 2)}/${id}`;
}
