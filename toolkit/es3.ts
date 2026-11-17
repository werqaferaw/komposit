// A look at ExtendScript edit code before it reaches the app, for the mistakes that are sure to
// fail there. ExtendScript is ES3: modern syntax doesn't compile, and the ES5 array methods
// aren't there, so `b.map(...)` throws halfway through a script, after some of its changes are
// already made (Nov 16). Refusing first costs the same round trip and leaves the document as it
// was. JSON needs nothing: every script gets its own JSON (connectors/_kit/envelope.ts).
//
// Only what can't be right is refused, outside strings and comments, and not when the code
// defines the method itself (`Array.prototype.map = ...`, `{ map: ... }`).
import { maskScript } from "./scriptcheck.ts";

const lineAt = (src: string, index: number) => src.slice(0, index).split("\n").length;
const snippet = (src: string, index: number) => {
  const l = src.split("\n")[lineAt(src, index) - 1]!.trim();
  return l.length > 90 ? l.slice(0, 87) + "..." : l;
};

/** Why ExtendScript can't run this code, or null. */
export function es3Problem(code: string): string | null {
  const src = String(code || "");
  const { bare } = maskScript(src);
  const found: { what: string; index: number }[] = [];
  const defines = (name: string) => new RegExp(`(\\.|\\b)${name}\\s*(:|=(?!=))|\\bfunction\\s+${name}\\b`).test(bare);

  const arrow = /=>/.exec(bare);
  if (arrow) found.push({ what: "an arrow function (=>); write function (x) { ... }", index: arrow.index });
  const tick = bare.indexOf("`");
  if (tick >= 0) found.push({ what: "a template string (`...`); join strings with +", index: tick });
  for (const m of bare.matchAll(/\.\s*(map|forEach|filter|reduce|some|every)\s*\(/g)) {
    if (defines(m[1]!)) continue;
    found.push({ what: `.${m[1]}(), which ES3 arrays don't have; use a for loop`, index: m.index ?? 0 });
    break;
  }
  for (const m of bare.matchAll(/\b(Object\s*\.\s*keys|Array\s*\.\s*isArray)\s*\(/g)) {
    const name = m[1]!.replace(/\s/g, "");
    if (defines(name.split(".")[1]!)) continue;
    const alt = name === "Object.keys" ? "use for (var k in o) with o.hasOwnProperty(k)" : "use x instanceof Array";
    found.push({ what: `${name}(), which ES3 doesn't have; ${alt}`, index: m.index ?? 0 });
    break;
  }
  if (!found.length) return null;
  found.sort((a, b) => a.index - b.index);
  const f = found[0]!;
  const more = found.length > 1 ? ` Also: ${found.slice(1).map((x) => x.what).join("; ")}.` : "";
  return `ExtendScript is ES3, and line ${lineAt(src, f.index)} uses ${f.what} (${snippet(src, f.index)}).${more}`;
}

/** A plain `.save()` in edit code: saving goes through the save tool. Null when there's none. */
export function scriptSaves(code: string): string | null {
  const src = String(code || "");
  const { bare } = maskScript(src);
  const m = /\.\s*save\s*\(\s*\)/.exec(bare);
  if (!m) return null;
  return `line ${lineAt(src, m.index)} saves the document (${snippet(src, m.index)}). A save inside a script is cancelled when it would need a dialog, and saving is the save tool's job: take it out, and call save (mode "overwrite") after the edit if the user asked to save`;
}
