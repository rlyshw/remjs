/**
 * remjs — streaming JavaScript state serialization.
 *
 * Wrap a state object with `createStateStream` to produce a live op stream
 * that can be shipped to another runtime. On the receiving end, feed the ops
 * into `applyOps` (or `createReceiver`) to reconstruct identical state.
 */

export { createStateStream } from "./stream.js";
export type { StateStream, StreamOptions, BatchMode } from "./stream.js";

export { applyOp, applyOps, createReceiver } from "./apply.js";
export type { Receiver } from "./apply.js";

export { encode, decode } from "./codec.js";

export { TAG } from "./ops.js";
export type {
  Op,
  Path,
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
