// Model replies can take minutes to begin: a busy Gemini queued a short reply
// for over four minutes in testing. Node's fetch gives up after 300 s with no
// response headers (and 300 s between body chunks), which would cut such a
// turn off. For this process, swap in the same kind of connection pool with
// longer waits. The global symbol is the one undici's own setGlobalDispatcher
// uses, and the class comes from the pool Node already made, so no extra
// package is needed. The person's Stop still ends a request at once.
const KEY = Symbol.for("undici.globalDispatcher.1");

export async function allowSlowReplies({ minutes = 20 } = {}) {
  try {
    if (!globalThis[KEY]) await fetch("data:,").catch(() => {}); // makes Node create its pool
    const current = globalThis[KEY];
    const Agent = current?.constructor;
    if (typeof Agent !== "function" || current.__komposit) return false;
    const ms = minutes * 60_000;
    const agent = new Agent({ headersTimeout: ms, bodyTimeout: ms, keepAliveTimeout: 10_000 });
    agent.__komposit = true;
    globalThis[KEY] = agent;
    return true;
  } catch {
    return false; // keep Node's defaults
  }
}
