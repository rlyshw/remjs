import { describe, it, expect } from "vitest";
import { createStateStream, type Op, type RefTarget } from "../src/index.js";

function collect<T extends object>(initial: T) {
  const ops: Op[] = [];
  const stream = createStateStream(initial, {
    onOps: (batch) => ops.push(...batch),
    batch: "sync",
  });
  return { ...stream, ops };
}

/** Helper: extract the ref target from an op (asserts it's a ref). */
function refTarget(op: Op): RefTarget {
  if (!("target" in op) || !op.target) throw new Error("op has no target");
  if (op.target.kind !== "ref") throw new Error("op target is not a ref");
  return op.target;
}

describe("proxy mutations emit ops", () => {
  it("emits set on property assignment", () => {
    const { state, ops } = collect<{ count: number }>({ count: 0 });
    state.count = 5;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "set", value: 5 });
    expect(refTarget(ops[0]!).prop).toBe("count");
  });

  it("emits delete on property removal", () => {
    const { state, ops } = collect<Record<string, number>>({ foo: 1, bar: 2 });
    delete state.foo;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "delete" });
    expect(refTarget(ops[0]!).prop).toBe("foo");
  });

  it("emits set on nested property assignment", () => {
    const { state, ops } = collect<{ user: { name: string } }>({
      user: { name: "Alice" },
    });
    state.user.name = "Bob";
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "set", value: "Bob" });
    expect(refTarget(ops[0]!).prop).toBe("name");
  });

  it("assigning a whole subtree encodes as a newobj tag with contents", () => {
    const { state, ops } = collect<{ user: { name: string } | null }>({ user: null });
    state.user = { name: "Alice" };
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "set" });
    expect(refTarget(ops[0]!).prop).toBe("user");
    // The new object becomes a newobj tag whose contents describe its fields.
    const value = (ops[0] as { value: unknown }).value as {
      __remjs: string;
      kind: string;
      contents: unknown;
    };
    expect(value.__remjs).toBe("newobj");
    expect(value.kind).toBe("object");
    expect(value.contents).toEqual({ name: "Alice" });
  });

  it("emits set ops on array push", () => {
    const { state, ops } = collect<{ items: string[] }>({ items: [] });
    state.items.push("a");
    // push generates: set [items, 0] = "a" and set [items, length] = 1
    const setOps = ops.filter((o) => o.type === "set");
    expect(setOps).toHaveLength(2);
    expect(setOps[0]).toMatchObject({ type: "set", value: "a" });
    expect(refTarget(setOps[0]!).prop).toBe("0");
    expect(setOps[1]).toMatchObject({ type: "set", value: 1 });
    expect(refTarget(setOps[1]!).prop).toBe("length");
  });

  it("emits ops on array pop", () => {
    const { state, ops } = collect<{ items: string[] }>({ items: ["a", "b"] });
    const popped = state.items.pop();
    expect(popped).toBe("b");
    // pop: delete [items, 1], set [items, length] = 1
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ type: "delete" });
    expect(refTarget(ops[0]!).prop).toBe("1");
    expect(ops[1]).toMatchObject({ type: "set", value: 1 });
    expect(refTarget(ops[1]!).prop).toBe("length");
  });

  it("emits ops on Map.set / delete / clear", () => {
    const { state, ops } = collect<{ m: Map<string, number> }>({
      m: new Map(),
    });
    state.m.set("a", 1);
    state.m.set("b", 2);
    state.m.delete("a");
    state.m.clear();
    expect(ops).toHaveLength(4);
    expect(ops[0]).toMatchObject({ type: "mapSet", key: "a", value: 1 });
    expect(ops[1]).toMatchObject({ type: "mapSet", key: "b", value: 2 });
    expect(ops[2]).toMatchObject({ type: "mapDelete", key: "a" });
    expect(ops[3]).toMatchObject({ type: "mapClear" });
    // All four ops should target the same Map (same ref id, no prop)
    const mapId = refTarget(ops[0]!).id;
    for (const op of ops) {
      expect(refTarget(op).id).toBe(mapId);
      expect(refTarget(op).prop).toBeUndefined();
    }
  });

  it("emits ops on Set.add / delete / clear", () => {
    const { state, ops } = collect<{ s: Set<string> }>({ s: new Set() });
    state.s.add("x");
    state.s.add("y");
    state.s.delete("x");
    state.s.clear();
    expect(ops).toHaveLength(4);
    expect(ops[0]).toMatchObject({ type: "setAdd", value: "x" });
    expect(ops[1]).toMatchObject({ type: "setAdd", value: "y" });
    expect(ops[2]).toMatchObject({ type: "setDelete", value: "x" });
    expect(ops[3]).toMatchObject({ type: "setClear" });
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

  it("snapshot() captures full current state as a graph", () => {
    const { state, snapshot } = collect<{ a: number; b: { c: number } }>({
      a: 1,
      b: { c: 2 },
    });
    state.a = 5;
    state.b.c = 10;
    const snap = snapshot();
    expect(snap.type).toBe("snapshot");
    expect(snap.objects).toBeDefined();
    expect(snap.rootIds).toBeDefined();
    expect(snap.rootIds!.length).toBe(1);
    // The root object should be in objects with the matching id
    const rootEntry = snap.objects!.find((o) => o.id === snap.rootIds![0]);
    expect(rootEntry).toBeDefined();
    // Encoded form has a number for `a` and a ref for `b`
    const enc = rootEntry!.encoded as { a: unknown; b: unknown };
    expect(enc.a).toBe(5);
    expect(enc.b).toMatchObject({ __remjs: "ref" });
    // The nested object should also be in objects
    const bEntry = snap.objects!.find(
      (o) => o.id === (enc.b as { id: string }).id,
    );
    expect(bEntry).toBeDefined();
    expect(bEntry!.encoded).toEqual({ c: 10 });
  });
});
