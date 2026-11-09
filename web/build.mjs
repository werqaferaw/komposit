// Copy the UI into ./public for the web. The hosted page gets the download
// links instead of the local-only token slot.
//   node build.mjs
//   KOMPOSIT_DOWNLOAD_URL=https://.../Komposit-mac.dmg \
//   KOMPOSIT_DOWNLOAD_URL_WIN=https://.../Komposit-Setup-win.exe node build.mjs
//
// The defaults are the stable "latest release" links of the public downloads
// repo, so they keep working when a new version is published.
import { mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, "..", "ui");
const out = join(here, "public");
const RELEASES = "https://github.com/werqaferaw/komposit/releases/latest/download";
const mac = process.env.KOMPOSIT_DOWNLOAD_URL || `${RELEASES}/Komposit-mac.dmg`;
const win = process.env.KOMPOSIT_DOWNLOAD_URL_WIN || `${RELEASES}/Komposit-Setup-win.exe`;

// Every static file the page loads (index.html is rewritten below). Only these
// types; anything else in ui/ stays local.
const ASSETS = new Set([".js", ".css", ".svg", ".png", ".ico", ".woff2"]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const copied = [];
for (const f of readdirSync(ui)) {
  if (!ASSETS.has(extname(f).toLowerCase()) || !statSync(join(ui, f)).isFile()) continue;
  copyFileSync(join(ui, f), join(out, f));
  copied.push(f);
}

const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const html = readFileSync(join(ui, "index.html"), "utf8").replace(
  "<!--komposit:local-->",
  `<meta name="komposit-download" content="${attr(mac)}"><meta name="komposit-download-win" content="${attr(win)}">`,
);
if (html.includes("komposit-token")) throw new Error("the hosted page must not carry a token");
// Every local script and stylesheet the page references must have been copied.
for (const m of html.matchAll(/(?:src|href)="([a-z0-9_.-]+\.(?:js|css|svg))"/gi)) {
  if (!copied.includes(m[1])) throw new Error(`index.html loads ${m[1]}, which is not in ui/`);
}
writeFileSync(join(out, "index.html"), html);
console.log(`built ./public: ${copied.join(", ")}, index.html`);
console.log(`  Mac download:     ${mac}`);
console.log(`  Windows download: ${win}`);
