// The bundle: one file, a shebang, and the connectors' guides inside it. It is started with
// the real connectors but only asked for its tool list and guides, which never reach an app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startClient, textOf } from "./testing/client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const supported = process.platform === "darwin" || process.platform === "win32";

test("the bundle runs on its own and serves the guides", { skip: !supported && "the connectors need macOS or Windows" }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kmcp-build-")));
  try {
    const out = join(dir, "komposit-mcp.mjs");
    execFileSync(process.execPath, [join(HERE, "build.mjs"), out], { stdio: "pipe" });
    const src = readFileSync(out, "utf8");
    assert.ok(src.startsWith("#!/usr/bin/env node\n"));
    if (process.platform !== "win32") assert.ok(statSync(out).mode & 0o100, "executable");
    assert.ok(!/new URL\(\s*["']\.\/guide\.md/.test(src), "no guide is read from disk");
    assert.ok(!src.includes(HERE), "no local paths in the bundle");

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: dir };
    delete env.KOMPOSIT_MCP_TEST_CONNECTORS;
    const c = startClient(process.execPath, [out], env);
    try {
      const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      assert.equal(init.result.serverInfo.name, "komposit-mcp");
      const { tools } = (await c.request("tools/list")).result;
      assert.deepEqual(tools.map((t: any) => t.name), ["apps", "documents", "inspect", "edit", "render", "listen", "export", "save", "undo", "preflight", "place", "open", "new_document", "guide"]);
      for (const app of ["illustrator", "photoshop", "aftereffects"]) {
        const g = await c.call("guide", { app });
        assert.ok(!g.isError, textOf(g));
        assert.match(textOf(g), /Topics \(ask the guide for one by name, or "all"\)/, app);
      }
      const topic = await c.call("guide", { app: "illustrator", topic: "bounds" });
      assert.match(textOf(topic), /geometricBounds/);
    } finally {
      assert.equal(await c.close(), 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
