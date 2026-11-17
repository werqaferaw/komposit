// Notices when an app puts up a dialog while Komposit is waiting on it. A dialog blocks
// scripting, so a step would otherwise just hang with no hint.
//
// How: list the app's windows when a step starts (the transport: on a Mac CoreGraphics
// through JXA, about 0.1 s and no extra permission; on Windows the app's top-level
// windows), then look again every few seconds. A NEW window that stays up across two looks
// is almost certainly a dialog, and so is a modal one that was already up; brief ones (the
// throwaway document an export opens) are ignored. Layer 8 means a modal dialog, 0 a normal
// window, on both platforms.
import { labelOf } from "./transport.ts";
import type { ScriptTransport, WindowInfo, WindowMap } from "./transport.ts";

export interface DialogInfo {
  app: string;
  title: string;
  text: string;
  buttons: string[];
  fields: number;
  readable: boolean;
  /** The Accessibility permission is off. */
  denied?: boolean;
  /** The person's dialog, not one a Komposit step caused (see DialogWatcher.whose). */
  theirs?: boolean;
}

// After Effects' own window while a script runs longer than about a second: at the modal
// layer, but no dialog (live test, Nov 16). Known by its title, when the system gives titles.
const NOT_A_DIALOG = /^Executing Script\b/i;
const dialogSized = (s: WindowInfo) => s.w >= 150 && s.h >= 80 && !NOT_A_DIALOG.test(s.title || "");

// New windows big enough to be a dialog (not a tooltip or a menu), and modal ones (layer 8)
// even when they were already up as the step started: Photoshop can open with an alert up
// ("Scratch Disk Low" on a full disk, live test Nov 16), and every script waits behind it.
export function newDialogs(baseline: WindowMap | null, now: WindowMap): number[] {
  const out: number[] = [];
  for (const [id, s] of now) {
    if (!dialogSized(s)) continue;
    if (!(baseline && baseline.has(id)) || s.layer === 8) out.push(id);
  }
  return out;
}

/** The first modal dialog in the map (layer 8, dialog-sized), or null. */
export function modalWindow(m: WindowMap | null): WindowInfo | null {
  if (!m) return null;
  for (const s of m.values()) if (s.layer === 8 && dialogSized(s)) return s;
  return null;
}

/** Is any window in the map a modal dialog (layer 8, dialog-sized)? */
export function hasModal(m: WindowMap | null): boolean {
  return !!modalWindow(m);
}

/** What the system says about the app's dialogs: "yes" (it lists one), "no" (it could look
 *  and lists none), "unknown" (it couldn't look: no Accessibility permission, or it failed). */
export interface DialogRead {
  state: "yes" | "no" | "unknown";
  info: DialogInfo | null;
}

// Window layers alone can't tell a dialog from a progress bar or a hidden window: Illustrator
// keeps a modal-layer window up all the time, and a long export puts up its progress window,
// so on Nov 16 a day's work had 16 "seems to be showing a dialog" waits with no dialog, and the
// AI refused to work in an app that was fine. What Accessibility lists is the judge whenever it
// can look; the window layers are the fallback only when it can't.
export async function readDialog(t: ScriptTransport, app: string): Promise<DialogRead> {
  let r = null;
  try {
    r = t.dialogs ? await t.dialogs(app) : null;
  } catch {}
  if (!r) return { state: "unknown", info: null };
  if (r.denied) return { state: "unknown", info: { app, denied: true, title: "", text: "", buttons: [], fields: 0, readable: false } };
  if (!Array.isArray(r.dialogs) || (r as { error?: unknown }).error) return { state: "unknown", info: null };
  const d = r.dialogs[0];
  if (!d) return { state: "no", info: null };
  const title = String(d.title || "").trim();
  const text = (d.text || []).map((x) => String(x).trim()).filter((x) => x && x !== title).join(" ");
  const buttons = (d.buttons || []).map(String);
  return { state: "yes", info: { app, title, text, buttons, fields: d.fields || 0, readable: !!(title || text || buttons.length) } };
}

// What the app's dialog says, as far as the system lets Komposit read it (Accessibility on
// a Mac). Null when there is none to read.
export async function describeDialog(t: ScriptTransport, app: string): Promise<DialogInfo | null> {
  return (await readDialog(t, app)).info;
}

/** Window layers say "maybe a dialog": does the system agree? After Effects can't be read
 *  while it runs a script, so for it the layers stand. A modal window with a title stands too
 *  (Photoshop's "Scratch Disk Low" alert, Nov 16): Illustrator's hidden window and an export's
 *  progress window have none. Illustrator's permanent modal-layer window means an untitled
 *  one never says anything on its own. */
