// One call at a time per app: creative apps run one script at a time, and two scripts that
// interleave can leave a document half-changed. Different apps still work side by side.

export interface Lanes {
  /** Run `fn` after every earlier call to the same app has finished. A call stopped while it
   *  waits never starts. */
  run<T>(app: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export class StoppedError extends Error {
  constructor(message = "Stopped before it ran, so nothing changed.") {
    super(message);
  }
}

export function createLanes(): Lanes {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(app: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const prev = tails.get(app) || Promise.resolve();
      const next = prev.then(() => {
        if (signal?.aborted) throw new StoppedError();
        return fn();
      });
      const settled = next.then(() => undefined, () => undefined);
      tails.set(app, settled);
      void settled.then(() => {
        if (tails.get(app) === settled) tails.delete(app);
      });
      return next;
    },
  };
}
