#!/usr/bin/env node
// Bundles the standalone MCP server into one file that runs on Node 22 or later:
//   node mcp/build.mjs [out file]     default: out/mcp/komposit-mcp.mjs
//
// The connectors read their guide.md next to their code at run time
// (guideLoader(new URL("./guide.md", import.meta.url))). One bundled file has no such
// neighbours, so this build puts each guide's text into the bundle instead.
import { build } from "esbuild";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const GUIDE_CALL = /guideLoader\(\s*new URL\(\s*["']\.\/guide\.md["']\s*,\s*import\.meta\.url\s*\)\s*\)/;

/** Every connector folder with a guide must load it the way this build knows how to inline. */
function checkConnectors() {
  const dir = join(root, "connectors");
  for (const name of readdirSync(dir)) {
    const guide = join(dir, name, "guide.md");
    const index = join(dir, name, "index.ts");
    if (!existsSync(guide) || !existsSync(index)) continue;
    if (!GUIDE_CALL.test(readFileSync(index, "utf8"))) {
      throw new Error(`connectors/${name}/index.ts loads its guide in a way this build can't bundle. Update mcp/build.mjs.`);
    }
  }
}

const inlineGuides = {
  name: "inline-guides",
  setup(b) {
    b.onLoad({ filter: /[\\/]connectors[\\/][^\\/]+[\\/]index\.ts$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      if (!GUIDE_CALL.test(src)) return { contents: src, loader: "ts" };
      const md = await readFile(join(dirname(args.path), "guide.md"), "utf8");
      // The guide helpers are named by a full path, so the boundary checks don't read this
      // generated line as an import of mcp/build.mjs itself.
      const kitGuide = JSON.stringify(join(dirname(args.path), "..", "_kit", "guide.ts"));
      const contents =
        `import { parseGuide as __kParseGuide, serveGuide as __kServeGuide } from ${kitGuide};\n` +
        src.replace(GUIDE_CALL, `((g) => async (topic?: string) => __kServeGuide(g, topic))(__kParseGuide(${JSON.stringify(md)}))`);
      return { contents, loader: "ts" };
    });
  },
};

export async function buildMcp(outfile = join(root, "out", "mcp", "komposit-mcp.mjs")) {
  checkConnectors();
  await build({
    entryPoints: [join(here, "server.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
    plugins: [inlineGuides],
    minify: false,
    legalComments: "none",
    logLevel: "silent",
  });
  const out = readFileSync(outfile, "utf8");
  if (/new URL\(\s*["']\.\/guide\.md/.test(out)) throw new Error("A guide is still read from disk in the bundle.");
  chmodSync(outfile, 0o755);
  return resolve(outfile);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMcp(process.argv[2] ? resolve(process.argv[2]) : undefined).then(
    (p) => console.log(`komposit-mcp bundled: ${p}`),
    (e) => {
      console.error(e?.message || e);
      process.exit(1);
    },
  );
}
