#!/usr/bin/env node
// Keeps the kit's layers honest: fails if a folder imports across a line it shouldn't,
// or if anything reaches outside the kit. Run: npm run check:boundaries
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { importsOf } from "./imports.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// area -> areas it may import from (besides itself, Node built-ins and npm packages)
const ALLOWED = {
  protocol: [],
  toolkit: ["protocol"],
  connectors: ["protocol"],
  mcp: ["protocol", "connectors", "toolkit"],
  skills: ["protocol", "connectors", "toolkit"],
  bridge: ["protocol"],
  helper: ["protocol"],
  scripts: [],
};
const AREAS = Object.keys(ALLOWED);
// runs in a browser too, so no Node built-ins outside its tests
const NO_NODE = ["protocol"];

const areaOf = (file) => AREAS.find((a) => file === a || file.startsWith(a + "/"));
const files = [];
const walk = (dir) => {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n === "node_modules" || n === "out" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mts|mjs|js|jsx)$/.test(n)) files.push(p);
  }
};
for (const a of AREAS) walk(join(ROOT, a));

const problems = [];
for (const f of files) {
  const rel = relative(ROOT, f).split(sep).join("/");
  const area = areaOf(rel);
  const src = readFileSync(f, "utf8");
  for (const { spec } of importsOf(src)) { // real imports only, not scripts carried in strings
    if (!spec) continue;
    if (spec.startsWith("node:")) {
      if (NO_NODE.includes(area) && !/\.test\.tsx?$/.test(rel)) problems.push(`${rel}: ${area} must not use Node built-ins (${spec})`);
      continue;
    }
    if (!spec.startsWith(".")) continue; // npm package
    const target = relative(ROOT, resolve(dirname(f), spec)).split(sep).join("/");
    if (target.startsWith("..")) { problems.push(`${rel}: imports a file outside the kit (${spec})`); continue; }
    const tArea = areaOf(target);
    if (!tArea) { problems.push(`${rel}: imports ${spec}, which is not part of the kit`); continue; }
    if (tArea === area) continue;
    if (!ALLOWED[area].includes(tArea)) problems.push(`${rel}: ${area} must not import ${tArea} (${spec})`);
  }
}
if (problems.length) {
  console.error(`Boundary check failed (${problems.length}):\n  ` + problems.join("\n  "));
  process.exit(1);
}
console.log(`Boundary check passed (${files.length} files).`);
