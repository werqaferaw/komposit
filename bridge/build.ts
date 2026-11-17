// Bundles the bridge into one file the app ships (it runs on plain Node, or on Electron as
// Node with ELECTRON_RUN_AS_NODE=1). CommonJS, so it runs whatever folder it lands in.
//   node bridge/build.ts [out file]    default: out/bridge/komposit-bridge.cjs
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildBridge(outfile = join(here, "..", "out", "bridge", "komposit-bridge.cjs")): Promise<string> {
  await build({
    entryPoints: [join(here, "bridge.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    minify: false,
    legalComments: "none",
    logLevel: "silent",
  });
  return resolve(outfile);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildBridge(process.argv[2]).then((p) => console.log(`Bridge bundled: ${p}`), (e) => { console.error(e?.message || e); process.exit(1); });
}
