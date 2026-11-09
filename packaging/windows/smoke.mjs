// Smoke tests for the Windows build on a PC with NO Adobe apps (GitHub's
// windows-latest runner). They prove what can be proven without Illustrator,
// Photoshop and After Effects: the helper works, the platform layer reports
// "not installed" cleanly, paths are right, the bundled server starts and
// serves the UI behind its locks, the tray app's self-test passes, and the
// installer installs and uninstalls.
//
//   node packaging/windows/smoke.mjs [--installer dist/Komposit-Setup-<v>.exe]
//
// Prints one line per check and a summary; exits 1 if a required check fails.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGE = join(ROOT, "dist", "windows", "stage");
const NODE = join(STAGE, "node", "node.exe");
const HELPER = join(STAGE, "komposit-win.exe");
const TRAY = join(STAGE, "Komposit.exe");
const argInstaller = process.argv.indexOf("--installer");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const asked = argInstaller > 0 ? process.argv[argInstaller + 1] || "auto" : null;
// "--installer auto": the one build.mjs just wrote.
const INSTALLER = asked === "auto" ? join(ROOT, "dist", `Komposit-Setup-${VERSION}.exe`) : asked;

const results = [];
async function check(name, fn, { required = true } = {}) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, required });
    console.log(`  ok    ${name} (${Date.now() - t0} ms)${detail ? `: ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, required, error: e.message });
    console.log(`  ${required ? "FAIL" : "warn"}  ${name}: ${e.message}`);
  }
}
const assert = (c, msg) => {
  if (!c) throw new Error(msg);
};

function helper(...args) {
  const r = spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.status === 0 ? r.stdout : r.stderr); } catch {}
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const work = mkdtempSync(join(tmpdir(), "kp-smoke-"));
const dataDir = join(work, "data");
mkdirSync(dataDir, { recursive: true });
process.env.KOMPOSIT_DATA_DIR = dataDir;
process.env.KOMPOSIT_WIN_HELPER = HELPER;

console.log(`Komposit Windows smoke tests (stage ${STAGE})`);

// ---------- the helper ----------
console.log("helper (komposit-win.exe)");
await check("version", () => {
  const r = helper("version");
  assert(r.status === 0 && r.json?.version, `exit ${r.status} ${r.stderr}`);
  return `${r.json.version}, CLR ${r.json.clr}, 64-bit ${r.json.is64}`;
});
await check("procs finds this node.exe with a start time and a path", () => {
  const r = helper("procs", "--names", "node");
  assert(r.status === 0 && Array.isArray(r.json), `exit ${r.status} ${r.stderr}`);
  const me = r.json.find((p) => p.pid === process.pid);
  assert(me && me.startedMs && me.path, `not found: ${r.stdout.slice(0, 300)}`);
  return `${r.json.length} node processes; this one started ${Math.round((me.nowMs - me.startedMs) / 1000)} s ago`;
});
await check("windows lists top-level windows of explorer (may be none on a runner)", () => {
  const r = helper("windows", "--names", "explorer");
  assert(r.status === 0 && Array.isArray(r.json), `exit ${r.status} ${r.stderr}`);
  return `${r.json.length} windows`;
});
await check("folders: Desktop, Documents, Downloads exist", () => {
  const r = helper("folders");
  assert(r.status === 0, `exit ${r.status} ${r.stderr}`);
  for (const k of ["desktop", "documents", "downloads"]) assert(r.json[k], `no ${k}`);
  return `${r.json.desktop} | ${r.json.documents} | ${r.json.downloads}`;
});
await check("jsx against Illustrator says NOT_INSTALLED (exit 3), cleanly", () => {
  const script = join(work, "t.jsx");
  writeFileSync(script, "1+1");
  const r = helper("jsx", "--progid", "Illustrator.Application", "--script", script, "--out", join(work, "t.txt"));
  assert(r.status === 3 && r.json?.code === "NOT_INSTALLED", `exit ${r.status}: ${r.stderr}`);
  return r.json.error;
});
await check("jsx against Photoshop says NOT_INSTALLED", () => {
  const script = join(work, "t.jsx");
  const r = helper("jsx", "--progid", "Photoshop.Application", "--script", script, "--out", join(work, "t.txt"));
  assert(r.status === 3 && r.json?.code === "NOT_INSTALLED", `exit ${r.status}: ${r.stderr}`);
});
await check("thumb writes the Explorer thumbnail of a PNG", () => {
  const png = join(work, "probe.png");
  const out = join(work, "thumb.png");
  // A 1x1 PNG: Windows' own image thumbnailer handles it.
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const r = helper("thumb", "--path", png, "--out", out, "--size", "64");
  assert(r.status === 0 && existsSync(out), `exit ${r.status}: ${r.stderr}`);
  return `${readFileSync(out).length} bytes`;
}, { required: false });

