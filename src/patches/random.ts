/**
 * Random patch — intercepts Math.random() and crypto.getRandomValues().
 *
 * Records the actual values returned so replicas produce identical
 * "random" sequences.
 */

import type { RandomOp } from "../ops.js";

export type Emit = (op: RandomOp) => void;

export function installRandomPatch(emit: Emit): () => void {
  const origRandom = Math.random;
  const origCrypto =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
      ? globalThis.crypto.getRandomValues.bind(globalThis.crypto)
      : null;

  Math.random = function () {
    const value = origRandom();
    emit({ type: "random", source: "math", values: [value] });
    return value;
  };

  if (origCrypto && typeof globalThis.crypto !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis.crypto as any).getRandomValues = function (array: ArrayBufferView): ArrayBufferView {
      const result = origCrypto(array);
      if (result && ArrayBuffer.isView(result)) {
        const values = Array.from(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
        emit({ type: "random", source: "crypto", values });
      }
      return result;
    };
  }

  return function uninstall() {
    Math.random = origRandom;
    if (origCrypto && typeof globalThis.crypto !== "undefined") {
      globalThis.crypto.getRandomValues = origCrypto;
    }
  };
}
