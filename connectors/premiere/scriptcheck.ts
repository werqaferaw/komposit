// What an edit in Premiere Pro may not do, checked before anything is sent. Premiere's
// scripts act on whichever project is active, and an edit is only checked against the
// project it names when it starts, so an edit may not save, open, close or switch projects,
// quit Premiere, or reach into the other open projects (app.projects). Saving goes through
// the save tool, only when the person asks; the rest is the person's (or the open tool's).
//
// Comments and the insides of strings are ignored, so "// never call save() here" passes;
// the bracket form (p['save']()) is caught too. A determined script could still get past a
// scan (code built at run time); the core's own script check asks the person about that.

const REASONS = {
  save: "saves the project",
  close: "closes a project",
  open: "opens another project (which would then be the active one)",
  quit: "quits Premiere Pro",
  projects: "reaches into the other open projects (app.projects)",
} as const;

// Characters after which a `/` starts a regular expression rather than a division.
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** `code` with comments blanked out, and `bare` with the insides of strings and regular
 *  expressions blanked out too; both the same length as the source. */
export function maskCode(src: string): { code: string; bare: string } {
  const code = src.split("");
  const bare = src.split("");
  const n = src.length;
  const blank = (arr: string[], a: number, b: number) => { for (let k = a; k < b && k < n; k++) if (arr[k] !== "\n") arr[k] = " "; };
  let prev = "";
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      blank(code, i, j); blank(bare, i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j === -1 ? n : j + 2;
      blank(code, i, j); blank(bare, i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || (c === "/" && REGEX_AFTER.has(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const e = src[j];
        if (e === "\\") { j += 2; continue; }
        if (c === "/") {
          if (e === "[") inClass = true;
          else if (e === "]") inClass = false;
          else if (e === "/" && !inClass) break;
        } else if (e === c) break;
        j++;
      }
      blank(bare, i + 1, j);
      prev = "a";
      i = j < n && src[j] !== "\n" ? j + 1 : j;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code: code.join(""), bare: bare.join("") };
}

const snip = (src: string, index: number) => {
  const start = src.lastIndexOf("\n", index) + 1;
  let end = src.indexOf("\n", index);
  if (end === -1) end = src.length;
  const line = src.slice(start, end).trim();
  return line.length > 100 ? line.slice(0, 97) + "..." : line;
};

/** Null when the edit may run; otherwise the plain refusal (nothing was sent). */
export function refuseScript(src: string): string | null {
  const { code, bare } = maskCode(String(src || ""));
  const found: { what: string; snippet: string }[] = [];
  const add = (what: string, index: number) => { if (!found.some((f) => f.what === what)) found.push({ what, snippet: snip(src, index) }); };
  const methods: [RegExp, string][] = [
    [/\.\s*(?:save|saveAs)\s*\(/g, REASONS.save],
    [/\.\s*closeDocument\s*\(/g, REASONS.close],
    [/\.\s*(?:openDocument|newProject)\s*\(/g, REASONS.open],
    [/\bapp\s*\.\s*quit\s*\(/g, REASONS.quit],
    [/\.\s*projects\b/g, REASONS.projects],
  ];
  for (const [re, what] of methods) for (const m of bare.matchAll(re)) add(what, m.index ?? 0);
  // The same names in brackets: p['save'](), app["projects"].
  const NAMES: Record<string, string> = { save: REASONS.save, saveAs: REASONS.save, closeDocument: REASONS.close, openDocument: REASONS.open, newProject: REASONS.open, quit: REASONS.quit, projects: REASONS.projects };
  for (const m of code.matchAll(/\[\s*(["'])(save|saveAs|closeDocument|openDocument|newProject|quit|projects)\1\s*\]/g)) add(NAMES[m[2]!]!, m.index ?? 0);
  if (!found.length) return null;
  return (
    `edit didn't run, so nothing changed: this script ${found.map((f) => f.what).join(", and ")} (${found.map((f) => f.snippet).join(" | ")}). ` +
    "In Premiere Pro an edit works in the one project it names: saving goes through the save tool (only when the person asks), " +
    "opening a project through the open tool, closing or switching projects is the person's, and the other open projects are only read, with documents."
  );
}
