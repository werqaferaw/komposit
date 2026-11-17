// Where exports and saved copies go, shared by every connector.
//
// Two rules: a file Komposit writes never replaces an existing file (it gets a " 2",
// " 3"… suffix instead), and it only writes inside the home folder or a project's folder
// (which may be on another drive).
import { constants, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, parse, resolve, sep, win32 } from "node:path";
import { homedir } from "node:os";
import type { Platform } from "../../protocol/common.ts";
import { KitError } from "./transport.ts";

export interface OutputRules {
  /** The default folder. Default: ~/Komposit Exports. */
  exportDir?: string;
  /** The home folder. Default: os.homedir(). */
  home?: string;
  /** Project folders, also allowed (they may be on another drive). */
  allowedRoots?: () => string[];
  platform?: Platform;
}

// Is `p` the folder `dir` or inside it (no ../ tricks)? Case-sensitive on a Mac, like the
// rest of macOS path handling here; case-insensitive and either slash on Windows.
export function isInside(dir: string, p: string, platform: Platform = process.platform === "win32" ? "win" : "mac"): boolean {
  if (!p || typeof p !== "string" || !dir) return false;
  if (platform === "win") {
    const r = win32.resolve(p).toLowerCase();
    const d = win32.resolve(dir).toLowerCase().replace(/\\+$/, "");
    return r === d || r.startsWith(d + "\\");
  }
  const r = resolve(p);
  const d = resolve(dir);
  return r === d || r.startsWith(d.endsWith(sep) ? d : d + sep);
}

export function expandHome(p: string, home = homedir()): string {
  return p === "~" ? home : p.startsWith("~/") || p.startsWith("~\\") ? join(home, p.slice(2)) : p;
}

// The folder to write into: `outputDir` if given (inside the home folder or a project
// folder), else the exports folder. Created if missing.
export function outputFolder(outputDir: string | undefined, rules: OutputRules = {}): string {
  const home = rules.home || homedir();
  const fallback = rules.exportDir || join(home, "Komposit Exports");
  const dir = resolve(expandHome(outputDir ? String(outputDir) : fallback, home));
  const roots = [home, ...(rules.allowedRoots ? rules.allowedRoots() : [])];
  if (!roots.some((r) => isInside(r, dir, rules.platform))) {
    throw new KitError(`Komposit only writes inside your home folder or a project's folder; "${outputDir}" is outside both.`, "OUTSIDE_HOME");
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A filename-safe base name (keeps spaces, drops path separators and oddities).
export function safeBase(name: string | undefined | null, fallback = "komposit-export"): string {
  const s = String(name || "")
    .replace(/\.[a-z0-9]{2,4}$/i, "") // drop an extension the model may have added
    .replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 80);
  return s || fallback;
}

// A path in `dir` for `base.ext` that does not exist yet.
export function uniquePath(dir: string, base: string, ext: string): string {
  let p = join(dir, `${base}.${ext}`);
  for (let n = 2; existsSync(p); n++) p = join(dir, `${base} ${n}.${ext}`);
  return p;
}

// One call for the common case.
export function newOutputPath(
  { outputDir, name, ext, fallback }: { outputDir?: string; name?: string | null; ext: string; fallback?: string },
  rules: OutputRules = {},
): string {
  return uniquePath(outputFolder(outputDir, rules), safeBase(name, fallback), ext);
}

/**
 * Moves a file an app wrote into the scratch folder to `dest`, never replacing a file: if
 * something is at `dest` by now, the next free name. Returns where it went.
 *
 * Why: the apps don't keep the name they're given. Illustrator's picture exports and
 * Photoshop's Save for Web turn spaces into hyphens ("poster 2.png" is written as
 * "poster-2.png", seen in the live test) and overwrite whatever has that name. So they
 * write to a plain scratch name, and the file is put in place here.
 */
export function moveNew(src: string, dest: string): string {
  const { name, ext } = parse(dest);
  let target = dest;
  for (let i = 0; i < 50; i++) {
    try {
      copyFileSync(src, target, constants.COPYFILE_EXCL);
      try { rmSync(src, { force: true }); } catch {}
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new KitError(`Komposit couldn't put the file in ${dirname(dest)}: ${(e as Error).message}`, "WRITE_FAILED");
      target = uniquePath(dirname(dest), name, ext.replace(/^\./, ""));
    }
  }
  throw new KitError(`Komposit couldn't find a free name for ${name}${ext} in ${dirname(dest)}.`, "WRITE_FAILED");
}
