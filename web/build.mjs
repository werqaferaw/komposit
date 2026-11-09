// Build the hosted page into ./public: the UI from ../ui, plus harness.js, the
// agent loop and providers bundled for the browser (harness.mjs), so the page
// can run turns itself with keys kept in the browser. The hosted page gets the
// download links instead of the local-only token slot.
//   node build.mjs
//   KOMPOSIT_DOWNLOAD_URL=https://.../Komposit-mac.dmg \
//   KOMPOSIT_DOWNLOAD_URL_WIN=https://.../Komposit-Setup-win.exe node build.mjs
//
// The defaults are the stable "latest release" links of the public repo, so
// they keep working when a new version is published.
import { mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, "..", "ui");
const out = join(here, "public");
const RELEASES = "https://github.com/werqaferaw/komposit/releases/latest/download";

// Every static file the page loads (index.html is rewritten below). Only these
// types; anything else in ui/ stays local.
const ASSETS = new Set([".js", ".css", ".svg", ".png", ".ico", ".woff2"]);

// The harness for the browser. platform "browser" makes any Node built-in a
// build error, which is the guarantee that the loop runs in a page.
export async function bundleHarness({ outfile = join(out, "harness.js"), minify = true } = {}) {
  const { build } = await import("esbuild");
  const r = await build({
    entryPoints: [join(here, "harness.mjs")],
    outfile,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120", "firefox120", "safari17"],
    minify,
    legalComments: "eof",
    logLevel: "silent",
    metafile: true,
  });
  return { outfile, bytes: Object.values(r.metafile.outputs)[0]?.bytes || 0 };
}

async function main() {
  const mac = process.env.KOMPOSIT_DOWNLOAD_URL || `${RELEASES}/Komposit-mac.dmg`;
  const win = process.env.KOMPOSIT_DOWNLOAD_URL_WIN || `${RELEASES}/Komposit-Setup-win.exe`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const copied = [];
  for (const f of readdirSync(ui)) {
    if (!ASSETS.has(extname(f).toLowerCase()) || !statSync(join(ui, f)).isFile()) continue;
    copyFileSync(join(ui, f), join(out, f));
    copied.push(f);
  }
  const harness = await bundleHarness();
  copied.push("harness.js");

  const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  let html = readFileSync(join(ui, "index.html"), "utf8").replace(
    "<!--komposit:local-->",
    `<meta name="komposit-download" content="${attr(mac)}"><meta name="komposit-download-win" content="${attr(win)}">`,
  );
  if (html.includes("komposit-token")) throw new Error("the hosted page must not carry a token");
  // The hosted page runs turns itself: load the harness before the UI.
  const appTag = '<script src="app.js" defer></script>';
  if (!html.includes(appTag)) throw new Error("index.html no longer loads app.js the expected way");
  html = html.replace(appTag, `<script src="harness.js" defer></script>\n${appTag}`);
  // Every local script and stylesheet the page references must have been copied.
  for (const m of html.matchAll(/(?:src|href)="([a-z0-9_.-]+\.(?:js|css|svg))"/gi)) {
    if (!copied.includes(m[1])) throw new Error(`index.html loads ${m[1]}, which is not in ui/`);
  }
  writeFileSync(join(out, "index.html"), html);
  console.log(`built ./public: ${copied.join(", ")}, index.html`);
  console.log(`  harness.js:       ${(harness.bytes / 1024).toFixed(0)} KB`);
  console.log(`  Mac download:     ${mac}`);
  console.log(`  Windows download: ${win}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
