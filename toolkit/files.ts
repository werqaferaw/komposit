// File rules, in code rather than in a prompt:
//   - a file written for the person never replaces an existing one (it gets " 2", " 3"...);
//   - exports land inside the home folder or an allowed folder (a project), nowhere else;
//   - a path given for a project stays inside the project folder, and a link can't lead out.
// Ported from 1.0 and shared by the Komposit app and the standalone MCP server.
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const NOTES_NAME = "komposit-notes.md";
export const EXPORTS_NAME = "Exports";

const WIN = process.platform === "win32";

/** Is `p` the folder `dir` or inside it? (Windows paths compare without case.) */
export function isInside(dir: string, p: string): boolean {
  if (!p || typeof p !== "string" || !dir) return false;
  let r = resolve(p);
  let d = resolve(dir);
  if (WIN) { r = r.toLowerCase(); d = d.toLowerCase(); }
  d = d.replace(/[\\/]+$/, "");
  return r === d || r.startsWith(d + sep);
}

/** "~" and "~/x" as paths in the home folder. */
export function expandHome(s: string, home: string): string {
  return s === "~" || s.startsWith("~/") || s.startsWith("~\\") ? join(home, s.slice(1)) : s;
}

function realOr(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

// The real path of `p`, following links in the deepest part of it that exists
// (a file about to be made has no real path yet; its folder does).
function realDeep(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync(cur), ...rest.slice().reverse()); } catch { /* go up */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.push(basename(cur));
    cur = up;
  }
}

/** Where `p` (absolute, ~/..., or relative to the project folder) is, if it is inside the
 *  project folder; null if not. A link can't lead out of it. */
export function inProject(root: string, p: unknown, home: string): string | null {
  if (p == null || String(p).trim() === "") return null;
  const abs = resolve(root, expandHome(String(p).trim(), home));
  if (!isInside(root, abs)) return null;
  if (!isInside(realOr(root), realDeep(abs))) return null;
  return abs;
}

/** A path inside the project as the AI and the person read it: "Exports/map.pdf". */
export function relIn(root: string, abs: string): string {
  const r = relative(root, abs);
  return r ? r.split(sep).join("/") : ".";
}

export const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
export const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// ---- where exports go ------------------------------------------------------------------

export interface OutputRules {
  home: string;
  /** Default folder, e.g. ~/Komposit Exports. */
  exportDir: string;
  /** Other folders exports may go into (project folders, even on another drive). */
  projectRoots: string[];
}

/** The folder to write into: `outputDir` if given (inside the home folder or an allowed
 *  folder), else the default export folder. Created if missing. Throws a plain sentence. */
export function outputFolder(outputDir: string | undefined, rules: OutputRules): string {
  const dir = resolve(expandHome(outputDir ? String(outputDir) : rules.exportDir, rules.home));
  if (!isInside(rules.home, dir) && !rules.projectRoots.some((r) => isInside(r, dir))) {
    throw new Error(`Komposit only writes inside your home folder or a project's folder; "${outputDir ?? dir}" is outside both.`);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A filename-safe base name (keeps spaces, drops path separators and oddities). */
export function safeBase(name: unknown, fallback = "komposit-export"): string {
  const s = String(name || "")
    .replace(/\.[a-z0-9]{2,4}$/i, "") // drop an extension the AI may have added
    .replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 80);
  return s || fallback;
}

/** A path in `dir` for `base.ext` that does not exist yet: "Poster.png", "Poster 2.png"... */
export function uniquePath(dir: string, base: string, ext: string): string {
  let p = join(dir, `${base}.${ext}`);
  for (let n = 2; existsSync(p); n++) p = join(dir, `${base} ${n}.${ext}`);
  return p;
}

/** "*.ai", "**\/poster*", "brief": a glob over the path, or a plain word anywhere in it. */
export function patternRegex(p: string): RegExp {
  if (!/[*?]/.test(p)) return new RegExp(p.replace(/[.+^${}()|[\]\\]/g, "\\$&"), "i");
  let s = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*" && p[i + 1] === "*") { s += ".*"; i++; if (p[i + 1] === "/") i++; }
    else if (c === "*") s += "[^/]*";
    else if (c === "?") s += "[^/]";
    else s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${s}$`, "i");
}

export function fmtSize(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  if (n < 1000) return `${n} byte${n === 1 ? "" : "s"}`;
  return `${Math.round(n / 1e3)} KB`;
}
