// The scratch folder for files that pass between Komposit and the Adobe apps
// (renders, result files, scripts): <system temp>/komposit. Shared by the
// platform layer and the bridges, so it sits on its own.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function scratchDir() {
  const dir = join(tmpdir(), "komposit");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function rmQuiet(p) {
  try {
    rmSync(p, { force: true });
  } catch {}
}

// Read an exported render, then delete the scratch file.
export function readPng(path) {
  const buf = readFileSync(path);
  rmQuiet(path);
  return buf;
}

// Unique scratch names per call: the doc server (Claude Code path) and the
// main server can run scripts at the same time, and must not overwrite each
// other's files.
let _seq = 0;
export function scratchName(prefix, ext) {
  _seq = (_seq + 1) % 1e9;
  return join(scratchDir(), `${prefix}-${process.pid}-${Date.now().toString(36)}-${_seq}.${ext}`);
}
