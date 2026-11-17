// Finds the modules a JavaScript or TypeScript file imports, the way the language reads it:
// comments, string contents, template text and regular expressions are skipped, so a script
// carried inside a template string (an ExtendScript or JXA snippet that says `from "..."` or
// `import(...)`) is never taken for an import. Used by check-boundaries.mjs.
//
//   importsOf(source) -> [{ spec: "./x.ts", kind: "import" | "export" | "dynamic" | "require", typeOnly: boolean }]
//
// It covers `import ... from "x"`, `import "x"`, `import type`, `export ... from "x"`,
// `import("x")`, `require("x")` and `import x = require("x")`. Specifiers that aren't plain
// strings (`import(someVariable)`) are not modules it can name, so they're left out.

const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$_‌‍]/u;
// After these words an expression starts, so a `/` begins a regular expression.
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends"]);

/** Splits source into the tokens that matter here: words, strings (with their value), punctuation. */
export function tokenize(src) {
  const tokens = [];
  const braces = []; // "{" for a block or object, "${" for a template expression
  let i = 0;
  const n = src.length;
  const last = () => tokens[tokens.length - 1];
  const regexAllowed = () => {
    const t = last();
    if (!t) return true;
    if (t.type === "string" || t.type === "template" || t.type === "number" || t.type === "regex") return false;
    if (t.type === "word") return BEFORE_EXPRESSION.has(t.value);
    return !(t.value === ")" || t.value === "]" || t.value === "}");
  };

  // Reads template text from i (just after "`" or after the "}" closing a "${"), up to the
  // closing "`" (pushes one template token) or the next "${" (goes back to code).
  const readTemplate = () => {
    while (i < n) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; tokens.push({ type: "template" }); return; }
      if (c === "$" && src[i + 1] === "{") { i += 2; braces.push("${"); return; }
      i++;
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "﻿" || c === " " || c === " " || c === " ") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? n : end + 2; continue; }
    if (c === "#" && i === 0 && src[1] === "!") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === '"' || c === "'") {
      let value = "";
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") { value += src[i + 1] ?? ""; i += 2; continue; }
        value += src[i++];
      }
      i++;
      tokens.push({ type: "string", value });
      continue;
    }
    if (c === "`") { i++; readTemplate(); continue; }
    if (c === "/" && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        const r = src[i];
        if (r === "\\") { i += 2; continue; }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < n && ID_PART.test(src[i])) i++; // flags
      tokens.push({ type: "regex" });
      continue;
    }
    if (c === "{") { braces.push("{"); tokens.push({ type: "punct", value: c }); i++; continue; }
    if (c === "}") {
      i++;
      if (braces.pop() === "${") { readTemplate(); continue; }
      tokens.push({ type: "punct", value: c });
      continue;
    }
    if (ID_START.test(c) || c === "\\") {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      tokens.push({ type: "word", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9" || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      tokens.push({ type: "number" });
      i = j;
      continue;
    }
    tokens.push({ type: "punct", value: c });
    i++;
  }
  return tokens;
}

/** The modules `src` imports or re-exports, in the order they appear. */
export function importsOf(src) {
  const t = tokenize(src);
  const found = [];
  const isWord = (k, w) => t[k]?.type === "word" && (w === undefined || t[k].value === w);
  const isPunct = (k, p) => t[k]?.type === "punct" && t[k].value === p;
  const isString = (k) => t[k]?.type === "string";
  const afterDot = (k) => isPunct(k - 1, "."); // obj.import, obj?.require

  // From k, skip an import/export clause (names, braces, commas, `*`, `as`, `type`) and
  // return the index of the string after `from`, or -1.
  const fromString = (k) => {
    let depth = 0;
    for (; k < t.length; k++) {
      const x = t[k];
      if (x.type === "punct" && x.value === "{") { depth++; continue; }
      if (x.type === "punct" && x.value === "}") { if (--depth < 0) return -1; continue; }
      if (depth === 0 && x.type === "word" && x.value === "from" && isString(k + 1)) return k + 1;
      if (x.type === "word" || (x.type === "punct" && (x.value === "," || x.value === "*"))) continue;
      if (depth > 0 && x.type === "string") continue; // import { "a-b" as ab } from "x"
      return -1;
    }
    return -1;
  };

  for (let k = 0; k < t.length; k++) {
    if (t[k].type !== "word" || afterDot(k)) continue;
    const w = t[k].value;
    if (w === "import") {
      if (isPunct(k + 1, ".")) continue; // import.meta
      if (isPunct(k + 1, "(")) {
        if (isString(k + 2) && (isPunct(k + 3, ")") || isPunct(k + 3, ","))) found.push({ spec: t[k + 2].value, kind: "dynamic", typeOnly: false });
        continue;
      }
      if (isString(k + 1)) { found.push({ spec: t[k + 1].value, kind: "import", typeOnly: false }); continue; }
      const typeOnly = isWord(k + 1, "type") && !isWord(k + 2, "from") && !isPunct(k + 2, ",") && !isPunct(k + 2, "=");
      // import x = require("y")
      let e = k + 1 + (typeOnly ? 1 : 0);
      if (isWord(e) && isPunct(e + 1, "=") && isWord(e + 2, "require") && isPunct(e + 3, "(") && isString(e + 4)) {
        found.push({ spec: t[e + 4].value, kind: "require", typeOnly });
        k = e + 4;
        continue;
      }
      const s = fromString(k + 1);
      if (s > 0) { found.push({ spec: t[s].value, kind: "import", typeOnly }); k = s; }
      continue;
    }
    if (w === "export") {
      const typeOnly = isWord(k + 1, "type");
      const start = k + 1 + (typeOnly ? 1 : 0);
      if (!(isPunct(start, "{") || isPunct(start, "*"))) continue; // export const/function/default...
      const s = fromString(start);
      if (s > 0) { found.push({ spec: t[s].value, kind: "export", typeOnly }); k = s; }
      continue;
    }
    if (w === "require" && isPunct(k + 1, "(") && isString(k + 2) && isPunct(k + 3, ")")) {
      found.push({ spec: t[k + 2].value, kind: "require", typeOnly: false });
    }
  }
  return found;
}

/** The npm package a bare specifier names ("@scope/pkg/sub" -> "@scope/pkg"), or null for a path or a Node built-in. */
export function packageOf(spec) {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("#")) return null;
  return spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
}
