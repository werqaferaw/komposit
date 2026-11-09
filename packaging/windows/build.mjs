// Build Komposit for Windows: the native helper and tray app, the stage folder
// (everything that gets installed), and the installer.
//
//   node packaging/windows/build.mjs            # compile + stage + installer (on Windows)
//   node packaging/windows/build.mjs compile    # komposit-win.exe, Komposit.exe -> packaging/windows/build
//   node packaging/windows/build.mjs stage      # dist/windows/stage
//   node packaging/windows/build.mjs installer  # dist/Komposit-Setup-<version>.exe
//
// Environment: CSC (csc.exe; default: .NET Framework's, which every Windows
// 10/11 PC has), ISCC (Inno Setup's ISCC.exe), NODE_EXE (the node.exe to
// bundle; default: the one running this), KOMPOSIT_WEB_URL (the hosted UI the
// tray opens; default: the app's own page).
//
// The stage layout (also what the tray app and win.mjs expect):
//   Komposit.exe  komposit-win.exe  komposit.ico  tray-light.ico  tray-dark.ico  komposit.json
//   node\node.exe
//   app\package.json  app\companion\...  app\ui\...  app\node_modules\...
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { join, dirname, basename, relative, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIN = join(ROOT, "packaging", "windows");
const BUILD = join(WIN, "build");
const DIST = join(ROOT, "dist");
const STAGE = join(DIST, "windows", "stage");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const log = (...a) => console.log("==", ...a);

function run(cmd, args) {
  log([basename(cmd), ...args.map((a) => (a.length > 80 ? "…" + a.slice(-60) : a))].join(" "));
  execFileSync(cmd, args, { stdio: "inherit", windowsHide: true });
}

export function cscPath(env = process.env) {
  if (env.CSC) return env.CSC;
  return join(env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
}

// The two csc.exe command lines (exported for the unit tests).
export function compileCommands(buildDir = BUILD, winDir = WIN) {
  const icon = join(winDir, "icons", "komposit.ico");
  const common = ["/nologo", "/optimize+", "/platform:anycpu", `/win32icon:${icon}`, "/r:System.Drawing.dll"];
  return {
    helper: [...common, "/target:exe", `/out:${join(buildDir, "komposit-win.exe")}`, join(winDir, "helper", "KompositWin.cs")],
    tray: [
      ...common,
      "/target:winexe",
      "/r:System.Windows.Forms.dll",
      `/win32manifest:${join(winDir, "tray", "Komposit.manifest")}`,
      `/out:${join(buildDir, "Komposit.exe")}`,
      join(winDir, "tray", "KompositTray.cs"),
    ],
  };
}

function compile() {
  const csc = cscPath();
  if (!existsSync(csc)) throw new Error(`csc.exe not found at ${csc} (set CSC)`);
  mkdirSync(BUILD, { recursive: true });
  const c = compileCommands();
  run(csc, c.helper);
  run(csc, c.tray);
}

// node_modules without what doesn't run: types, maps, docs, TypeScript
// sources, bin links (the same filter as the Mac build).
export function keepModuleFile(path) {
  const parts = path.split(/[\\/]/);
  const name = parts[parts.length - 1];
  if (parts.includes(".bin") || parts.includes("src")) return false;
  if (name === ".DS_Store") return false;
  if (/\.(map|md|d\.ts|d\.mts|d\.cts)$/i.test(name)) return false;
  if (/\.ts$/i.test(name) && !/\.d\.ts$/i.test(name)) return false;
  return true;
}

export function keepAppFile(path) {
  const parts = path.split(/[\\/]/);
  return !parts.includes("test") && !parts.includes(".DS_Store");
}

function stage({ nodeExe = process.env.NODE_EXE || process.execPath, webUrl = process.env.KOMPOSIT_WEB_URL || "" } = {}) {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(join(STAGE, "node"), { recursive: true });
  mkdirSync(join(STAGE, "app"), { recursive: true });

  for (const f of ["Komposit.exe", "komposit-win.exe"]) {
    const src = join(BUILD, f);
    if (!existsSync(src)) throw new Error(`${src} is missing: run "build.mjs compile" first`);
    copyFileSync(src, join(STAGE, f));
  }
  for (const f of ["komposit.ico", "tray-light.ico", "tray-dark.ico"]) copyFileSync(join(WIN, "icons", f), join(STAGE, f));
  writeFileSync(join(STAGE, "komposit.json"), JSON.stringify({ version: VERSION, webUrl }, null, 2) + "\n");

  if (!/\.exe$/i.test(nodeExe) && process.platform === "win32") throw new Error(`NODE_EXE must be a node.exe, got ${nodeExe}`);
  copyFileSync(nodeExe, join(STAGE, "node", "node.exe"));

  const app = join(STAGE, "app");
  cpSync(join(ROOT, "companion"), join(app, "companion"), { recursive: true, filter: (src) => keepAppFile(relative(ROOT, src)) });
  cpSync(join(ROOT, "ui"), join(app, "ui"), { recursive: true, filter: (src) => keepAppFile(relative(ROOT, src)) });
  copyFileSync(join(ROOT, "package.json"), join(app, "package.json"));
  cpSync(join(ROOT, "node_modules"), join(app, "node_modules"), {
    recursive: true,
    filter: (src) => statSync(src).isDirectory() ? keepModuleFile(relative(ROOT, src) + sep) : keepModuleFile(relative(ROOT, src)),
  });
  log(`staged ${STAGE} (node ${nodeExe}, web ${webUrl || "none"})`);
}

export function isccPath(env = process.env) {
  if (env.ISCC) return env.ISCC;
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const pf = env.ProgramFiles || "C:\\Program Files";
  return [join(pf86, "Inno Setup 6", "ISCC.exe"), join(pf, "Inno Setup 6", "ISCC.exe")].find((p) => existsSync(p)) || "iscc";
}

function installer() {
  if (!existsSync(join(STAGE, "Komposit.exe"))) throw new Error(`stage first: ${STAGE}`);
  run(isccPath(), [`/DAppVersion=${VERSION}`, `/DStage=${STAGE}`, `/DOutDir=${DIST}`, join(WIN, "komposit.iss")]);
  const out = join(DIST, `Komposit-Setup-${VERSION}.exe`);
  if (!existsSync(out)) throw new Error(`the installer wasn't written: ${out}`);
  log(`installer ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
}

const isMain = !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const step = process.argv[2] || "all";
  if (step === "compile" || step === "all") compile();
  if (step === "stage" || step === "all") stage();
  if (step === "installer" || step === "all") installer();
}
