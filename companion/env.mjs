// Zero-dep .env loader. Reads komposit/.env once into process.env (without
// overriding anything already set in the real environment), then exposes a
// tiny typed accessor. No dotenv dependency — keeps the tree lean.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotenv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotenv();

// Expand a leading ~ to the user's home directory.
export function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

export const env = {
  port: Number(process.env.PORT || 4321),
  maxToolCalls: Number(process.env.MAX_TOOL_CALLS || 40),
  renderMaxPx: Number(process.env.RENDER_MAX_PX || 1024),
  exportDir: expandHome(process.env.EXPORT_DIR || "~/Komposit Exports"),
};

export { ROOT };
