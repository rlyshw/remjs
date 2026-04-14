import { describe, it, expect } from "vitest";
import { createRecorder } from "../src/recorder.js";
import type { Op } from "../src/ops.js";

describe("recorder", () => {
  it("captures clock and random ops when started", () => {
    const ops: Op[] = [];
    const recorder = createRecorder({
      onOps: (batch) => ops.push(...batch),
      batchMode: "sync",
      events: false,
      timers: false,
      network: false,
      storage: false,
    });

    recorder.start();

    const t = Date.now();
    const r = Math.random();

    recorder.stop();

    expect(ops.length).toBeGreaterThanOrEqual(2);
    const clockOps = ops.filter((o) => o.type === "clock");
    const randomOps = ops.filter((o) => o.type === "random");
    expect(clockOps.length).toBeGreaterThanOrEqual(1);
    expect(randomOps).toHaveLength(1);
  });

  it("does not capture when stopped", () => {
    const ops: Op[] = [];
    const recorder = createRecorder({
      onOps: (batch) => ops.push(...batch),
      batchMode: "sync",
      events: false,
      timers: false,
      network: false,
      storage: false,
    });

    // Don't start — should not capture
    Date.now();
    Math.random();

    expect(ops).toHaveLength(0);
  });

  it("restores globals after stop", () => {
    const origRandom = Math.random;
    const origDateNow = Date.now;

    const recorder = createRecorder({
      onOps: () => {},
      batchMode: "sync",
      events: false,
      timers: false,
      network: false,
      storage: false,
    });

    recorder.start();
    expect(Math.random).not.toBe(origRandom);

    recorder.stop();
    expect(Math.random).toBe(origRandom);
    expect(Date.now).toBe(origDateNow);
  });

  it("produces a snapshot", () => {
    const recorder = createRecorder({
      onOps: () => {},
      batchMode: "sync",
      events: false,
      timers: false,
      network: false,
      storage: false,
    });

    const snap = recorder.snapshot();
    expect(snap.type).toBe("snapshot");
    expect(typeof snap.timestamp).toBe("number");
    expect(Array.isArray(snap.pendingTimers)).toBe(true);
    expect(Array.isArray(snap.pendingNetwork)).toBe(true);
  });

  it("task batchMode groups emits across microtask boundaries into one batch", async () => {
    const batches: Op[][] = [];
    const recorder = createRecorder({
      onOps: (batch) => batches.push(batch),
      batchMode: "task",
      events: false, timers: false, network: false, storage: false,
    });

    recorder.start();

    // Emit in the current task...
    Math.random();
    // ...then in a microtask chained from here.
    await Promise.resolve();
    Math.random();
    // ...and a second microtask.
    await Promise.resolve();
    Math.random();

    // Yield to the task queue so setTimeout(flush) fires.
    await new Promise<void>((r) => setTimeout(r, 0));
    recorder.stop();

    // All three random ops landed in one batch (the current task
    // plus its microtask drain).
    const randomOpsPerBatch = batches.map((b) => b.filter((o) => o.type === "random").length);
    expect(randomOpsPerBatch).toContain(3);
  });

  it("microtask batchMode splits ops across microtask-queued flushes", async () => {
    const batches: Op[][] = [];
    const recorder = createRecorder({
      onOps: (batch) => batches.push(batch),
      batchMode: "microtask",
      events: false, timers: false, network: false, storage: false,
    });

    recorder.start();

    Math.random();
    await Promise.resolve();
    Math.random();

    await new Promise<void>((r) => setTimeout(r, 0));
    recorder.stop();

    // Under microtask batching, the flush scheduled by the first emit
    // runs before the awaited continuation emits the second random —
    // so the two ops land in different batches.
    const nonEmptyBatches = batches.filter((b) => b.some((o) => o.type === "random"));
    expect(nonEmptyBatches.length).toBeGreaterThanOrEqual(2);
  });

  it("captures timer ops", async () => {
    const ops: Op[] = [];
    const recorder = createRecorder({
      onOps: (batch) => ops.push(...batch),
      batchMode: "sync",
      events: false,
      network: false,
      random: false,
      clock: false,
      storage: false,
    });

    recorder.start();

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 10);
    });

    recorder.stop();

    const timerOps = ops.filter((o) => o.type === "timer");
    expect(timerOps.length).toBeGreaterThanOrEqual(1);
    expect(timerOps[0]!.type).toBe("timer");
  });
});
