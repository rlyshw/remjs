import { describe, it, expect, vi } from "vitest";
import { installTimerPatch } from "../../src/patches/timers.js";
import type { TimerOp } from "../../src/ops.js";

describe("timer patch", () => {
  it("records setTimeout fires with seq numbers", async () => {
    const ops: TimerOp[] = [];
    const { uninstall } = installTimerPatch((op) => ops.push(op));

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 10);
    });

    uninstall();

    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe("timer");
    expect(ops[0]!.kind).toBe("timeout");
    expect(ops[0]!.seq).toBe(0);
    expect(ops[0]!.scheduledDelay).toBe(10);
  });

  it("assigns incrementing seq numbers", async () => {
    const ops: TimerOp[] = [];
    const { uninstall } = installTimerPatch((op) => ops.push(op));

    await Promise.all([
      new Promise<void>((r) => setTimeout(r, 5)),
      new Promise<void>((r) => setTimeout(r, 5)),
      new Promise<void>((r) => setTimeout(r, 5)),
    ]);

    uninstall();

    expect(ops).toHaveLength(3);
    const seqs = ops.map((o) => o.seq).sort();
    expect(seqs).toEqual([0, 1, 2]);
  });

  it("records setInterval fires", async () => {
    const ops: TimerOp[] = [];
    const { uninstall } = installTimerPatch((op) => ops.push(op));

    await new Promise<void>((resolve) => {
      let count = 0;
      const id = setInterval(() => {
        count++;
        if (count >= 2) {
          clearInterval(id);
          resolve();
        }
      }, 10);
    });

    uninstall();

    expect(ops.length).toBeGreaterThanOrEqual(2);
    expect(ops.every((o) => o.kind === "interval")).toBe(true);
    // All interval fires have the same seq (same registration)
    expect(ops.every((o) => o.seq === ops[0]!.seq)).toBe(true);
  });

  it("clearTimeout prevents the op from being recorded", async () => {
    const ops: TimerOp[] = [];
    const { uninstall } = installTimerPatch((op) => ops.push(op));

    const id = setTimeout(() => {}, 50);
    clearTimeout(id);

    await new Promise<void>((r) => setTimeout(r, 100));

    uninstall();

    // Only the 100ms timeout should have fired, not the cleared 50ms one
    // But the 100ms one gets seq=1 (the cleared one was seq=0)
    const firedSeqs = ops.map((o) => o.seq);
    expect(firedSeqs).not.toContain(0);
  });

  it("restores originals on uninstall", () => {
    const origST = globalThis.setTimeout;
    const origSI = globalThis.setInterval;
    const origCT = globalThis.clearTimeout;
    const origCI = globalThis.clearInterval;

    const { uninstall } = installTimerPatch(() => {});

    expect(globalThis.setTimeout).not.toBe(origST);

    uninstall();

    expect(globalThis.setTimeout).toBe(origST);
    expect(globalThis.setInterval).toBe(origSI);
    expect(globalThis.clearTimeout).toBe(origCT);
    expect(globalThis.clearInterval).toBe(origCI);
  });
});
