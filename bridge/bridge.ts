// The bridge: the tiny program an AI's own process starts to reach Komposit's toolbox.
// It speaks MCP's stdio transport (newline-delimited JSON-RPC) on stdin/stdout and relays
// every line to the core over the private local socket, presenting the run's pass first.
//
//   KOMPOSIT_SOCKET  the socket (or Windows named pipe) the core serves the toolbox on
//   KOMPOSIT_PASS    this run's pass
//
// When the core can't be reached (or the pass is refused), the AI still gets an answer it
// can show: every request is answered with a JSON-RPC error whose message is a plain
// sentence ("Komposit isn't running."), and the bridge exits.
//
// No imports beyond Node's own: it's bundled into one file (bridge/build.ts) and runs on
// plain Node or on Electron as Node (ELECTRON_RUN_AS_NODE=1), in development and on Windows.
// The Mac app has a native twin instead, `komposit-helper bridge` (helper/mac/Sources/
// Bridge.swift), so its Electron never needs to run as Node; bridge.test.ts puts both through
// the same cases.
import { connect, type Socket } from "node:net";

const NOT_RUNNING = "Komposit isn't running.";
const NO_ANSWER = "Komposit isn't answering.";
const STOPPED = "Komposit stopped before this finished.";
const CONNECT_MS = 10_000;
/** With nothing to answer, an offline bridge waits this long for a request before it goes. */
const OFFLINE_WAIT_MS = 30_000;

type State = "connecting" | "relaying" | "offline";

let state: State = "connecting";
let offlineMessage = NOT_RUNNING;
let exiting = false;
const queued: string[] = [];
/** Requests sent to the core and not answered yet (JSON id -> id), answered if it goes away. */
const inflight = new Map<string, unknown>();
let sock: Socket | undefined;

const write = (line: string) => { process.stdout.write(line + "\n"); };
const errorReply = (id: unknown, message: string) => write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));

function exit(code = 0) {
  if (exiting) return;
  exiting = true;
  // Let stdout drain first, so the last answer reaches the AI.
  process.stdout.write("", () => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}

/** Each complete line of a decoded stream (setEncoding, so a character split between two reads
 *  stays whole), without the newline. Line ends are looked for only in each new piece and a
 *  line's pieces are joined once, so a long line costs its length once. */
function lines(onLine: (line: string) => void) {
  let parts: string[] = [];
  return (chunk: string) => {
    let from = 0;
    let nl: number;
    while ((nl = chunk.indexOf("\n", from)) !== -1) {
      parts.push(chunk.slice(from, nl));
      let line = parts.join("");
      parts = [];
      from = nl + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
    }
    if (from < chunk.length) parts.push(chunk.slice(from));
  };
}

function requestId(line: string): { id: unknown } | null {
  try {
    const msg = JSON.parse(line);
    if (msg && typeof msg === "object" && typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) return { id: msg.id };
  } catch { /* not JSON: the core ignores it too */ }
  return null;
}

function answerOffline(line: string): boolean {
  const req = requestId(line);
  if (!req) return false;
  errorReply(req.id, offlineMessage);
  return true;
}

function goOffline(message: string) {
  if (state === "offline") return;
  state = "offline";
  offlineMessage = message;
  if (sock) sock.destroy();
  let answered = false;
  for (const line of queued.splice(0)) answered = answerOffline(line) || answered;
  if (answered) exit(0);
  else setTimeout(() => exit(0), OFFLINE_WAIT_MS).unref();
}

function toCore(line: string) {
  const req = requestId(line);
  if (req) inflight.set(JSON.stringify(req.id), req.id);
  sock!.write(line + "\n");
}

function fromCore(line: string) {
  try {
    const msg = JSON.parse(line);
    if (msg && typeof msg === "object" && msg.method === undefined && msg.id !== undefined) inflight.delete(JSON.stringify(msg.id));
  } catch { /* pass it on as it came */ }
  write(line);
}

function main() {
  const socketPath = process.env.KOMPOSIT_SOCKET;
  const pass = process.env.KOMPOSIT_PASS;

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", lines((line) => {
    if (state === "relaying") toCore(line);
    else if (state === "connecting") queued.push(line);
    else if (answerOffline(line)) exit(0);
  }));
  process.stdin.on("end", () => {
    if (state === "relaying" && sock) sock.end();
    exit(0);
  });
  process.stdin.on("error", () => exit(0));
  process.stdout.on("error", () => process.exit(0)); // the AI went away

  if (!socketPath || !pass) return goOffline(NOT_RUNNING);

  const timer = setTimeout(() => { if (state === "connecting") goOffline(NO_ANSWER); }, CONNECT_MS);
  timer.unref();
  let handshaken = false;
  const s = connect(socketPath);
  sock = s;
  s.setEncoding("utf8");
  s.on("connect", () => { s.write(JSON.stringify({ komposit_pass: pass }) + "\n"); });
  s.on("data", lines((line) => {
    if (!handshaken) {
      handshaken = true;
      clearTimeout(timer);
      let ack: any = null;
      try { ack = JSON.parse(line); } catch { /* treated as refused */ }
      if (ack && ack.komposit === "ok") {
        state = "relaying";
        for (const q of queued.splice(0)) toCore(q);
        return;
      }
      return goOffline(ack && typeof ack.message === "string" && ack.message ? ack.message : NOT_RUNNING);
    }
    fromCore(line);
  }));
  s.on("error", () => { if (state === "connecting") goOffline(NOT_RUNNING); });
  s.on("close", () => {
    if (state === "connecting") return goOffline(NOT_RUNNING);
    if (state === "relaying") {
      // The core went away (it quit, or the run was stopped): say so for what's still open.
      for (const id of inflight.values()) errorReply(id, STOPPED);
      inflight.clear();
      exit(0);
    }
  });
}

main();
