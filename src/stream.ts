/**
 * createStateStream — the main public API.
 *
 * Wraps an initial state object in deep proxies that emit ops on mutation.
 * Ops are batched according to `batch` and handed to `onOps` as an array.
 * The caller is responsible for shipping the batch somewhere (WebSocket,
 * postMessage, in-memory bus, etc).
 */

import { encode } from "./codec.js";
import type { Op, SnapshotOp } from "./ops.js";
import { wrap } from "./proxy.js";

export type BatchMode = "sync" | "microtask" | "raf" | number;

export interface StreamOptions {
  /** Called with a non-empty batch of ops after each flush. */
  onOps?: (ops: Op[]) => void;
  /**
   * When to flush pending ops:
   * - "sync":     flush immediately on every mutation (no batching)
   * - "microtask": flush at the end of the current microtask (default)
   * - "raf":      flush on the next animation frame (browser only)
   * - number:     flush after N milliseconds
   */
  batch?: BatchMode;
}

export interface StateStream<T> {
  /** Proxied state — mutate normally to produce ops. */
  readonly state: T;
  /** Build a full snapshot of the current state as a single op. */
  snapshot(): SnapshotOp;
  /** Force an immediate flush of any pending ops. */
  flush(): void;
  /** Stop emitting ops. Further mutations are still applied but not streamed. */
  dispose(): void;
}

export function createStateStream<T extends object>(
  initial: T,
  options: StreamOptions = {},
): StateStream<T> {
  const { onOps, batch = "microtask" } = options;

  let pending: Op[] = [];
  let scheduled = false;
  let disposed = false;

  const flush = () => {
    scheduled = false;
    if (pending.length === 0) return;
    const toSend = pending;
    pending = [];
    if (!disposed) onOps?.(toSend);
  };

  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    if (batch === "sync") {
      flush();
    } else if (batch === "microtask") {
      queueMicrotask(flush);
    } else if (batch === "raf" && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else if (typeof batch === "number") {
      setTimeout(flush, batch);
    } else {
      queueMicrotask(flush);
    }
  };

  const emit = (op: Op) => {
    if (disposed) return;
    pending.push(op);
    schedule();
  };

  const state = wrap(initial, [], emit);

  return {
    state,
    snapshot: () => ({ type: "snapshot", value: encode(initial) }),
    flush,
    dispose: () => {
      disposed = true;
    },
  };
}