// ---------- the platform layer, from the staged app ----------
console.log("platform layer (app/companion/platform/win.mjs)");
const win = await import(pathToFileURL(join(STAGE, "app", "companion", "platform", "win.mjs")).href);
await check("helperPath finds the bundled helper", async () => {
  const p = await win.helperPath();
  assert(p && p.toLowerCase() === HELPER.toLowerCase(), `got ${p}`);
});
await check("runningApps: none of the Adobe apps", async () => {
  const r = await win.runningApps();
  assert(r.illustrator === false && r.photoshop === false && r.aftereffects === false, JSON.stringify(r));
});
await check("installedApps: none", async () => {
  const r = await win.installedApps();
  assert(!r.illustrator && !r.photoshop && !r.aftereffects, JSON.stringify(r));
});
await check("automationState: not-running", async () => assert((await win.automationState("illustrator")) === "not-running", "?"));
await check("appWindows: an empty list, not an error", async () => {
  const m = await win.appWindows("aftereffects");
  assert(m instanceof Map && m.size === 0, String(m));
});
await check("designFolders: absolute paths for Desktop, Documents, Downloads", async () => {
  const f = await win.designFolders();
  for (const k of ["desktop", "documents", "downloads"]) assert(/^[a-z]:\\/i.test(f[k] || ""), `${k}: ${f[k]}`);
  return JSON.stringify(f);
});
await check("designFolders exist on this PC", async () => {
  const f = await win.designFolders();
  const missing = ["desktop", "documents", "downloads"].filter((k) => !existsSync(f[k]));
  assert(!missing.length, `missing: ${missing.join(", ")}`);
}, { required: false });
await check("isInside: case-insensitive, no ../ escapes", () => {
  const home = process.env.USERPROFILE;
  assert(win.isInside(home, join(home, "Desktop", "a.ai")), "inside");
  assert(win.isInside(home.toUpperCase(), join(home.toLowerCase(), "x")), "case");
  assert(!win.isInside(home, join(home, "..", "Public", "x")), "escape");
  assert(!win.isInside(home, "C:\\Windows\\x"), "outside");
});
await check("runJsx(illustrator) rejects with APP_NOT_INSTALLED", async () => {
  try {
    await win.runJsx("illustrator", "1+1", { timeoutMs: 20000 });
    throw new Error("resolved");
  } catch (e) {
    assert(e.code === "APP_NOT_INSTALLED", `${e.code}: ${e.message}`);
    return e.message;
  }
});
await check("runJsx(aftereffects) rejects with APP_NOT_INSTALLED", async () => {
  try {
    await win.runJsx("aftereffects", "1+1", { via: "file", timeoutMs: 20000 });
    throw new Error("resolved");
  } catch (e) {
    assert(e.code === "APP_NOT_INSTALLED", `${e.code}: ${e.message}`);
  }
});

