#!/usr/bin/env node
// Builds the standalone MCP server into one file: out/mcp/komposit-mcp.mjs (the
// `komposit-mcp` command). Run: npm run build
import { build } from "esbuild";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = ["mcp/komposit-mcp.ts", "mcp/main.ts", "mcp/cli.ts", "mcp/index.ts", "mcp/server.ts"];
const entry = candidates.map((c) => join(ROOT, c)).find((p) => existsSync(p));
if (!entry) {
  console.error("No MCP server entry found in mcp/, so there is nothing to build.");
  process.exit(1);
}
const outfile = join(ROOT, "out", "mcp", "komposit-mcp.mjs");

// Files read at run time, like each connector's guide.md, are found with
// new URL("./guide.md", import.meta.url). In one bundled file import.meta.url is the
// bundle, so point those URLs back at the source folders, which ship with the package.
const keepFileUrls = {
  name: "keep-file-urls",
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      const src = readFileSync(args.path, "utf8");
      const fromOut = relative(dirname(outfile), dirname(args.path)).split(sep).join("/");
      const contents = src.replace(/new URL\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*,\s*import\.meta\.url\s*\)/g,
        (_m, q, rel) => `new URL(${q}${fromOut}/${rel}${q}, import.meta.url)`);
      return { contents, loader: "ts" };
    });
  },
};
try {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    plugins: [keepFileUrls],
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __kpRequire } from 'node:module'; const require = __kpRequire(import.meta.url);" },
    legalComments: "none",
    logLevel: "silent",
  });
} catch (e) {
  console.error(`The build failed: ${e?.message || e}`);
  process.exit(1);
}
chmodSync(outfile, 0o755);
console.log(`Built ${outfile}`);
