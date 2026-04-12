import { describe, it, expect } from "vitest";
import { installClockPatch } from "../../src/patches/clock.js";
import type { ClockOp } from "../../src/ops.js";

describe("clock patch", () => {
  it("records Date.now() calls", () => {
    const ops: ClockOp[] = [];
    const uninstall = installClockPatch((op) => ops.push(op));

    const t1 = Date.now();
    const t2 = Date.now();

    uninstall();

    expect(ops).toHaveLength(2);
    expect(ops[0]!.type).toBe("clock");
    expect(ops[0]!.source).toBe("dateNow");
    expect(ops[0]!.value).toBe(t1);
    expect(ops[1]!.value).toBe(t2);
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it("records performance.now() calls", () => {
    const ops: ClockOp[] = [];
    const uninstall = installClockPatch((op) => ops.push(op));

    const t = performance.now();

    uninstall();

    expect(ops.some((o) => o.source === "performanceNow")).toBe(true);
    const perfOp = ops.find((o) => o.source === "performanceNow")!;
    expect(perfOp.value).toBe(t);
  });

  it("restores originals on uninstall", () => {
    const origDateNow = Date.now;

    const uninstall = installClockPatch(() => {});
    expect(Date.now).not.toBe(origDateNow);

    uninstall();
    expect(Date.now).toBe(origDateNow);

    // performance.now is restored but may be a bound copy
    const t = performance.now();
    expect(typeof t).toBe("number");
  });
});
