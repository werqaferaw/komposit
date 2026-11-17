// A stand-in for the apps, for unit tests: a ScriptTransport that runs the wrapped
// ExtendScript in a Node vm against a fake DOM the test provides. ExtendScript is ES3, so
// the very script Komposit would send (envelope, quiet mode, document targeting, the
// connector's own code) runs here unchanged. Never talks to a real app.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import vm from "node:vm";
import type { Platform } from "../../protocol/common.ts";
import { KitError } from "./transport.ts";
import type { AutomationState, DialogsRead, RunJsxOptions, ScriptTransport, WindowMap } from "./transport.ts";

/** ExtendScript's File, enough for the scripts: paths in `virtual` exist without being on disk. */
export function fakeFileClass(virtual: Set<string> = new Set()) {
  return class File {
    fsName: string;
    name: string;
    encoding = "UTF-8";
    buf = "";
    constructor(path: string) {
      this.fsName = String(path);
      this.name = encodeURI(basename(this.fsName));
    }
    get exists() {
      return virtual.has(this.fsName) || existsSync(this.fsName);
    }
    get length() {
      try {
        return statSync(this.fsName).size;
      } catch {
        return -1;
      }
    }
    get modified() {
      return new Date(0);
    }
    open() {
      this.buf = "";
      return true;
    }
    write(s: string) {
      this.buf += s;
      return true;
    }
    close() {
      writeFileSync(this.fsName, this.buf, "utf8");
      return true;
    }
    remove() {
      virtual.delete(this.fsName);
      try {
        rmSync(this.fsName, { force: true });
      } catch {}
      return true;
    }
    copy(to: { fsName: string }) {
      if (!existsSync(this.fsName)) return false;
      writeFileSync(to.fsName, readFileSync(this.fsName));
      return true;
    }
  };
}

/** A tiny PNG (signature + IHDR) of the given size, enough for pngSize. */
export function tinyPng(width = 4, height = 3): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

export interface FakeCall {
  app: string;
  source: string;
  opts: RunJsxOptions;
}

export interface FakeTransportOptions {
  platform?: Platform;
  /** The stand-in app's globals (app, File, enums...) for one script run. */
  globals?: (app: string) => Record<string, unknown>;
  /** A transport failure instead of running the script (permission denied, a timeout...). */
  fail?: (app: string, source: string) => Error | null | undefined;
  /** The script "runs" but the app drops it (After Effects with a dialog up). */
  drop?: (app: string) => boolean;
  running?: Record<string, boolean>;
  installed?: Record<string, string | null>;
  pid?: Record<string, number | null>;
  uptime?: number;
  windows?: (app: string) => WindowMap | null;
  dialogs?: (app: string) => DialogsRead;
  answer?: (app: string, how: { button?: string; key?: "return" | "escape" }) => { ok: boolean; reason?: string };
  automation?: Record<string, AutomationState>;
  aeWrites?: boolean | null;
}

export type FakeTransport = ScriptTransport & { calls: FakeCall[]; activated: string[] };

const MAIN_WINDOW: WindowMap = new Map([[1, { w: 1900, h: 1000, layer: 0 }]]);

export function createFakeTransport(o: FakeTransportOptions = {}): FakeTransport {
  const calls: FakeCall[] = [];
  const activated: string[] = [];
  const running = (app: string) => (o.running ? !!o.running[app] : true);
  return {
    platform: o.platform || "mac",
    aeScriptSettings: o.platform === "win" ? "Edit > Preferences > Scripting & Expressions" : "Settings > Scripting & Expressions",
    calls,
    activated,
    async runJsx(app, source, opts = {}) {
      calls.push({ app, source, opts });
      const f = o.fail?.(app, source);
      if (f) throw f;
      if (o.drop?.(app)) return "";
      try {
        const value = vm.runInNewContext(source, { ...(o.globals ? o.globals(app) : {}) }, { timeout: 5000 });
        return opts.via === "file" ? "" : String(value ?? "");
      } catch (e) {
        // What osascript says when the app can't compile the script.
        throw new KitError(`application "${app}" error (osascript exit 1):\n0:0: execution error: ${(e as Error).message} (-2700)`, "APP_ERROR");
      }
    },
    async isAppRunning(app) {
      return running(app);
    },
    async appPid(app) {
      if (o.pid && app in o.pid) return o.pid[app];
      return running(app) ? 4242 : null;
    },
    async processUptime() {
      return o.uptime ?? 3600;
    },
    async appWindows(app) {
      return o.windows ? o.windows(app) : MAIN_WINDOW;
    },
    async dialogs(app) {
      return o.dialogs ? o.dialogs(app) : { dialogs: [] };
    },
    async answerDialog(app, how) {
      return o.answer ? o.answer(app, how) : { ok: false, reason: "no such button" };
    },
    async installedPath(app) {
      if (o.installed && app in o.installed) return o.installed[app];
      return `/Applications/${app}.app`;
    },
    async activateApp(app) {
      activated.push(app);
    },
    async automationState(app) {
      return o.automation?.[app] || "unknown";
    },
    aeScriptWrites() {
      return o.aeWrites === undefined ? true : o.aeWrites;
    },
  };
}
