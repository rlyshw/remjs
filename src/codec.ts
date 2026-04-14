/**
 * remjs v0.3 — Codec
 *
 * Ops are plain JSON — no special encoding needed. The codec is a thin
 * abstraction so transport layers can swap in msgpack or protobuf later.
 */

import type { Op } from "./ops.js";

/**
 * A minimal batch envelope for multi-writer topologies. Reference
 * shape only — consumers who need more (sequence numbers, signatures,
 * timestamps) wrap further; consumers who don't need this use the
 * plain `encodeBatch` path.
 */
export interface BatchMeta {
  /** Peer that produced this batch. */
  from: string;
  ops: Op[];
}

export interface Codec {
  encode(op: Op): string;
  decode(data: string): Op;
  encodeBatch(ops: readonly Op[]): string;
  decodeBatch(data: string): Op[];
  encodeBatchWithMeta(meta: BatchMeta): string;
  decodeBatchWithMeta(data: string): BatchMeta;
}

export const jsonCodec: Codec = {
  encode(op) {
    return JSON.stringify(op);
  },
  decode(data) {
    return JSON.parse(data) as Op;
  },
  encodeBatch(ops) {
    return JSON.stringify(ops);
  },
  decodeBatch(data) {
    return JSON.parse(data) as Op[];
  },
  encodeBatchWithMeta(meta) {
    return JSON.stringify(meta);
  },
  decodeBatchWithMeta(data) {
    return JSON.parse(data) as BatchMeta;
  },
};