export function layersMeanDialog(app: string, read: DialogRead, window?: WindowInfo | null): boolean {
  if (read.state === "yes") return true;
  if (window && window.layer === 8 && window.title && !NOT_A_DIALOG.test(window.title)) return true;
  if (read.state === "no") return app === "aftereffects";
  return app !== "illustrator";
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

// The hint under a step waiting on the person's own dialog: it's theirs to close, so nothing in
// Komposit offers to answer it.
export function theirDialogText(app: string, info: DialogInfo | null = null): string {
  const label = labelOf(app) === app ? "the app" : labelOf(app);
  const title = info?.title ? clip(info.title, 60) : "";
  const said = info?.text && info.text !== info.title ? `: “${clip(info.text, 200)}”` : "";
  const end = /[.?!]”$/.test(said) ? "" : ".";
  return `Waiting for you to close ${title ? `“${title}”` : "the dialog"} in ${label}${said}${end}`;
}

// The hint under a waiting step. With what the dialog says when it can be read.
export function dialogText(app: string, info: DialogInfo | null = null): string {
  const label = labelOf(app) === app ? "The app" : labelOf(app);
  // After Effects can't be read while it runs a script, and its Executing Script window looks
  // like a dialog: closing that one would stop the step.
  if ((!info || !info.readable) && app === "aftereffects") {
    return `${label} seems to be busy or showing a dialog. If its window says Executing Script, it's still working on this step; if it's a dialog, answer it and this carries on.`;
  }
  if (!info || !info.readable) return `${label} seems to be showing a dialog. Close it and this carries on.`;
  const what = info.text || info.title;
  let s = `${label} is showing a dialog`;
  if (info.title && info.text) s += ` (${clip(info.title, 60)})`;
  if (what) s += `: “${clip(what, 240)}”`;
  if (info.buttons.length) s += `${what ? "." : ","} ${what ? "Its buttons" : "with the buttons"}: ${info.buttons.join(", ")}`;
  s = s.replace(/([.?!]”)\./, "$1");
  return s + ". Answer it and this carries on.";
}

// Buttons an agent must not press by itself: they save, throw away or replace the
// person's work. (The person can press any button, in the app.)
const NOT_FOR_AGENT = /\b(save|don.?t save|discard|delete|replace|overwrite|revert|erase|remove|quit|close without)\b/i;
export function agentMayPress(button: string | undefined | null): boolean {
  return !!button && !NOT_FOR_AGENT.test(String(button));
}

export interface DialogWatcher {
  /** Watch while one step runs. onChange(text, info) gets the hint and what the dialog says,
   *  again when it changes (a second dialog), and (null, null) once it has gone. Returns stop(). */
  watch(app: string, onChange: (text: string | null, info: DialogInfo | null) => void, opts?: { startAfterMs?: number; everyMs?: number }): () => void;
  /** A picture of the window the watcher last took for a dialog, if it is still up. */
  picture(app: string): Promise<Uint8Array | null>;
  /** Whose the dialog up in the app is. "komposit" only when a Komposit step was watched while
   *  it came up, the person wasn't in the app then, and it's still up. Everything else is the
   *  person's: one already up when a step started, one that came up while they were in the app,
   *  and one no step saw come up. */
  whose(app: string): Promise<"person" | "komposit">;
}

export interface DialogWatcherOptions {
  /** Is the person in this app right now (it's in front, Komposit's window away)? A dialog that
   *  comes up then is taken for theirs. Default: never. */
  personIn?: (app: string) => boolean;
}

export function createDialogWatcher(t: ScriptTransport, o: DialogWatcherOptions = {}): DialogWatcher {
  // The window the watcher last took for a dialog, per app: what a picture of it is made from.
  const lastDialogWindow = new Map<string, number>();
  // Whose the dialog the watcher last saw in each app was, and its windows.
  const owners = new Map<string, { owner: "person" | "komposit"; windows: number[] }>();
  const ownerOf = (app: string, baseline: WindowMap | null, fresh: number[]): "person" | "komposit" => {
    const known = owners.get(app);
    if (known && known.windows.some((id) => fresh.includes(id))) return known.owner;
    const appeared = fresh.filter((id) => !(baseline && baseline.has(id)));
    const owner = !appeared.length || o.personIn?.(app) ? "person" : "komposit";
    owners.set(app, { owner, windows: appeared.length ? appeared : fresh });
    return owner;
  };
  return {
    watch(app, onChange, { startAfterMs = 5000, everyMs = 2500 } = {}) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let baseline: WindowMap | null = null;
      let lastSeen = new Set<number>();
      let showing = false;
      let said = "";
      t.appWindows(app).then((m) => (baseline = m), () => {});
      const tick = async () => {
        if (stopped) return;
        const now = baseline ? await t.appWindows(app).catch(() => null) : null;
        if (stopped) return;
        if (now) {
          const fresh = newDialogs(baseline, now);
          const persistent = fresh.some((id) => lastSeen.has(id));
          lastSeen = new Set(fresh);
          const read = persistent ? await readDialog(t, app) : null;
          if (stopped) return;
          const titled = fresh.map((id) => now.get(id)).find((w) => w && w.layer === 8 && w.title) || null;
          if (read && layersMeanDialog(app, read, titled)) {
            lastDialogWindow.set(app, fresh[fresh.length - 1]);
            const theirs = ownerOf(app, baseline, fresh) === "person";
            const info = read.info ? { ...read.info, ...(theirs ? { theirs } : {}) } : null;
            const text = theirs ? theirDialogText(app, info) : dialogText(app, info);
            if (!showing || text !== said) {
              showing = true;
              said = text;
              onChange(text, info || { app, title: "", text: "", buttons: [], fields: 0, readable: false, ...(theirs ? { theirs } : {}) });
            }
          } else if ((!fresh.length || read) && showing) {
            // Gone, or the system sees no dialog in it (a progress bar, a hidden window).
            showing = false;
            said = "";
            onChange(null, null);
          }
        }
        timer = setTimeout(tick, everyMs);
      };
      timer = setTimeout(tick, startAfterMs);
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    },
    async picture(app) {
      const id = lastDialogWindow.get(app);
      if (!id || !t.dialogShot) return null;
      const now = await t.appWindows(app);
      if (!now || !now.has(id)) return null; // it has gone
      return t.dialogShot(id);
    },
    async whose(app) {
      const known = owners.get(app);
      if (!known || known.owner === "person") return "person";
      const now = await t.appWindows(app).catch(() => null);
      // Its windows have gone: what's up now came up unseen.
      if (now && !known.windows.some((id) => now.has(id))) return "person";
      return "komposit";
    },
  };
}

