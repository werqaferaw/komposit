// Komposit as an MCP server. Exposes the live Adobe document as MCP tools over
// stdio, so a Claude client you're already signed into (Claude Code, Claude
// Desktop) can drive your document on your own plan. The Claude Code engine
// (engines/cli.mjs) uses this same server. Zero-dep, newline-delimited JSON-RPC 2.0 (the MCP stdio transport).
//
// Register it once (per app), then just talk to your Claude:
//   claude mcp add komposit -- node <abs>/companion/mcp/doc-server.mjs --app illustrator
import { getBridge, APPS } from "../bridges/index.mjs";
import { toolSchemas, executeTool } from "../harness/tools.mjs";

const argv = process.argv;
const appIdx = argv.indexOf("--app");
const app = (appIdx !== -1 && argv[appIdx + 1]) || process.env.APP || "illustrator";
const bridge = getBridge(app);
const DEFAULT_PROTOCOL = "2024-11-05";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// Map our executeTool content → MCP content blocks.
function toMcpContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return (content || []).map((b) =>
    b.type === "image"
      ? { type: "image", data: b.source.data, mimeType: b.source.media_type }
      : { type: "text", text: b.text || "" },
  );
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "notifications/initialized") return; // ack, no reply
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "komposit", version: "0.0.1" },
      },
    });
  }
  if (method === "tools/list") {
    const tools = toolSchemas(bridge).map((t) => ({
      name: t.name,
      description: t.description + ` Acts on the active ${app} document by default; pass "app" to target another (${APPS.join("/")}).`,
      inputSchema: {
        ...t.input_schema,
        properties: {
          ...(t.input_schema.properties || {}),
          app: { type: "string", enum: APPS, description: `Which Adobe app's active document to act on. Default: ${app}.` },
        },
      },
    }));
    return send({ jsonrpc: "2.0", id, result: { tools } });
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const a = args || {};
    const useApp = a.app && APPS.includes(a.app) ? a.app : app; // per-call app override
    const { app: _drop, ...toolArgs } = a;
    try {
      const r = await executeTool(getBridge(useApp), name, toolArgs);
      return send({ jsonrpc: "2.0", id, result: { content: toMcpContent(r.content), isError: !!r.is_error } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e.message || e) }], isError: true } });
    }
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

// stdout is the protocol channel — status goes to stderr.
process.stderr.write(`komposit MCP server ready (app: ${app})\n`);
