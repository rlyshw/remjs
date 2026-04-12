import { describe, it, expect } from "vitest";
import { installRandomPatch } from "../../src/patches/random.js";
import type { RandomOp } from "../../src/ops.js";

describe("random patch", () => {
  it("records Math.random() calls", () => {
    const ops: RandomOp[] = [];
    const uninstall = installRandomPatch((op) => ops.push(op));

    const v1 = Math.random();
    const v2 = Math.random();

    uninstall();

    expect(ops).toHaveLength(2);
    expect(ops[0]!.type).toBe("random");
    expect(ops[0]!.source).toBe("math");
    expect(ops[0]!.values).toEqual([v1]);
    expect(ops[1]!.values).toEqual([v2]);
  });

  it("records crypto.getRandomValues() calls", () => {
    const ops: RandomOp[] = [];
    const uninstall = installRandomPatch((op) => ops.push(op));

    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);

    uninstall();

    const cryptoOps = ops.filter((o) => o.source === "crypto");
    expect(cryptoOps).toHaveLength(1);
    expect(cryptoOps[0]!.values).toEqual(Array.from(buf));
  });

  it("restores originals on uninstall", () => {
    const origRandom = Math.random;
    const uninstall = installRandomPatch(() => {});
    expect(Math.random).not.toBe(origRandom);
    uninstall();
    expect(Math.random).toBe(origRandom);
  });

  it("returns the real random value", () => {
    const uninstall = installRandomPatch(() => {});
    const v = Math.random();
    uninstall();
    expect(typeof v).toBe("number");
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});
