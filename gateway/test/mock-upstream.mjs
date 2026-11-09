// A stand-in for api.anthropic.com, for testing the gateway without spending money.
//
// POST /v1/messages answers like the Messages API: SSE when the body has
// "stream": true, a JSON Message otherwise. Every request is recorded (headers,
// parsed body, what was sent back, whether the client hung up early) so tests can
// check exactly what the gateway forwarded.
//
// metadata.user_id in the request body selects a special behaviour:
//   "mock:slow"        stream a delta every 50 ms for ~10 s (client-disconnect tests)
//   "mock:overloaded"  answer 529 overloaded_error, like Anthropic under load
//
// Standalone, for poking at `npm run dev` by hand (start it with
// --var UPSTREAM_BASE:http://127.0.0.1:8788):
//   node test/mock-upstream.mjs [port]
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MOCK_TEXT = "Hello from the mock upstream";
export const MOCK_STREAM_USAGE = { input_tokens: 25, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 15 };
export const MOCK_JSON_USAGE = { input_tokens: 11, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 };

export async function startMockUpstream({ port = 0, host = "127.0.0.1", verbose = false } = {}) {
  const calls = [];
  let seq = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = JSON.parse(rawBody);
      } catch {
        // leave body null; tests can inspect rawBody
      }
      const id = ++seq;
      const call = {
        id,
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body,
        rawBody,
        requestId: `req_mock_${id}`,
        status: null,
        sent: "",
        finished: false,
        clientClosedEarly: false,
      };
      calls.push(call);
      if (verbose) logCall(call);
      respond(call, req, res);
    });
  });

  function respond(call, req, res) {
    const base = {
      "request-id": call.requestId,
      // Headers about the owner's account that the gateway must not pass on.
      "anthropic-organization-id": "org_mock_must_not_leak",
      "anthropic-ratelimit-requests-limit": "4000",
    };
    const send = (status, headers, text) => {
      call.status = status;
      call.sent = text;
      res.writeHead(status, { ...base, ...headers });
      res.end(text, () => (call.finished = true));
    };

    if (call.method !== "POST" || !call.url.startsWith("/v1/messages")) {
      return send(404, { "content-type": "application/json" }, errorJson("not_found_error", "Not found"));
    }
    if (!call.body) {
      return send(400, { "content-type": "application/json" }, errorJson("invalid_request_error", "Invalid JSON"));
    }

    const mode = call.body.metadata?.user_id;
    const model = call.body.model;
    if (mode === "mock:overloaded") {
      return send(
        529,
        { "content-type": "application/json", "x-should-retry": "true", "retry-after": "7" },
        errorJson("overloaded_error", "Overloaded"),
      );
    }
    if (call.body.stream !== true) {
      return send(200, { "content-type": "application/json" }, JSON.stringify(jsonMessage(call.id, model)));
    }

    call.status = 200;
    res.writeHead(200, {
      ...base,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.on("close", () => {
      if (!call.finished) call.clientClosedEarly = true;
    });
    const frames = mode === "mock:slow" ? slowFrames(call.id, model) : sseFrames(call.id, model);
    const delay = mode === "mock:slow" ? 50 : 2;
    writeFrames(res, frames, delay, call);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();

  return {
    url: `http://${host}:${address.port}`,
    calls,
    lastCall: () => calls[calls.length - 1],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// Write SSE frames one at a time, each split in two, so events straddle chunk
// boundaries the way they do on a real network.
function writeFrames(res, frames, delayMs, call) {
  let i = 0;
  const next = () => {
    if (res.destroyed) return;
    if (i >= frames.length) {
      res.end(() => (call.finished = true));
      return;
    }
    const frame = frames[i++];
    const cut = Math.floor(frame.length / 2);
    call.sent += frame;
    res.write(frame.slice(0, cut));
    res.write(frame.slice(cut));
    setTimeout(next, delayMs);
  };
  next();
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(id, model, usage) {
  return sse("message_start", {
    type: "message_start",
    message: {
      id: `msg_mock_${id}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage, output_tokens: 1 },
    },
  });
}

function sseFrames(id, model) {
  const words = ["Hello", " from", " the mock", " upstream"];
  return [
    messageStart(id, model, MOCK_STREAM_USAGE),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("ping", { type: "ping" }),
    ...words.map((text) =>
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    ),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: MOCK_STREAM_USAGE.output_tokens },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

function slowFrames(id, model) {
  const deltas = Array.from({ length: 200 }, (_, n) =>
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ` word${n}` } }),
  );
  return [
    messageStart(id, model, MOCK_STREAM_USAGE),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ...deltas,
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 400 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

function jsonMessage(id, model) {
  return {
    id: `msg_mock_${id}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: MOCK_TEXT }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: MOCK_JSON_USAGE,
  };
}

function errorJson(type, message) {
  return JSON.stringify({ type: "error", error: { type, message } });
}

function logCall(call) {
  const headers = Object.entries(call.headers).map(([name, value]) =>
    name === "x-api-key" || name === "authorization" ? `${name}: <redacted, ${String(value).length} chars>` : `${name}: ${value}`,
  );
  console.log(
    `#${call.id} ${call.method} ${call.url} model=${call.body?.model} stream=${call.body?.stream === true} max_tokens=${call.body?.max_tokens}\n  ${headers.join("\n  ")}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8788);
  const mock = await startMockUpstream({ port, verbose: true });
  console.log(`Mock Anthropic upstream on ${mock.url} (Ctrl-C to stop)`);
}
