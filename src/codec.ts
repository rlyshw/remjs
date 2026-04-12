/**
 * remjs v0.3 — Codec
 *
 * Ops are plain JSON — no special encoding needed. The codec is a thin
 * abstraction so transport layers can swap in msgpack or protobuf later.
 */

import type { Op } from "./ops.js";

export interface Codec {
  encode(op: Op): string;
  decode(data: string): Op;
  encodeBatch(ops: readonly Op[]): string;
  decodeBatch(data: string): Op[];
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
};
