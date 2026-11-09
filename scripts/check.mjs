// `npm run check`: syntax-check every module, the UI and the build scripts
// (node --check), on any OS. Exits 1 on the first file that doesn't parse.
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
const add = (dir, depth, test) => {
  for (const n of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, n);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory() && depth > 0 && n !== "node_modules") add(rel, depth - 1, test);
    else if (st.isFile() && test(n)) files.push(rel);
  }
};
add("companion", 1, (n) => n.endsWith(".mjs")); // companion/*.mjs and companion/*/*.mjs
files.push(join("ui", "app.js"), join("ui", "horizon.js"), join("web", "build.mjs"));
add(join("packaging", "windows"), 0, (n) => n.endsWith(".mjs"));
add("scripts", 0, (n) => n.endsWith(".mjs"));

for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", join(ROOT, f)], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
}
console.log(`syntax ok: ${files.length} files`);