// ---------- the server ----------
console.log("server (node.exe app/companion/server.mjs)");
let server = null;
let port = null;
await check("starts and says KOMPOSIT_READY", () =>
  new Promise((resolve, reject) => {
    server = spawn(NODE, [join(STAGE, "app", "companion", "server.mjs")], {
      cwd: join(STAGE, "app"),
      env: { ...process.env, KOMPOSIT_DATA_DIR: dataDir, KOMPOSIT_WIN_HELPER: HELPER },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no READY in 30 s: ${out.slice(-500)}`)), 30000);
    const onData = (d) => {
      out += d;
      const m = /KOMPOSIT_READY port=(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        port = Number(m[1]);
        resolve(`port ${port}`);
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.on("exit", (c) => reject(new Error(`exited ${c}: ${out.slice(-500)}`)));
  }),
);

const base = () => `http://127.0.0.1:${port}`;
const token = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).token;
const authed = (path, opts = {}) => fetch(base() + path, { ...opts, headers: { authorization: `Bearer ${token()}`, ...(opts.headers || {}) } });

if (port) {
  await check("GET /api/hello", async () => {
    const j = await (await fetch(base() + "/api/hello")).json();
    assert(j.komposit === true, JSON.stringify(j));
  });
  await check("GET / serves the UI with the token inlined", async () => {
    const h = await (await fetch(base() + "/")).text();
    assert(h.includes('name="komposit-token"') && h.includes("app.js"), h.slice(0, 200));
  });
  await check("GET /app.js and /horizon.js", async () => {
    for (const f of ["app.js", "horizon.js", "app.css"]) assert((await fetch(base() + "/" + f)).ok, f);
  });
  await check("/api/status says win32 and the data folder", async () => {
    const j = await (await authed("/api/status")).json();
    assert(j.platform === "win32" && j.dataDir === dataDir, JSON.stringify(j).slice(0, 300));
  });
  await check("/api/setup: apps not installed, folders need no prompt", async () => {
    const j = await (await authed("/api/setup")).json();
    for (const a of j.apps) assert(a.installed === false && a.running === false && a.automation === "not-running", JSON.stringify(a));
    assert(j.files.asked === true, JSON.stringify(j.files));
    return `claude installed: ${j.claude.installed}`;
  });
  await check("/api/workspace and /api/files", async () => {
    const w = await (await authed("/api/workspace")).json();
    assert(w.apps.every((a) => !a.running), JSON.stringify(w.apps));
    const f = await (await authed("/api/files")).json();
    assert(f.cwd && Array.isArray(f.dirs), JSON.stringify(f).slice(0, 200));
    return `browsing ${f.cwd}`;
  });
  await check("POST /api/setup/automation for a closed app: not-running", async () => {
    const j = await (await authed("/api/setup/automation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "photoshop" }) })).json();
    assert(j.automation === "not-running", JSON.stringify(j));
  });
  await check("a turn without an AI chosen is refused (409)", async () => {
    const r = await authed("/api/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi", app: "illustrator" }) });
    assert(r.status === 409, `status ${r.status}`);
  });
  await check("locks: wrong host 421, foreign origin 403, no token 401, form post 415", async () => {
    const http = await import("node:http");
    const raw = (headers, method = "GET", path = "/api/status") =>
      new Promise((res) => {
        const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (r) => res(r.statusCode));
        req.on("error", () => res(0));
        req.end(method === "POST" ? "a=1" : undefined);
      });
    assert((await raw({ host: "evil.example" })) === 421, "host");
    assert((await raw({ host: `127.0.0.1:${port}`, origin: "https://evil.example" })) === 403, "origin");
    assert((await raw({ host: `127.0.0.1:${port}` })) === 401, "token");
    assert((await raw({ host: `127.0.0.1:${port}`, authorization: `Bearer ${token()}`, "content-type": "application/x-www-form-urlencoded" }, "POST", "/api/stop")) === 415, "form");
  });
}
if (server) server.kill();

// ---------- the tray app ----------
console.log("tray app (Komposit.exe)");
await check("--selftest starts its own server, answers /api/hello, stops", () => {
  const out = join(work, "selftest.json");
  const r = spawnSync(TRAY, ["--selftest", "--out", out], { env: { ...process.env, KOMPOSIT_DATA_DIR: join(work, "data-tray") }, timeout: 90000, windowsHide: true });
  assert(existsSync(out), `no report (exit ${r.status}, ${r.error?.message || ""})`);
  const j = JSON.parse(readFileSync(out, "utf8"));
  assert(r.status === 0 && j.ok && j.icons && j.helper, JSON.stringify(j));
  return `port ${j.port}`;
});

// ---------- the installer ----------
if (INSTALLER) {
  console.log(`installer (${INSTALLER})`);
  const dir = join(work, "Komposit install");
  await check("silent per-user install", () => {
    const r = spawnSync(INSTALLER, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${dir}`, "/TASKS="], { timeout: 180000, windowsHide: true });
    assert(r.status === 0, `exit ${r.status}`);
    for (const f of ["Komposit.exe", "komposit-win.exe", "node\\node.exe", "app\\companion\\server.mjs", "app\\ui\\index.html", "unins000.exe"]) assert(existsSync(join(dir, f)), `missing ${f}`);
    const lnk = join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Komposit.lnk");
    assert(existsSync(lnk), `no Start menu entry at ${lnk}`);
    return dir;
  });
  await check("the installed tray app passes its self-test", () => {
    const out = join(work, "selftest-installed.json");
    const r = spawnSync(join(dir, "Komposit.exe"), ["--selftest", "--out", out], { env: { ...process.env, KOMPOSIT_WIN_HELPER: "", KOMPOSIT_DATA_DIR: join(work, "data-installed") }, timeout: 90000, windowsHide: true });
    const j = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
    assert(r.status === 0 && j?.ok, JSON.stringify(j));
  });
  await check("silent uninstall removes the app", async () => {
    const r = spawnSync(join(dir, "unins000.exe"), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { timeout: 120000, windowsHide: true });
    assert(r.status === 0, `exit ${r.status}`);
    // The uninstaller hands over to a copy of itself; wait for it to finish.
    for (let i = 0; i < 60 && existsSync(join(dir, "Komposit.exe")); i++) await new Promise((res) => setTimeout(res, 1000));
    assert(!existsSync(join(dir, "Komposit.exe")) && !existsSync(join(dir, "app")), "files remain");
  });
}

// Keep the tray and server logs with the results (CI uploads dist/windows/).
try {
  const logs = join(process.env.LOCALAPPDATA || "", "Komposit", "Logs");
  const keep = join(ROOT, "dist", "windows", "logs");
  if (existsSync(logs)) cpSync(logs, keep, { recursive: true });
} catch {}
rmSync(work, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok && r.required);
const warned = results.filter((r) => !r.ok && !r.required);
console.log(`\n${results.length - failed.length - warned.length}/${results.length} passed${warned.length ? `, ${warned.length} optional warning(s)` : ""}${failed.length ? `, ${failed.length} FAILED` : ""}`);
writeFileSync(join(ROOT, "dist", "windows", "smoke.json"), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
