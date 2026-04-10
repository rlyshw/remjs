/**
 * createObserver — the v0.2 source-side primitive.
 *
 * The JS-state analog of remdom's `createObserver`. Returns a handle that
 * owns:
 *   - an `ObjectRegistry` for stable id assignment to tracked objects
 *   - a batched op stream that flushes via the configured `batchMode`
 *   - lifecycle methods (`snapshot`, `flush`, `destroy`)
 *   - the `track(obj)` method which adds an object to be observed and
 *     returns a Proxy-wrapped version
 *
 * Multiple `track()` calls all feed the same op stream and share the
 * same registry, so cross-references between tracked objects are
 * preserved (an object referenced from another tracked object is itself
 * tracked, with the same id everywhere it appears).
 *
 * Unlike remdom's `createObserver` there's no `root` parameter — JS
 * state has no canonical root, and forcing one would be inventing
 * structure where none exists. The user adds tracked roots explicitly
 * via `track()`. Future v0.3+ adds higher-level capture mechanisms
 * (`observeGlobal()`, `hookFramework("react")`, etc.) on the same
 * observer object so explicit tracking and broader capture coexist.
 */

import { encodeContents } from "./codec.js";
import type { Op, SnapshotOp, EncodedValue } from "./ops.js";
import { wrap } from "./proxy.js";
import { createObjectRegistry, type ObjectRegistry } from "./registry.js";

export type BatchMode = "sync" | "microtask" | "raf" | number;

export interface ObserverOptions {
  /** Called with a non-empty batch of ops after each flush. */
  onOps?: (ops: Op[]) => void;
  /** Optional shared registry. If omitted, the observer creates its own. */
  registry?: ObjectRegistry;
  /** When to flush pending ops. Default: "microtask". */
  batchMode?: BatchMode;
  /** Periodically emit a fresh snapshot every N ops to correct drift.
   *  0 (default) disables. Matches remdom's resyncInterval. */
  resyncInterval?: number;
}

export interface JsObserver {
  /** Add an object to be observed. Returns a Proxy-wrapped version that
   *  emits ops on every mutation. The original object is also tagged in
   *  the registry so cross-references between tracked objects preserve
   *  identity on both sides. */
  track<T extends object>(obj: T): T;
  /** Build a graph snapshot of every currently-tracked object. */
  snapshot(): SnapshotOp;
  /** Force-flush any pending batched ops to onOps. */
  flush(): void;
  /** Stop emitting ops. Already-installed proxies still work but
   *  mutations through them are silently dropped. */
  destroy(): void;
  /** The shared registry — exposed for sharing across observers,
   *  for debug inspection, or for snapshot inspection. */
  readonly registry: ObjectRegistry;
}

export function createObserver(options: ObserverOptions = {}): JsObserver {
  const {
    onOps,
    registry = createObjectRegistry(),
    batchMode = "microtask",
    resyncInterval = 0,
  } = options;

  let pending: Op[] = [];
  let scheduled = false;
  let destroyed = false;
  let opsSinceResync = 0;

  /** Set of explicitly tracked root ids — every `track(obj)` adds one.
   *  Snapshot uses this to know which ids are "top-level" vs reachable. */
  const rootIds = new Set<string>();

  const flush = (): void => {
    scheduled = false;
    if (pending.length === 0 || destroyed) return;
    const toSend = pending;
    pending = [];
    opsSinceResync += toSend.length;

    // Periodic resync: replace accumulated ops with a fresh snapshot.
    if (resyncInterval > 0 && opsSinceResync >= resyncInterval) {
      opsSinceResync = 0;
      onOps?.([buildSnapshot()]);
      return;
    }

    onOps?.(toSend);
  };

  const schedule = (): void => {
    if (scheduled || destroyed) return;
    scheduled = true;
    if (batchMode === "sync") {
      flush();
    } else if (batchMode === "microtask") {
      queueMicrotask(flush);
    } else if (batchMode === "raf" && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else if (typeof batchMode === "number") {
      setTimeout(flush, batchMode);
    } else {
      queueMicrotask(flush);
    }
  };

  const emit = (op: Op): void => {
    if (destroyed) return;
    pending.push(op);
    schedule();
  };

  const track = <T extends object>(obj: T): T => {
    // Eagerly walk the graph and assign ids to every reachable object,
    // so subsequent ops referring to nested objects can encode them as
    // refs. This matches remdom's `walkAndAssign` at observe time.
    registry.walkAndAssign(obj);
    rootIds.add(registry.assignId(obj));
    return wrap(obj, registry, emit);
  };

  const buildSnapshot = (): SnapshotOp => {
    // Walk every tracked object via the registry's entries iterator.
    // For each, encode its contents (top-level, so nested refs become
    // ref tags) into a graph entry.
    const objects: { id: string; encoded: EncodedValue }[] = [];
    const refOf = (o: object): string | null => registry.getIdOf(o);
    for (const [id, obj] of registry.entries()) {
      objects.push({ id, encoded: encodeContents(obj, { refOf }) });
    }
    return {
      type: "snapshot",
      objects,
      rootIds: Array.from(rootIds),
    };
  };

  return {
    track,
    snapshot: buildSnapshot,
    flush,
    destroy: () => {
      destroyed = true;
    },
    get registry() {
      return registry;
    },
  };
}
