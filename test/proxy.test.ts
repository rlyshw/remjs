import { describe, it, expect } from "vitest";
import { createStateStream, type Op } from "../src/index.js";

function collect<T extends object>(initial: T) {
  const ops: Op[] = [];
  const stream = createStateStream(initial, {
    onOps: (batch) => ops.push(...batch),
    batch: "sync",
  });
  return { ...stream, ops };
}

describe("proxy mutations emit ops", () => {
  it("emits set on property assignment", () => {
    const { state, ops } = collect<{ count: number }>({ count: 0 });
    state.count = 5;
    expect(ops).toEqual([{ type: "set", path: ["count"], value: 5 }]);
  });

  it("emits delete on property removal", () => {
    const { state, ops } = collect<Record<string, number>>({ foo: 1, bar: 2 });
    delete state.foo;
    expect(ops).toEqual([{ type: "delete", path: ["foo"] }]);
  });

  it("emits set on nested property assignment", () => {
    const { state, ops } = collect<{ user: { name: string } }>({
      user: { name: "Alice" },
    });
    state.user.name = "Bob";
    expect(ops).toEqual([{ type: "set", path: ["user", "name"], value: "Bob" }]);
  });

  it("assigning a whole subtree encodes deeply", () => {
    const { state, ops } = collect<{ user: { name: string } | null }>({ user: null });
    state.user = { name: "Alice" };
    expect(ops).toEqual([
      { type: "set", path: ["user"], value: { name: "Alice" } },
    ]);
  });

  it("emits set ops on array push", () => {
    const { state, ops } = collect<{ items: string[] }>({ items: [] });
    state.items.push("a");
    // push generates: set [items, 0] = "a" and set [items, length] = 1
    const setOps = ops.filter((o) => o.type === "set");
    expect(setOps).toEqual([
      { type: "set", path: ["items", "0"], value: "a" },
      { type: "set", path: ["items", "length"], value: 1 },
    ]);
  });

  it("emits ops on array pop", () => {
    const { state, ops } = collect<{ items: string[] }>({ items: ["a", "b"] });
    const popped = state.items.pop();
    expect(popped).toBe("b");
    // pop: delete [items, 1], set [items, length] = 1
    expect(ops).toEqual([
      { type: "delete", path: ["items", "1"] },
      { type: "set", path: ["items", "length"], value: 1 },
    ]);
  });

  it("emits ops on Map.set / delete / clear", () => {
    const { state, ops } = collect<{ m: Map<string, number> }>({
      m: new Map(),
    });
    state.m.set("a", 1);
    state.m.set("b", 2);
    state.m.delete("a");
    state.m.clear();
    expect(ops).toEqual([
      { type: "mapSet", path: ["m"], key: "a", value: 1 },
      { type: "mapSet", path: ["m"], key: "b", value: 2 },
      { type: "mapDelete", path: ["m"], key: "a" },
      { type: "mapClear", path: ["m"] },
    ]);
  });

  it("emits ops on Set.add / delete / clear", () => {
    const { state, ops } = collect<{ s: Set<string> }>({ s: new Set() });
    state.s.add("x");
    state.s.add("y");
    state.s.delete("x");
    state.s.clear();
    expect(ops).toEqual([
      { type: "setAdd", path: ["s"], value: "x" },
      { type: "setAdd", path: ["s"], value: "y" },
      { type: "setDelete", path: ["s"], value: "x" },
      { type: "setClear", path: ["s"] },
    ]);
  });

  it("does not emit setAdd if value already present", () => {
    const { state, ops } = collect<{ s: Set<string> }>({ s: new Set(["x"]) });
    state.s.add("x");
    expect(ops).toEqual([]);
  });

  it("encodes Date values in ops", () => {
    const { state, ops } = collect<{ created: Date | null }>({ created: null });
    const d = new Date(2024, 0, 1);
    state.created = d;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe("set");
    const encoded = (ops[0] as { value: unknown }).value;
    expect(encoded).toEqual({ __remjs: "date", v: d.getTime() });
  });

  it("snapshot() captures full current state", () => {
    const { state, snapshot } = collect<{ a: number; b: { c: number } }>({
      a: 1,
      b: { c: 2 },
    });
    state.a = 5;
    state.b.c = 10;
    const snap = snapshot();
    expect(snap).toEqual({
      type: "snapshot",
      value: { a: 5, b: { c: 10 } },
    });
  });
});
