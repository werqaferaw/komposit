// JSON-RPC 2.0 over any Transport. Both ends are "peers": each can call the other and
// send notifications. Used window <-> core, core <-> shell, phone <-> core (sealed).

export interface RpcRequest { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }
export interface RpcErrorBody { code: number; message: string; data?: unknown }
export interface RpcResponse { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: RpcErrorBody }
export interface RpcNotification { jsonrpc: "2.0"; method: string; params?: unknown }
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export interface Transport {
  send(message: RpcMessage): void;
  /** Returns an unsubscribe function. */
  onMessage(listener: (message: RpcMessage) => void): () => void;
  close?(): void;
}

/** A failure the other side should see as a plain sentence (message) plus a stable code. */
export class RpcFailure extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const RpcCodes = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  cancelled: -32800,
  timeout: -32801,
  closed: -32802,
} as const;

export type Handler = (params: any, context: { method: string }) => unknown | Promise<unknown>;

export interface Peer {
  call<R = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<R>;
  notify(method: string, params?: unknown): void;
  /** Listen for notifications of one method. Returns an unsubscribe function. */
  on(method: string, listener: (params: any) => void): () => void;
  handle(method: string, handler: Handler): void;
  dispose(): void;
}

export function createPeer(transport: Transport, handlers: Record<string, Handler> = {}): Peer {
  let nextId = 1;
  let disposed = false;
  const table = new Map<string, Handler>(Object.entries(handlers));
  const pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void }>();
  const listeners = new Map<string, Set<(params: any) => void>>();

  const reply = (id: number | string, body: { result?: unknown; error?: RpcErrorBody }) => {
    if (!disposed) transport.send({ jsonrpc: "2.0", id, ...body });
  };

  const onRequest = async (msg: RpcRequest) => {
    const handler = table.get(msg.method);
    if (!handler) return reply(msg.id, { error: { code: RpcCodes.methodNotFound, message: `Unknown method ${msg.method}` } });
    try {
      const result = await handler(msg.params, { method: msg.method });
      reply(msg.id, { result: result === undefined ? null : result });
    } catch (err) {
      const e = err as Partial<RpcFailure> & Error;
      reply(msg.id, { error: { code: typeof e.code === "number" ? e.code : RpcCodes.internal, message: e.message || "Something went wrong.", data: e.data } });
    }
  };

  const unsubscribe = transport.onMessage((msg) => {
    if (disposed || !msg || (msg as RpcMessage).jsonrpc !== "2.0") return;
    if ("id" in msg && msg.id !== undefined && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p.cleanup();
      if (msg.error) p.reject(new RpcFailure(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if ("method" in msg && "id" in msg && msg.id !== undefined) {
      void onRequest(msg as RpcRequest);
      return;
    }
    if ("method" in msg) {
      const set = listeners.get(msg.method);
      if (set) for (const l of [...set]) {
        try { l(msg.params); } catch { /* a listener's failure is its own */ }
      }
    }
  });

  return {
    call(method, params, opts = {}) {
      if (disposed) return Promise.reject(new RpcFailure(RpcCodes.closed, "The connection is closed."));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          pending.delete(id);
          cleanup();
          reject(new RpcFailure(RpcCodes.cancelled, "Cancelled."));
        };
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
        };
        if (opts.timeoutMs) timer = setTimeout(() => {
          pending.delete(id);
          cleanup();
          reject(new RpcFailure(RpcCodes.timeout, "No answer in time."));
        }, opts.timeoutMs);
        if (opts.signal) {
          if (opts.signal.aborted) return onAbort();
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, cleanup });
        transport.send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      if (!disposed) transport.send({ jsonrpc: "2.0", method, params });
    },
    on(method, listener) {
      let set = listeners.get(method);
      if (!set) listeners.set(method, (set = new Set()));
      set.add(listener);
      return () => { set!.delete(listener); };
    },
    handle(method, handler) {
      table.set(method, handler);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const [, p] of pending) {
        p.cleanup();
        p.reject(new RpcFailure(RpcCodes.closed, "The connection closed."));
      }
      pending.clear();
      listeners.clear();
    },
  };
}

/** Two linked in-memory transports, for tests and headless runs. */
export function memoryTransportPair(): [Transport, Transport] {
  const make = () => ({ listeners: new Set<(m: RpcMessage) => void>() });
  const a = make();
  const b = make();
  const deliver = (to: typeof a, m: RpcMessage) => {
    const copy = JSON.parse(JSON.stringify(m)) as RpcMessage;
    queueMicrotask(() => { for (const l of [...to.listeners]) l(copy); });
  };
  const side = (self: typeof a, other: typeof a): Transport => ({
    send: (m) => deliver(other, m),
    onMessage: (l) => { self.listeners.add(l); return () => { self.listeners.delete(l); }; },
    close: () => { self.listeners.clear(); },
  });
  return [side(a, b), side(b, a)];
}

/** A typed view of a peer for a method map like wire.ts Methods. */
export interface TypedClient<M extends { [K in keyof M]: { params: unknown; result: unknown } }, N extends object = Record<string, unknown>> {
  call<K extends keyof M & string>(method: K, params: M[K]["params"], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<M[K]["result"]>;
  on<K extends keyof N & string>(method: K, listener: (params: N[K]) => void): () => void;
  dispose(): void;
}

export function typed<M extends { [K in keyof M]: { params: unknown; result: unknown } }, N extends object = Record<string, unknown>>(peer: Peer): TypedClient<M, N> {
  return {
    call: (method, params, opts) => peer.call(method, params, opts),
    on: (method, listener) => peer.on(method, listener as (p: any) => void),
    dispose: () => peer.dispose(),
  };
}
