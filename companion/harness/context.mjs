// What the person has selected, read live from the app as they send a message
// and put at the top of that message, so "this", "these" and "it" mean the
// actual selection instead of a guess. Read-only and quick; any failure (app
// closed, busy, no permission) just means no selection line.
import { getBridge } from "../bridges/index.mjs";
import { runningApps } from "../desktop.mjs";

export async function readSelection(app, { timeoutMs = 6000 } = {}) {
  let bridge;
  try {
    bridge = getBridge(app);
  } catch {
    return null;
  }
  if (!bridge.selection) return null;
  // Never launch an app just to read its selection.
  const running = await runningApps().catch(() => ({}));
  if (!running[app]) return null;
  let timer;
  try {
    return await Promise.race([
      bridge.selection(),
      new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), timeoutMs))),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The block that goes in front of the user's words for the model.
export function selectionBlock(app, sel) {
  if (!sel?.summary) return "";
  const label = getBridge(app).label;
  return `[Live selection in ${label} when this message was sent]\n${sel.summary}\n\n`;
}

// A short, quiet line for the step list ("Selected: Photo"), or null when
// there's nothing worth saying (nothing selected, no document).
export function selectionNote(app, sel) {
  const d = sel?.data;
  if (!d || d.noDocument) return null;
  const q = (s) => `"${String(s).replace(/\s+/g, " ").trim().slice(0, 40)}"`;
  const list = (names, total, noun) => {
    const shown = names.slice(0, 2).map(q).join(", ");
    return total === 1 ? shown : `${total} ${noun} (${shown}${total > 2 ? ", …" : ""})`;
  };
  if (app === "illustrator") {
    if (d.kind === "text") return `Selected text: ${q(d.text)}`;
    if (d.kind !== "items") return null;
    const names = d.items.map((it) => it.name || (it.text ? it.text : it.type.replace(/Item$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()));
    return `Selected: ${list(names, d.count, "items")}`;
  }
  if (app === "photoshop") {
    if (!d.layers?.length) return d.marquee ? "Selected: a marquee area" : null;
    const s = `Selected: ${list(d.layers.map((l) => l.name), d.count, "layers")}`;
    return d.marquee ? `${s}, inside a marquee` : s;
  }
  if (app === "aftereffects") {
    if (d.kind !== "comp") return null;
    if (d.props?.length) {
      const p = d.props[0];
      const more = d.props.length > 1 ? ` and ${d.props.length - 1} more` : "";
      return `Selected: ${p.path.split(" > ").pop()} on ${q(p.layer)}${more}`;
    }
    if (d.layers?.length) return `Selected: ${list(d.layers.map((l) => l.name), d.layers.length, "layers")}`;
    return null;
  }
  return null;
}
