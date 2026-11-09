// Where exports and saved copies go, shared by every bridge.
//
// Two rules: a file Komposit writes never replaces an existing file (it gets a
// " 2", " 3"… suffix instead), and it only writes inside the home folder.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { env, expandHome } from "../env.mjs";
import platform from "../platform/index.mjs";

// The folder to write into: `outputDir` if given (must be inside the home
// folder), else the Komposit Exports folder. Created if missing.
export function outputFolder(outputDir) {
  const dir = resolve(expandHome(outputDir ? String(outputDir) : env.exportDir));
  const home = homedir();
  if (!platform.isInside(home, dir)) {
    throw new Error(`Komposit only writes inside your home folder; "${outputDir}" is outside it.`);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A filename-safe base name (keeps spaces, drops path separators and oddities).
export function safeBase(name, fallback = "komposit-export") {
  const s = String(name || "")
    .replace(/\.[a-z0-9]{2,4}$/i, "") // drop an extension the model may have added
    .replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 80);
  return s || fallback;
}

// A path in `dir` for `base.ext` that does not exist yet.
export function uniquePath(dir, base, ext) {
  let p = join(dir, `${base}.${ext}`);
  for (let n = 2; existsSync(p); n++) p = join(dir, `${base} ${n}.${ext}`);
  return p;
}

// One call for the common case.
export function newOutputPath({ outputDir, name, ext, fallback }) {
  return uniquePath(outputFolder(outputDir), safeBase(name, fallback), ext);
}
