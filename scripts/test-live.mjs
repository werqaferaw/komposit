// `npm run test:live`: the engine test plus the live checks against the Adobe
// apps that are open (KOMPOSIT_LIVE=1), on any OS. Pass an app name to run one.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["api-engine.test.mjs", "illustrator.live.test.mjs", "aftereffects.live.test.mjs"].map((f) => join(ROOT, "companion", "test", f));
const only = process.argv.slice(2); // e.g. `npm run test:live -- aftereffects`
const run = only.length ? files.filter((f) => only.some((o) => f.includes(o))) : files;
const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...run], { stdio: "inherit", env: { ...process.env, KOMPOSIT_LIVE: "1" } });
process.exit(r.status ?? 1);
