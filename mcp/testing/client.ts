// A tiny MCP client for the tests: spawns a server, sends newline-delimited JSON-RPC and
// matches answers to requests by id.
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface TestClient {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params?: unknown): Promise<any>;
  /** Like request, but hands back the id at once (to cancel it). */
  start(method: string, params?: unknown): { id: number; done: Promise<any> };
  notify(method: string, params?: unknown): void;
  /** Send a raw line; resolves with the next message that has no matching request. */
  raw(line: string): Promise<any>;
  call(name: string, args?: Record<string, unknown>): Promise<{ content: any[]; isError?: boolean }>;
  close(): Promise<number | null>;
  stderr(): string;
}

export function startClient(command: string, args: string[], env: NodeJS.ProcessEnv): TestClient {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (m: any) => void>();
  const strays: ((m: any) => void)[] = [];
  let err = "";
  let next = 1;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => (err += c));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    const w = typeof msg.id === "number" ? waiting.get(msg.id) : undefined;
    if (w) {
      waiting.delete(msg.id);
      w(msg);
    } else strays.shift()?.(msg);
  });
  const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
  const client: TestClient = {
    child,
    request(method, params) {
      return client.start(method, params).done;
    },
    start(method, params) {
      const id = next++;
      const done = new Promise((resolve) => {
        waiting.set(id, resolve);
        send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      });
      return { id, done };
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    },
    raw(line) {
      return new Promise((resolve) => {
        strays.push(resolve);
        child.stdin.write(line + "\n");
      });
    },
    async call(name, args = {}) {
      const r = await client.request("tools/call", { name, arguments: args });
      if (r.error) throw new Error(`tools/call ${name}: ${r.error.message}`);
      return r.result;
    },
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once("exit", (code) => resolve(code));
        child.stdin.end();
      });
    },
    stderr: () => err,
  };
  return client;
}

export const textOf = (r: { content: any[] }) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
