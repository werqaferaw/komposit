// The scratch folder for files that pass between Komposit and the apps (renders, result
// files, scripts): <system temp>/komposit unless the caller names another (tests use a
// mkdtemp folder). Shared by the transports and the connectors.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface Scratch {
  /** The folder, created if missing. */
  dir(): string;
  /** A unique path in it, for one call: several chats can run scripts at the same time
   *  and must not overwrite each other's files. */
  name(prefix: string, ext: string): string;
}

export function createScratch(base?: string): Scratch {
  const root = base || join(tmpdir(), "komposit");
  let seq = 0;
  const dir = () => {
    mkdirSync(root, { recursive: true });
    return root;
  };
  return {
    dir,
    name(prefix, ext) {
      seq = (seq + 1) % 1e9;
      return join(dir(), `${prefix}-${process.pid}-${Date.now().toString(36)}-${seq}.${ext}`);
    },
  };
}

export function rmQuiet(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {}
}

/** Read a rendered file, then delete the scratch copy. */
export function readAndRemove(path: string): Uint8Array {
  const buf = readFileSync(path);
  rmQuiet(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
