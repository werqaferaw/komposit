// Stand-in connectors for the server tests, loaded through KOMPOSIT_MCP_TEST_CONNECTORS.
// They never reach a real app. Every call is logged as one JSON line to
// KOMPOSIT_MCP_TEST_LOG ({ app, op, start, end, ... }), so a test can check what ran, in
// what order, and that nothing was saved behind its back.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppStatus, DocRef } from "../../protocol/common.ts";
import type { Connector, ConnectorManifest, FileResult } from "../../protocol/connector.ts";
import { tinyPng } from "../../connectors/_kit/fake.ts";

const LOG = process.env.KOMPOSIT_MCP_TEST_LOG || "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(entry: Record<string, unknown>): void {
  if (LOG) appendFileSync(LOG, JSON.stringify(entry) + "\n");
}

function manifest(id: string, label: string, extra: Partial<ConnectorManifest["capabilities"]> = {}): ConnectorManifest {
  return {
    id,
    label,
    maker: "Test",
    platforms: ["mac", "win"],
    door: "os-script",
    language: "extendscript",
    capabilities: { inspect: true, run: true, render: true, export: ["png", "pdf"], save: ["overwrite", "copy", "as"], undo: true, selection: true, newDocument: true, open: true, place: true, listen: true, ...extra },
  };
}

function fake(m: ConnectorManifest, running: boolean): Connector {
  const app = m.id;
  const docs: (DocRef & { active: boolean })[] = [{ app, name: "Poster.ai", path: "/v/Poster.ai", active: true }];
  // Logs one operation with its start and end times (ms).
  async function op<T>(name: string, fn: () => Promise<T> | T, more: Record<string, unknown> = {}): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      log({ app, op: name, start, end: Date.now(), ...more });
    }
  }
  const c: Connector = {
    manifest: m,
    async status(): Promise<AppStatus> {
      return { app, label: m.label, installed: true, running, ready: running, ...(running ? {} : { reason: `${m.label} isn't open.` }) };
    },
    documents: () => op("documents", () => docs),
    inspect: (doc) => op("inspect", () => ({ text: `Document ${doc?.name || docs[0]!.name}: 2 layers.`, picture: { bytes: tinyPng(8, 6), mime: "image/png" as const, width: 8, height: 6 } })),
    selection: async () => ({ summary: "Nothing selected." }),
    run: (code) => op("run", async () => {
      const wait = /SLEEP:(\d+)/.exec(code);
      if (wait) await sleep(Number(wait[1]));
      if (/THROW/.test(code)) return { ok: false, error: "boom is not defined (line 1)" };
      return { ok: true, result: { ran: code.length }, logs: [] };
    }, { code }),
    render: (_doc, opts) => op("render", () => ({ picture: { bytes: tinyPng(4, 3), mime: "image/png" as const }, ...(opts?.frames ? { pictures: Array.from({ length: opts.frames }, () => ({ bytes: tinyPng(4, 3), mime: "image/png" as const })) } : {}), note: "the active artboard \"Front\"" })),
    exportCopy: (o) => op("export", (): FileResult => {
      const path = join(o.outputDir!, `${o.name}.${o.format}`);
      // "wx": this fake fails rather than overwrite, so a test sees any attempt.
      writeFileSync(path, `${app} ${o.format} export`, { flag: "wx" });
      return { ok: true, path, note: "For screens.", sourceUnchanged: true };
    }, { name: o.name, outputDir: o.outputDir }),
    save: (o) => op("save", (): FileResult => {
      if (o.mode === "overwrite") return { ok: true, path: "/v/Poster.ai" };
      const path = join(o.outputDir!, `${o.name}.ai`);
      if (existsSync(path)) return { ok: false, error: "That file already exists." };
      writeFileSync(path, "saved copy", { flag: "wx" });
      return { ok: true, path };
    }, { mode: o.mode }),
    undo: () => op("undo", () => ({ ok: true })),
    preflight: () => op("preflight", () => ({ text: "Ready for print.", issues: [] })),
    newDocument: (o) => op("newDocument", () => ({ app, name: o.name || "Untitled-1" })),
    open: (path) => op("open", () => ({ app, name: path.split(/[\\/]/).pop() || "x", path })),
    place: (o) => op("place", () => ({ ok: true, path: o.file })),
    // A file is heard without the app; the timeline needs it.
    listen: (o, doc) => op("listen", () => ({ text: o.path ? `Sound of ${o.path.split(/[\\/]/).pop()}: 120 BPM.` : `Sound of ${doc?.name || docs[0]!.name}: a voice.`, picture: { bytes: tinyPng(6, 2), mime: "image/png" as const } }), { path: o.path ?? null }),
    guide: async (topic) => (topic ? `${m.label} recipes: ${topic}\n\nUse doc.pathItems.rectangle(top, left, w, h).` : `${m.label} recipes\n\nTopics:\n- shapes: rectangles and ellipses`),
  };
  return c;
}

export async function createConnectors(): Promise<Map<string, Connector>> {
  return new Map([
    ["illustrator", fake(manifest("illustrator", "Illustrator", { preflight: true }), true)],
    ["photoshop", fake(manifest("photoshop", "Photoshop"), true)],
    ["aftereffects", fake(manifest("aftereffects", "After Effects", { singleDocument: true }), false)],
  ]);
}
