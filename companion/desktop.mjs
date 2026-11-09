// Desktop awareness: which Adobe apps are open, and the design files on disk
// (with previews). Powers the workspace UI. Local, single-user, read-only.
//
// Everything here is async on purpose. On a Mac, the first read of ~/Desktop,
// ~/Documents or ~/Downloads by a new app shows a permission prompt and the
// read waits for the answer; doing that synchronously would freeze the server.
// System calls (process lists, opening files, thumbnails) go through the
// platform layer.
import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { appManifest } from "./bridges/index.mjs";
import { DATA_DIR } from "./config.mjs";
import platform from "./platform/index.mjs";

const HOME = homedir();

// Which app owns which file type.
export const EXT_APP = {
  ".ai": "illustrator",
  ".eps": "illustrator",
  ".psd": "photoshop",
  ".psb": "photoshop",
  ".aep": "aftereffects",
};

// Folders we surface recent work from: Desktop, Downloads, Documents. On
// Windows these can be redirected (OneDrive), so the platform says where.
let _folders = null;
async function designFolders() {
  if (!_folders) _folders = await platform.designFolders();
  return _folders;
}
designFolders().catch(() => {});
export async function scanDirs() {
  const f = await designFolders();
  return [f.desktop, f.downloads, f.documents];
}
const THUMB_DIR = join(DATA_DIR, "cache", "thumbs");
const RENDER_DIR = join(DATA_DIR, "cache", "renders"); // real artboard renders, keyed by path

// Is this path inside the home folder (no ../ tricks), or inside one of the
// design folders where Windows keeps them outside it?
export function inHome(p) {
  if (!p || typeof p !== "string") return false;
  if (platform.isInside(HOME, p)) return true;
  return !!_folders && Object.values(_folders).some((d) => d && platform.isInside(d, p));
}

let _running = null;
let _runningAt = 0;
export async function runningApps() {
  if (_running && Date.now() - _runningAt < 2000) return _running;
  const out = await platform.runningApps();
  _running = out;
  _runningAt = Date.now();
  return out;
}

export async function recentFiles(limit = 16) {
  const files = [];
  for (const dir of await scanDirs()) {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const ext = extname(name).toLowerCase();
      if (!EXT_APP[ext]) continue;
      const path = join(dir, name);
      try {
        const st = await stat(path);
        if (!st.isFile()) continue;
        files.push({ name, path, ext, app: EXT_APP[ext], mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit);
}

// Full workspace snapshot for the UI.
export async function workspaceSnapshot() {
  const [running, recent] = await Promise.all([runningApps(), recentFiles()]);
  const apps = appManifest().map((a) => ({ ...a, running: !!running[a.id] }));
  return { apps, recentFiles: recent };
}

// Open a design file in its app (a file card is a real entry point).
export async function openFile(path) {
  if (!inHome(path) || !existsSync(path)) return false;
  if (!EXT_APP[extname(path).toLowerCase()]) return false;
  return platform.openPath(path);
}

// Browse a folder for the sidebar file tree: subfolders + design files.
// Home-restricted. Returns { cwd, parent, name, dirs[], files[] }.
export async function browse(dir) {
  const desktop = (await designFolders()).desktop || join(HOME, "Desktop");
  let cwd = inHome(dir) ? resolve(dir) : desktop;
  try {
    if (!(await stat(cwd)).isDirectory()) cwd = desktop;
  } catch {
    cwd = desktop;
  }
  const dirs = [];
  const files = [];
  let names = [];
  let denied = false;
  try {
    names = await readdir(cwd);
  } catch (e) {
    denied = e.code === "EPERM" || e.code === "EACCES";
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(cwd, name);
    let st;
    try {
      st = await stat(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!name.endsWith(".app")) dirs.push({ name, path });
    } else {
      const ext = extname(name).toLowerCase();
      if (EXT_APP[ext]) files.push({ name, path, ext, app: EXT_APP[ext], mtime: st.mtimeMs });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => b.mtime - a.mtime);
  const up = resolve(cwd, "..");
  const parent = cwd === HOME || up === cwd || !inHome(up) ? null : up;
  return { cwd, parent, name: basename(cwd) || cwd, dirs, files, denied };
}

// Render cache: the REAL artboard render of a file (made while it is open), so
// a card shows the actual artwork rather than a blank QuickLook.
function renderKey(path) {
  return join(RENDER_DIR, createHash("md5").update(path).digest("hex") + ".png");
}

export async function saveRender(path, buf) {
  if (!path || !buf) return;
  try {
    await mkdir(RENDER_DIR, { recursive: true });
    await writeFile(renderKey(path), buf);
  } catch {}
}

export async function cachedRender(path) {
  try {
    return await readFile(renderKey(path));
  } catch {
    return null;
  }
}

// A system thumbnail PNG for a design file (cached), or null: QuickLook on a
// Mac, the Explorer thumbnail on Windows.
export async function thumbnail(path) {
  if (!inHome(path) || !existsSync(path)) return null;
  if (!EXT_APP[extname(path).toLowerCase()]) return null;
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  await mkdir(THUMB_DIR, { recursive: true });
  const key = createHash("md5").update(path + ":" + st.mtimeMs).digest("hex");
  const cached = join(THUMB_DIR, key + ".png");
  try {
    return await readFile(cached);
  } catch {}
  return platform.thumbnail(path, THUMB_DIR, cached);
}
