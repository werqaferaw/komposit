// Preview render module. Shows the REAL artwork of files the user has OPEN in
// the apps: QuickLook is blank for .ai/.psd without an embedded preview, so
// instead we ask the app to render its open document. Results are cached by
// path (desktop.saveRender), so a doc is rendered at most once until it
// changes. Inactive docs are rendered without permanently stealing focus (the
// bridge activates, renders, then restores the previous active doc).
//
// Two rules keep this from getting in the agent's way:
//  - only apps that are already running are asked (asking a closed app would
//    launch it);
//  - never while an agent turn is working in that app (switching the active
//    document mid-edit could send the agent's edit to the wrong file).
import { extname } from "node:path";
import { getBridge } from "./bridges/index.mjs";
import { runningApps, EXT_APP } from "./desktop.mjs";

const busy = new Map(); // app -> count of turns working in it
export function markBusy(app, on) {
  const n = (busy.get(app) || 0) + (on ? 1 : -1);
  if (n <= 0) busy.delete(app);
  else busy.set(app, n);
}
export function isBusy(app) {
  return busy.has(app);
}

// Short-lived cache of each app's open documents, so marking a whole
// recent-file list doesn't fire one osascript call per file.
const _docs = new Map(); // app -> { t, docs }
async function openDocs(app) {
  const c = _docs.get(app);
  if (c && Date.now() - c.t < 4000) return c.docs;
  let docs = [];
  const running = await runningApps();
  if (running[app]) {
    try {
      docs = await getBridge(app).listDocuments();
    } catch {}
  }
  _docs.set(app, { t: Date.now(), docs });
  return docs;
}

export async function docStatus(path) {
  const app = EXT_APP[extname(path).toLowerCase()];
  if (!app) return { open: false };
  const docs = await openDocs(app);
  const d = docs.find((x) => x.path === path);
  return { app, open: !!d, active: !!(d && d.active), name: d && d.name };
}

// Render an open file to a PNG buffer, or null if it isn't open / can't render.
export async function renderOpenFile(path) {
  const st = await docStatus(path);
  if (!st.open || isBusy(st.app)) return null;
  try {
    const bridge = getBridge(st.app);
    const r = st.active ? await bridge.render() : await bridge.renderNamed(st.name);
    return r?.image?.data ? Buffer.from(r.image.data, "base64") : null;
  } catch {
    return null;
  }
}

// Annotate a recent-file list with open/active flags for the UI.
export async function markRecent(files) {
  for (const f of files) {
    try {
      const s = await docStatus(f.path);
      f.open = s.open;
      f.active = s.active;
    } catch {
      f.open = false;
    }
  }
  return files;
}
