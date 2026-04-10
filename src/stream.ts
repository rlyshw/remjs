/**
 * createStateStream — v0.1 compatibility shim.
 *
 * Wraps a single state object via the v0.2 `createObserver` primitive
 * and exposes the v0.1 return shape (`state`, `snapshot`, `flush`,
 * `dispose`). Existing demos and consumers that pass a single root
 * object continue to work without changes — though the emitted ops
 * are now in the v0.2 ref-addressed shape, not the v0.1 path-addressed
 * shape. v0.1 op-shape consumers (i.e. tests asserting on the wire
 * format directly) need to update; v0.1 *behavior* consumers (i.e.
 * apps that just call `state.foo = bar` and ship ops over a transport)
 * are unaffected.
 *
 * For new code prefer `createObserver()` directly — it supports
 * multiple tracked roots, returns the registry, and admits the future
 * `observeGlobal()` / `hookFramework()` capture mechanisms.
 */

import { createObserver, type ObserverOptions } from "./observer.js";
import type { Op, SnapshotOp } from "./ops.js";

export type BatchMode = ObserverOptions["batchMode"];

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
  /** Build a graph snapshot of the current state. */
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
  const observer = createObserver({
    onOps: options.onOps,
    batchMode: options.batch,
  });
  const state = observer.track(initial);
  return {
    state,
    snapshot: () => observer.snapshot(),
    flush: () => observer.flush(),
    dispose: () => observer.destroy(),
  };
}
