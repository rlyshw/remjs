/**
 * remjs — streaming JavaScript state serialization.
 *
 * v0.2 introduces `createObserver` as the primary primitive (the JS
 * analog of remdom's `createObserver`). It owns a registry, batches
 * ops, supports multiple tracked roots via `track(obj)`, and lays the
 * groundwork for future capture mechanisms (`observeGlobal`,
 * `hookFramework`).
 *
 * `createStateStream` is kept as a thin compatibility shim for v0.1
 * consumers — it builds a single-root observer under the hood. New
 * code should prefer `createObserver` directly.
 */

// v0.2 primary API
export { createObserver } from "./observer.js";
export type { JsObserver, ObserverOptions, BatchMode } from "./observer.js";

export { createObjectRegistry } from "./registry.js";
export type { ObjectRegistry } from "./registry.js";

// Receiver
export { applyOp, applyOps, createReceiver } from "./apply.js";
export type { Receiver } from "./apply.js";

// Codec — exposed for advanced use (e.g. custom transports that need to
// encode values without going through an observer).
export { encode, decode } from "./codec.js";
export type { EncodeOptions, DecodeOptions } from "./codec.js";

// Op types and the TAG constant
export { TAG, normalizeLegacyOp } from "./ops.js";
export type {
  Op,
  Path,
  Target,
  PathTarget,
  RefTarget,
  EncodedValue,
  TaggedValue,
  SnapshotOp,
  SetOp,
  DeleteOp,
  MapSetOp,
  MapDeleteOp,
  MapClearOp,
  SetAddOp,
  SetDeleteOp,
  SetClearOp,
} from "./ops.js";

// v0.1 compatibility shim
export { createStateStream } from "./stream.js";
export type { StateStream, StreamOptions } from "./stream.js";
