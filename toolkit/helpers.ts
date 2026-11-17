// Script helpers kept for a chat: the AI defines its drawing helpers, colors and lookups once
// (edit's `helpers`), and every later edit in the same app in the same chat gets them in front
// of its code, so it doesn't write them out again. On Nov 16 a fifth of all edit code was
// functions the AI had already sent in the same chat ("I can't save a shared helper file
// here, so I'll include the drawing setup in each step"), and writing it out again is most of
// the silence before a long step.
//
// Helpers are top-level `function name(...) {...}` declarations and `var` (or `const`) lines,
// nothing else, so keeping them can't run anything by itself. One with a name already kept
// replaces the old one. Errors keep pointing at the AI's own lines: a line inside the helpers is
// named as such ("in helper rgb, its line 2"), and a line in the code counts from the code.
import { maskScript } from "./scriptcheck.ts";

export interface Helper {
  /** The names it defines (a function's name; a var line's variables). */
  names: string[];
  code: string;
}

/** All of a chat's helpers for one app, together, at most this many characters. */
export const HELPERS_MAX = 32 * 1024;

const ID = /^[A-Za-z_$][\w$]*/;

/** The helpers in `src`, or why it can't be kept. */
export function parseHelpers(src: string): { helpers: Helper[] } | { error: string } {
  const text = String(src || "").replace(/\r\n?/g, "\n");
  const { bare } = maskScript(text);
  const out: Helper[] = [];
  const n = text.length;
  let i = 0;
  let start = 0; // where the current helper's text starts (its comments come with it)
  const skipSpace = () => { while (i < n && /\s/.test(bare[i]!)) i++; };
  // From `from`, the index just after the bracket that closes the one at `from`.
  const close = (from: number): number => {
    let depth = 0;
    for (let k = from; k < n; k++) {
      const c = bare[k];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (--depth === 0) return k + 1; }
    }
    return -1;
  };
  while (true) {
    skipSpace();
    if (i >= n) break;
    const rest = bare.slice(i);
    const fn = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
    if (fn) {
      const params = close(i + fn[0].length - 1);
      const open = params < 0 ? -1 : bare.indexOf("{", params);
      const end = open < 0 || bare.slice(params, open).trim() ? -1 : close(open);
      if (end < 0) return { error: `the function ${fn[1]} in helpers isn't complete (a bracket is missing)` };
      i = end;
      while (i < n && /[ \t;]/.test(bare[i]!)) i++;
      out.push({ names: [fn[1]!], code: text.slice(start, i).trim() });
      start = i;
      continue;
    }
    const v = /^(var|const)\s+/.exec(rest);
    if (v) {
      // To the `;` (or the end of the line) outside any brackets.
      let k = i + v[0].length;
      let depth = 0;
      const names: string[] = [];
      let expectName = true;
      for (; k < n; k++) {
        const c = bare[k]!;
        if (expectName && depth === 0 && /[A-Za-z_$]/.test(c)) {
          const m = ID.exec(bare.slice(k))!;
          names.push(m[0]);
          k += m[0].length - 1;
          expectName = false;
          continue;
        }
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (depth === 0 && c === ",") expectName = true;
        else if (depth === 0 && c === ";") { k++; break; }
        else if (depth === 0 && c === "\n") {
          const next = bare.slice(k).trimStart();
          if (!next || /^(function|var|const)\b/.test(next)) break;
        }
      }
      if (depth !== 0) return { error: `a var line in helpers isn't complete (a bracket is missing)` };
      if (!names.length) return { error: "a var line in helpers names no variable" };
      i = k;
      out.push({ names, code: text.slice(start, i).trim() });
      start = i;
      continue;
    }
    const line = text.slice(i).split("\n")[0]!.trim();
    return { error: `helpers can only hold function declarations and var lines, and this is neither: ${line.length > 80 ? line.slice(0, 77) + "..." : line}` };
  }
  if (!out.length) return { error: "helpers has no function or var in it" };
  // Compiles? (Node reads ES3; a syntax error here would break every later edit.)
  for (const h of out) {
    try {
      new Function(h.code);
    } catch (e) {
      return { error: `${h.names.join(", ")} in helpers doesn't compile: ${(e as Error).message}` };
    }
  }
  return { helpers: out };
}

/** The kept helpers with `added` in: one with a name already kept replaces the old one. */
export function mergeHelpers(kept: Helper[], added: Helper[]): Helper[] {
  const names = new Set(added.flatMap((h) => h.names));
  return [...kept.filter((h) => !h.names.some((x) => names.has(x))), ...added];
}

export const helpersSize = (list: Helper[]) => list.reduce((s, h) => s + h.code.length + 1, 0);

/** The text that goes in front of the code. */
export function helpersPrefix(list: Helper[]): string {
  return list.map((h) => h.code).join("\n");
}

/** The code with the helpers in front, and how many lines they take. */
export function withHelpers(list: Helper[], code: string): { code: string; lines: number } {
  if (!list.length) return { code, lines: 0 };
  const prefix = helpersPrefix(list);
  return { code: `${prefix}\n${code}`, lines: prefix.split("\n").length };
}

/** An error's "(line N)" put back in the AI's own lines: a line in the code counts from the
 *  code, and one inside the helpers names the helper. */
export function mapHelperLine(message: string, list: Helper[], lines: number): string {
  if (!lines) return message;
  return message.replace(/\(line (\d+)\)/, (all, n: string) => {
    const at = Number(n);
    if (at > lines) return `(line ${at - lines})`;
    let first = 1;
    for (const h of list) {
      const count = h.code.split("\n").length;
      if (at < first + count) return `(in helper ${h.names[0]}, its line ${at - first + 1})`;
      first += count;
    }
    return all;
  });
}

/** Which kept helpers the code calls or reads (by name, outside strings and comments). */
export function helpersUsed(list: Helper[], code: string): string[] {
  const { bare } = maskScript(String(code || ""));
  const out: string[] = [];
  for (const h of list) {
    for (const name of h.names) {
      const re = new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
      if (re.test(bare)) out.push(name);
    }
  }
  return out;
}
