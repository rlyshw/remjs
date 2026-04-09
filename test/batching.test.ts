import { describe, it, expect } from "vitest";
import { createStateStream, type Op } from "../src/index.js";

describe("batching", () => {
  it("sync mode flushes every mutation immediately", () => {
    const batches: Op[][] = [];
    const { state } = createStateStream(
      { a: 0, b: 0 },
      { onOps: (ops) => batches.push(ops), batch: "sync" },
    );
    state.a = 1;
    state.b = 2;
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
  });

  it("microtask mode coalesces mutations within a tick", async () => {
    const batches: Op[][] = [];
    const { state } = createStateStream(
      { a: 0, b: 0, c: 0 },
      { onOps: (ops) => batches.push(ops), batch: "microtask" },
    );
    state.a = 1;
    state.b = 2;
    state.c = 3;
    expect(batches).toHaveLength(0); // not yet flushed
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it("explicit flush drains pending ops synchronously", () => {
    const batches: Op[][] = [];
    const { state, flush } = createStateStream(
      { a: 0 },
      { onOps: (ops) => batches.push(ops), batch: "microtask" },
    );
    state.a = 1;
    expect(batches).toHaveLength(0);
    flush();
    expect(batches).toHaveLength(1);
  });

  it("dispose stops emitting but mutations still apply", () => {
    const batches: Op[][] = [];
    const { state, dispose } = createStateStream(
      { a: 0 },
      { onOps: (ops) => batches.push(ops), batch: "sync" },
    );
    state.a = 1;
    dispose();
    state.a = 2;
    expect(batches).toHaveLength(1);
    expect(state.a).toBe(2);
  });
});
