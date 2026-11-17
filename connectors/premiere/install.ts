// Installing Komposit's panel in Premiere Pro, and where its pieces live.
//
// Premiere has no outside scripting door, so Komposit ships a hidden CEP extension
// (panel/) that runs ExtendScript for it. Installing it needs no Adobe account, no Creative
// Cloud app and no marketplace: the folder is copied into the person's own CEP extensions
// folder, and CEP's PlayerDebugMode lets an unsigned extension load. Premiere loads it at
// its next start; it then writes its address (a port and a per-run token) to
// premiere-panel.json, where the connector reads it.
//
// Nothing here runs by itself: the app calls installPremierePanel when the person asks for
// it. Komposit 1.0's panel (dev.werq.komposit.premiere) is never touched.
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Platform } from "../../protocol/common.ts";
import { KitError } from "../_kit/transport.ts";

/** This panel's extension id. */
export const PANEL_ID = "dev.werq.komposit.premiere";
/** The panel's files, as they ship. */
export const PANEL_SOURCE = fileURLToPath(new URL("./panel/", import.meta.url));
/** CSXS versions the debug flag is set for: Premiere Pro 2020 (CEP 9) to today (CEP 12), plus the next one. */
export const CSXS_VERSIONS = [9, 10, 11, 12, 13];

// Where the panel writes its address. bridge.js works it out the same way, from the home
// folder (Mac) or %APPDATA% (Windows) alone: the panel can't know where the app keeps its
// data, so this never depends on that (or on 1.0's folder).
const PANEL_HOME = "dev.werq.komposit"; // the app's data folder (shell/config.ts DATA_FOLDER)
const ADDRESS_FILE = "premiere-panel.json";

export interface PanelPlaces {
  platform: Platform;
  /** The person's home folder. Default: os.homedir(). */
  home?: string;
  /** For %APPDATA% on Windows. Default: process.env. */
  env?: Record<string, string | undefined>;
}

const appData = ({ home = homedir(), env = process.env }: PanelPlaces) => env.APPDATA || win32.join(home, "AppData", "Roaming");

/** The person's own CEP extensions folder. */
export function cepExtensionsDir(p: PanelPlaces): string {
  if (p.platform === "win") return win32.join(appData(p), "Adobe", "CEP", "extensions");
  return join(p.home || homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions");
}

/** Where the running panel writes its port and token. */
export function panelAddressFile(p: PanelPlaces): string {
  if (p.platform === "win") return win32.join(appData(p), PANEL_HOME, ADDRESS_FILE);
  return join(p.home || homedir(), "Library", "Application Support", PANEL_HOME, ADDRESS_FILE);
}

/** CEP's PlayerDebugMode, which lets an unsigned extension load. */
export interface DebugModeSwitch {
  /** On for every CSXS version Komposit sets it for. */
  read(): Promise<boolean>;
  write(on: boolean): Promise<void>;
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 10000, encoding: "utf8", windowsHide: true }, (err, stdout) => res({ ok: !err, stdout: String(stdout || "") }));
  });
}

const underTest = () => !!process.env.NODE_TEST_CONTEXT;

