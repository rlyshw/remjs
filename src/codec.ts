/**
 * Codec — encode/decode ops for transport.
 *
 * `jsonCodec` is the default. The `Codec` interface lets transports
 * swap in binary encodings (msgpack, protobuf) without changing callers.
 */

import type { Op } from "./ops.js";

/**
 * Minimal batch envelope for multi-writer topologies. Consumers who
 * need more (sequence numbers, signatures) wrap further.
 */
export interface BatchMeta {
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
