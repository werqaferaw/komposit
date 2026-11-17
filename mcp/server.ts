// komposit-mcp: a standalone MCP server that lets any AI app (Claude Desktop, Claude Code,
// Codex, OpenCode...) work in the person's own creative apps through Komposit's open
// connectors. stdio, newline-delimited JSON-RPC 2.0. Nothing but JSON-RPC goes to stdout.
//
//   node mcp/server.ts            (from a checkout, Node 24)
//   node out/mcp/komposit-mcp.mjs (the bundle, Node 22+; build with node mcp/build.mjs)
//
// Environment:
//   KOMPOSIT_ALLOW_RISKY_SCRIPTS=1  run scripts the script check flags (files, commands, quitting, saving)
//   KOMPOSIT_EXPORT_DIR             where exports go by default (inside the home folder); default ~/Komposit Exports
//   KOMPOSIT_HELPER                 path to the Mac helper, to read the Automation permission without asking
//   KOMPOSIT_MCP_TEST_CONNECTORS    tests only: a module whose createConnectors() replaces the real connectors
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Platform } from "../protocol/common.ts";
import type { Connector } from "../protocol/connector.ts";
import type { ToolResult } from "../protocol/tools.ts";
import { loadConnectors } from "../connectors/index.ts";
import { callTool } from "./calls.ts";
import type { CallContext } from "./calls.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { createLanes } from "./lanes.ts";
import { listed, mcpTools } from "./tools.ts";

export const SERVER_NAME = "komposit-mcp";
export const SERVER_VERSION = "0.1.0"; // the open kit's own version (open/package.json)
/** MCP revisions this server speaks, newest first. A client asking for one of these gets it. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";

type Id = string | number;
interface Message { jsonrpc?: string; id?: Id | null; method?: string; params?: any; result?: unknown; error?: unknown }

export interface ServerOptions {
  connectors: Map<string, Connector>;
  platform: Platform | null;
  home: string;
  exportDir: string;
  allowRiskyScripts: boolean;
  /** One JSON-RPC message out (the caller frames it). */
  send(message: object): void;
}

export interface McpServer {
  /** One line from the client. */
  receive(line: string): void;
  /** Stop every call in flight (the client went away). */
  close(): void;
  /** Resolves when no call is in flight. */
  idle(): Promise<void>;
}

export function createServer(opts: ServerOptions): McpServer {
  const mod = opts.platform === "win" ? "Ctrl" : "Cmd";
  const tools = mcpTools(opts.connectors, mod);
  const ctx: CallContext = {
    connectors: opts.connectors,
    tools: new Map(tools.map((t) => [t.name, t])),
    lanes: createLanes(),
    rules: { home: opts.home, exportDir: opts.exportDir, projectRoots: [] },
    allowRiskyScripts: opts.allowRiskyScripts,
  };
  const inFlight = new Map<Id, AbortController>();
  const running = new Set<Promise<unknown>>();

  const reply = (id: Id, result: unknown) => opts.send({ jsonrpc: "2.0", id, result });
  const error = (id: Id | null, code: number, message: string) => opts.send({ jsonrpc: "2.0", id, error: { code, message } });

  async function request(id: Id, method: string, params: any): Promise<void> {
    switch (method) {
      case "initialize": {
        const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        return reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: "Komposit", version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: tools.map(listed) });
      case "tools/call": {
        const name = typeof params?.name === "string" ? params.name : "";
        if (!name) return error(id, -32602, "tools/call needs a tool name.");
        const ac = new AbortController();
        inFlight.set(id, ac);
        let result: ToolResult;
        try {
          result = await callTool(ctx, name, params?.arguments ?? {}, ac.signal);
        } finally {
          inFlight.delete(id);
        }
        if (ac.signal.aborted) return; // cancelled: the client expects no answer
        return reply(id, result);
      }
      // Asked for but not offered: empty lists rather than errors, for clients that probe.
      case "resources/list":
        return reply(id, { resources: [] });
      case "resources/templates/list":
        return reply(id, { resourceTemplates: [] });
      case "prompts/list":
        return reply(id, { prompts: [] });
      default:
        return error(id, -32601, `This server has no method "${method}".`);
    }
  }

  function notification(method: string, params: any): void {
    if (method === "notifications/cancelled") {
      const ac = params?.requestId != null ? inFlight.get(params.requestId) : undefined;
      ac?.abort();
    }
    // notifications/initialized and anything else: nothing to do.
  }

  function receive(line: string): void {
    const s = line.trim();
    if (!s) return;
    let msg: Message;
    try {
      msg = JSON.parse(s);
    } catch {
      return error(null, -32700, "That line wasn't valid JSON.");
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return error(null, -32600, "Expected one JSON-RPC message per line.");
    if (typeof msg.method !== "string") return; // a response to us: we never call the client
    const hasId = msg.id !== undefined && msg.id !== null;
    if (!hasId) return notification(msg.method, msg.params);
    const id = msg.id as Id;
    const p = request(id, msg.method, msg.params).catch((e) => error(id, -32603, `Komposit hit a problem: ${String((e as Error)?.message || e)}`));
    running.add(p);
    void p.finally(() => running.delete(p));
  }

  return {
    receive,
    close() {
      for (const ac of inFlight.values()) ac.abort();
    },
    async idle() {
      while (running.size) await Promise.allSettled([...running]);
    },
  };
}

export function currentPlatform(): Platform | null {
  return process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : null;
}

/** Start on stdin/stdout. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Anything a dependency logs goes to stderr: stdout carries only JSON-RPC.
  console.log = console.error;
  console.info = console.error;
  const home = homedir();
  const platform = currentPlatform();
  const exportDir = env.KOMPOSIT_EXPORT_DIR ? resolve(env.KOMPOSIT_EXPORT_DIR.replace(/^~(?=$|[\\/])/, home)) : join(home, "Komposit Exports");
  let connectors: Map<string, Connector>;
  if (env.KOMPOSIT_MCP_TEST_CONNECTORS) {
    const m = await import(pathToFileURL(resolve(env.KOMPOSIT_MCP_TEST_CONNECTORS)).href);
    connectors = await m.createConnectors({ home, exportDir });
  } else {
    connectors = platform ? loadConnectors(platform, { home, exportDir, scratchDir: join(tmpdir(), "komposit-mcp") }) : new Map();
  }
  const server = createServer({
    connectors,
    platform,
    home,
    exportDir,
    allowRiskyScripts: env.KOMPOSIT_ALLOW_RISKY_SCRIPTS === "1",
    send: (m) => process.stdout.write(JSON.stringify(m) + "\n"),
  });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => server.receive(line));
  rl.on("close", () => {
    server.close();
    void server.idle().then(() => process.exit(0));
  });
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((e) => {
    process.stderr.write(`komposit-mcp couldn't start: ${String((e as Error)?.message || e)}\n`);
    process.exit(1);
  });
}