// Is a modal dialog up right now? Modal panels sit at window layer 8. Used for After
// Effects, whose script errors and alerts are modal and silently block every later
// script. (Illustrator keeps a permanent layer-8 window, so this isn't a reliable test
// there; the step watcher compares against a baseline.)
export async function modalDialogUp(t: ScriptTransport, app: string): Promise<boolean> {
  return hasModal(await t.appWindows(app).catch(() => null));
}

export interface AeReadiness {
  ok: boolean;
  code?: "AE_NOT_RUNNING" | "AE_DIALOG" | "AE_STARTING";
  message?: string;
  dialog?: DialogInfo | null;
}

// Before sending After Effects a script: is it open, finished starting, and free of
// dialogs? A script that arrives while AE is still starting shows a "Scripting Plugin is
// not installed" alert, and one sent while a dialog is up just queues behind it, so both
// are held back here. Waits up to `waitMs` for AE to finish starting.
export function createAeReady(t: ScriptTransport, { sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {}) {
  let readyPid: number | null = null;
  return async function aeReady({ waitMs = 90000 }: { waitMs?: number } = {}): Promise<AeReadiness> {
    const until = Date.now() + waitMs;
    for (;;) {
      const pid = await t.appPid("aftereffects");
      if (!pid) return { ok: false, code: "AE_NOT_RUNNING", message: "After Effects isn't open. Open it, wait for it to finish starting, then try again." };
      let wins = await t.appWindows("aftereffects");
      // The window After Effects shows while a script runs stays up to about 350 ms after it
      // returns: a modal that's gone within a second was that, not a dialog.
      for (let look = 0; look < 4 && hasModal(wins); look++) {
        await sleep(250);
        wins = await t.appWindows("aftereffects");
      }
      if (hasModal(wins)) {
        const info = await describeDialog(t, "aftereffects");
        const what =
          info && info.readable
            ? ` ${dialogText("aftereffects", info).replace(/^After Effects is showing a dialog/, "It").replace(/ Answer it and this carries on\.$/, "")}`
            : "";
        return {
          ok: false,
          code: "AE_DIALOG",
          dialog: info,
          message: `After Effects is showing a dialog, and won't run scripts until it's closed.${what} Read or answer it with the dialog tool, or ask the person to close it, then try again.`,
        };
      }
      if (readyPid === pid) return { ok: true };
      const main = !!wins && [...wins.values()].some((s) => s.layer === 0 && s.w >= 800 && s.h >= 500);
      if (main && (await t.processUptime(pid)) >= 15) {
        readyPid = pid;
        return { ok: true };
      }
      if (Date.now() >= until) return { ok: false, code: "AE_STARTING", message: "After Effects is still starting. Give it a moment, then try again." };
      await sleep(2000);
    }
  };
}
