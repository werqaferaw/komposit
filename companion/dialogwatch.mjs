// Notices when an Adobe app puts up a dialog while Komposit is waiting on it.
// A dialog blocks scripting, so a step would otherwise just hang with no hint.
//
// How: list the app's windows when a step starts (the platform layer: on a Mac
// CoreGraphics through JXA, about 0.1 s and no extra permission; on Windows the
// app's top-level windows), then look again every few seconds. A NEW window
// that stays up across two looks is almost certainly a dialog; brief ones (the
// throwaway document an export opens) are ignored. Layer 8 means a modal
// dialog, 0 a normal window, on both platforms.
import platform from "./platform/index.mjs";

const LABEL = { illustrator: "Illustrator", photoshop: "Photoshop", aftereffects: "After Effects" };

// Map of window id -> { w, h, layer } for the app's windows, or null if unreadable.
export function appWindows(app) {
  return platform.appWindows(app);
}

// New windows big enough to be a dialog (not a tooltip or a menu).
export function newDialogs(baseline, now) {
  const out = [];
  for (const [id, s] of now) if (!baseline.has(id) && s.w >= 150 && s.h >= 80) out.push(id);
  return out;
}

export function dialogText(app) {
  return `${LABEL[app] || "The app"} seems to be showing a dialog. Close it and this carries on.`;
}

// Watch while one step runs. onChange(text) gets the hint, or null once the
// dialog is gone. Returns stop().
export function watchForDialog(app, onChange, { startAfterMs = 5000, everyMs = 2500 } = {}) {
  let stopped = false;
  let timer = null;
  let baseline = null;
  let lastSeen = new Set();
  let showing = false;
  appWindows(app).then((m) => (baseline = m));
  const tick = async () => {
    if (stopped) return;
    const now = baseline ? await appWindows(app) : null;
    if (stopped) return;
    if (now) {
      const fresh = newDialogs(baseline, now);
      const persistent = fresh.some((id) => lastSeen.has(id));
      lastSeen = new Set(fresh);
      if (persistent && !showing) {
        showing = true;
        onChange(dialogText(app));
      } else if (!fresh.length && showing) {
        showing = false;
        onChange(null);
      }
    }
    timer = setTimeout(tick, everyMs);
  };
  timer = setTimeout(tick, startAfterMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// Is a modal dialog up right now? Modal panels sit at window layer 8. Used for
// After Effects, whose script errors and alerts are modal and silently block
// every later script. (Illustrator keeps a permanent layer-8 window, so this
// isn't a reliable test there; the step watcher compares against a baseline.)
export async function modalDialogUp(app) {
  const m = await appWindows(app);
  if (!m) return false;
  for (const s of m.values()) if (s.layer === 8 && s.w >= 150 && s.h >= 80) return true;
  return false;
}

// Before sending After Effects a script: is it open, finished starting, and
// free of dialogs? A script that arrives while AE is still starting shows a
// "Scripting Plugin is not installed" alert, and one sent while a dialog is up
// just queues behind it, so both are held back here. Waits up to `waitMs` for
// AE to finish starting. Returns { ok } or { ok:false, code, message }.
let _aeReadyPid = null;
export async function aeReady({ waitMs = 90000 } = {}) {
  const until = Date.now() + waitMs;
  for (;;) {
    const pid = await aePid();
    if (!pid) return { ok: false, code: "AE_NOT_RUNNING", message: "After Effects isn't open. Open it, wait for it to finish starting, then try again." };
    const wins = await appWindows("aftereffects");
    if (wins) {
      for (const s of wins.values()) {
        if (s.layer === 8 && s.w >= 150 && s.h >= 80) {
          return { ok: false, code: "AE_DIALOG", message: "After Effects is showing a dialog, and won't run scripts until it's closed. Close it in After Effects, then try again." };
        }
      }
    }
    if (_aeReadyPid === pid) return { ok: true };
    const main = wins && [...wins.values()].some((s) => s.layer === 0 && s.w >= 800 && s.h >= 500);
    if (main && (await uptimeSeconds(pid)) >= 15) {
      _aeReadyPid = pid;
      return { ok: true };
    }
    if (Date.now() > until) return { ok: false, code: "AE_STARTING", message: "After Effects is still starting. Give it a moment, then try again." };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function aePid() {
  return platform.appPid("aftereffects");
}

function uptimeSeconds(pid) {
  return platform.processUptime(pid);
}
