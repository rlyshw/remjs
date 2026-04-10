import { describe, it, expect } from "vitest";
import {
  createObserver,
  createReceiver,
  type Op,
} from "../src/index.js";

describe("createObserver", () => {
  it("returns an observer with track/snapshot/flush/destroy/registry", () => {
    const observer = createObserver({ onOps: () => {} });
    expect(typeof observer.track).toBe("function");
    expect(typeof observer.snapshot).toBe("function");
    expect(typeof observer.flush).toBe("function");
    expect(typeof observer.destroy).toBe("function");
    expect(observer.registry).toBeDefined();
    expect(typeof observer.registry.assignId).toBe("function");
  });

  it("track returns a proxy that emits ops on mutation", () => {
    const ops: Op[] = [];
    const observer = createObserver({
      onOps: (b) => ops.push(...b),
      batchMode: "sync",
    });
    const state = observer.track({ count: 0 });
    state.count = 5;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "set", value: 5 });
  });

  it("multiple track calls share the same registry", () => {
    const observer = createObserver({ onOps: () => {} });
    const a = observer.track({ name: "alice" });
    const b = observer.track({ name: "bob" });
    const idA = observer.registry.getIdOf(a);
    const idB = observer.registry.getIdOf(b);
    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    expect(idA).not.toBe(idB);
  });

  it("snapshot includes every tracked root", () => {
    const observer = createObserver({ onOps: () => {} });
    observer.track({ name: "alice" });
    observer.track({ name: "bob" });
    const snap = observer.snapshot();
    expect(snap.type).toBe("snapshot");
    expect(snap.rootIds).toHaveLength(2);
    // Both roots should be in objects
    expect(snap.objects!.length).toBeGreaterThanOrEqual(2);
  });

  it("destroy stops emitting ops", () => {
    const ops: Op[] = [];
    const observer = createObserver({
      onOps: (b) => ops.push(...b),
      batchMode: "sync",
    });
    const state = observer.track({ x: 0 });
    state.x = 1;
    observer.destroy();
    state.x = 2;
    expect(ops).toHaveLength(1);
  });

  it("microtask batch mode coalesces same-tick mutations", async () => {
    const batches: Op[][] = [];
    const observer = createObserver({
      onOps: (b) => batches.push(b),
      batchMode: "microtask",
    });
    const state = observer.track({ a: 0, b: 0, c: 0 });
    state.a = 1;
    state.b = 2;
    state.c = 3;
    expect(batches).toHaveLength(0);
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it("flush drains pending ops immediately", () => {
    const batches: Op[][] = [];
    const observer = createObserver({
      onOps: (b) => batches.push(b),
      batchMode: "microtask",
    });
    const state = observer.track({ a: 0 });
    state.a = 1;
    expect(batches).toHaveLength(0);
    observer.flush();
    expect(batches).toHaveLength(1);
  });

  it("end-to-end: snapshot then mutations sync to a fresh receiver", () => {
    const ops: Op[] = [];
    const observer = createObserver({
      onOps: (b) => ops.push(...b),
      batchMode: "sync",
    });
    const state = observer.track({ a: 1, child: { b: 2 } });
    const receiver = createReceiver();
    receiver.apply([observer.snapshot()]);

    state.a = 99;
    state.child.b = 88;
    receiver.apply(ops);

    const reconstructed = receiver.state as { a: number; child: { b: number } };
    expect(reconstructed.a).toBe(99);
    expect(reconstructed.child.b).toBe(88);
  });
});