/** The system's own setting: `defaults` on a Mac, the registry (HKCU) on Windows. */
export function systemDebugMode(platform: Platform): DebugModeSwitch {
  return {
    async read() {
      const each = await Promise.all(
        CSXS_VERSIONS.map(async (n) => {
          if (platform === "win") {
            const r = await run("reg", ["query", `HKCU\\Software\\Adobe\\CSXS.${n}`, "/v", "PlayerDebugMode"]);
            return r.ok && /PlayerDebugMode\s+REG_\w+\s+1\s*$/m.test(r.stdout);
          }
          const r = await run("defaults", ["read", `com.adobe.CSXS.${n}`, "PlayerDebugMode"]);
          return r.ok && r.stdout.trim() === "1";
        }),
      );
      return each.every(Boolean);
    },
    async write(on) {
      // A seatbelt: the test runner must never change this computer's setting.
      if (underTest()) throw new KitError("A test may not change CEP's PlayerDebugMode on this computer; pass debugMode.", "UNDER_TEST");
      for (const n of CSXS_VERSIONS) {
        if (platform === "win") {
          await run("reg", on
            ? ["add", `HKCU\\Software\\Adobe\\CSXS.${n}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"]
            : ["delete", `HKCU\\Software\\Adobe\\CSXS.${n}`, "/v", "PlayerDebugMode", "/f"]);
        } else {
          await run("defaults", on ? ["write", `com.adobe.CSXS.${n}`, "PlayerDebugMode", "1"] : ["delete", `com.adobe.CSXS.${n}`, "PlayerDebugMode"]);
        }
      }
    },
  };
}

/** A panel folder's version (ExtensionBundleVersion in its CSXS/manifest.xml), or null. */
export function panelVersion(dir: string): string | null {
  try {
    return /ExtensionBundleVersion="([^"]+)"/.exec(readFileSync(join(dir, "CSXS", "manifest.xml"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface PanelInstallOptions {
  /** Default: this computer's. */
  platform?: Platform;
  home?: string;
  env?: Record<string, string | undefined>;
  /** The CEP extensions folder to install into. Default: the person's own. */
  extensionsDir?: string;
  /** The panel's files. Default: panel/ beside this file. */
  source?: string;
  /** Default: the system's setting (systemDebugMode). */
  debugMode?: DebugModeSwitch;
}

export interface PanelState {
  installed: boolean;
  /** The installed copy's version. */
  version: string | null;
  /** The version Komposit ships. */
  shipped: string | null;
  /** Installed, and the version Komposit ships. */
  current: boolean;
  /** PlayerDebugMode is on (unsigned panels load); null when it wasn't read. */
  debugMode: boolean | null;
  path: string;
}

const thisPlatform = (): Platform => (process.platform === "win32" ? "win" : "mac");

function placesOf(o: PanelInstallOptions): { platform: Platform; dir: string; source: string; debugMode: DebugModeSwitch } {
  const platform = o.platform ?? thisPlatform();
  if (underTest() && (!o.extensionsDir || !o.debugMode)) {
    throw new KitError("A test must pass its own extensionsDir and debugMode: the person's Premiere Pro is never touched from a test.", "UNDER_TEST");
  }
  return {
    platform,
    dir: o.extensionsDir ?? cepExtensionsDir({ platform, home: o.home, env: o.env }),
    source: o.source ?? PANEL_SOURCE,
    debugMode: o.debugMode ?? systemDebugMode(platform),
  };
}

export interface PanelStateOptions extends Omit<PanelInstallOptions, "debugMode"> {
  /** Default: the system's setting. */
  debugMode?: Pick<DebugModeSwitch, "read">;
  /** false: don't read PlayerDebugMode (debugMode comes back null). */
  readDebugMode?: boolean;
}

/** Is the panel installed, current, and allowed to load? Reads only. */
export async function premierePanelState(o: PanelStateOptions = {}): Promise<PanelState> {
  const platform = o.platform ?? thisPlatform();
  const dir = o.extensionsDir ?? cepExtensionsDir({ platform, home: o.home, env: o.env });
  const path = join(dir, PANEL_ID);
  const installed = existsSync(join(path, "CSXS", "manifest.xml"));
  const version = installed ? panelVersion(path) : null;
  const shipped = panelVersion(o.source ?? PANEL_SOURCE);
  let debugMode: boolean | null = null;
  if (o.readDebugMode !== false) {
    try { debugMode = await (o.debugMode ?? systemDebugMode(platform)).read(); } catch { debugMode = null; }
  }
  // When this build can't see the panel it ships (shipped null), an installed one counts.
  return { installed, version, shipped, current: installed && (!shipped || version === shipped), debugMode, path };
}

/**
 * Copies the panel into the CEP extensions folder (replacing an older copy of this panel
 * only) and allows unsigned extensions. Premiere Pro loads it at its next start.
 */
export async function installPremierePanel(o: PanelInstallOptions = {}): Promise<{ path: string; version: string | null; note: string }> {
  const { dir, source, debugMode } = placesOf(o);
  if (!existsSync(join(source, "CSXS", "manifest.xml"))) {
    throw new KitError("Komposit's panel for Premiere Pro isn't next to this copy of Komposit, so it can't be installed.", "PANEL_FILES_MISSING");
  }
  const dest = join(dir, PANEL_ID);
  mkdirSync(dir, { recursive: true });
  // Copied beside it first, then swapped in, so a half-copied panel never sits in its place.
  const staging = join(dir, `.${PANEL_ID}.installing-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    cpSync(source, staging, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  await debugMode.write(true);
  return { path: dest, version: panelVersion(dest), note: "Quit and reopen Premiere Pro to load it." };
}

/** Removes this panel (never 1.0's). `debugModeOff` also turns PlayerDebugMode off, which
 *  other unsigned panels may need, so it's left on unless asked. */
export async function removePremierePanel(o: PanelInstallOptions & { debugModeOff?: boolean } = {}): Promise<{ removed: boolean }> {
  const { dir, debugMode } = placesOf(o);
  const dest = join(dir, PANEL_ID);
  const was = existsSync(dest);
  rmSync(dest, { recursive: true, force: true });
  if (o.debugModeOff) await debugMode.write(false);
  return { removed: was };
}
