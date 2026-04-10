import { describe, it, expect } from "vitest";
import { createObjectRegistry } from "../src/registry.js";

describe("ObjectRegistry", () => {
  it("assigns a fresh id to a new object", () => {
    const r = createObjectRegistry();
    const obj = { a: 1 };
    const id = r.assignId(obj);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns the same id on repeated assignId calls", () => {
    const r = createObjectRegistry();
    const obj = {};
    const id1 = r.assignId(obj);
    const id2 = r.assignId(obj);
    expect(id1).toBe(id2);
  });

  it("getIdOf returns null for an untracked object", () => {
    const r = createObjectRegistry();
    expect(r.getIdOf({})).toBeNull();
  });

  it("getIdOf returns the id after assignment", () => {
    const r = createObjectRegistry();
    const obj = {};
    const id = r.assignId(obj);
    expect(r.getIdOf(obj)).toBe(id);
  });

  it("getObjectById round-trips with assignId", () => {
    const r = createObjectRegistry();
    const obj = { x: 42 };
    const id = r.assignId(obj);
    expect(r.getObjectById(id)).toBe(obj);
  });

  it("getObjectById returns null for an unknown id", () => {
    const r = createObjectRegistry();
    expect(r.getObjectById("not-a-real-id")).toBeNull();
  });

  it("adopt registers an object with an externally-supplied id", () => {
    const r = createObjectRegistry();
    const obj = {};
    r.adopt(obj, "external-id-123");
    expect(r.getIdOf(obj)).toBe("external-id-123");
    expect(r.getObjectById("external-id-123")).toBe(obj);
  });

  it("adopt is idempotent for the same (obj, id) pair", () => {
    const r = createObjectRegistry();
    const obj = {};
    r.adopt(obj, "abc");
    expect(() => r.adopt(obj, "abc")).not.toThrow();
  });

  it("adopt throws if the object already has a different id", () => {
    const r = createObjectRegistry();
    const obj = {};
    r.adopt(obj, "abc");
    expect(() => r.adopt(obj, "xyz")).toThrow(/cannot adopt/);
  });

  it("walkAndAssign assigns ids to all reachable objects in a tree", () => {
    const r = createObjectRegistry();
    const root = {
      a: { b: { c: 1 } },
      arr: [{ x: 1 }, { x: 2 }],
    };
    r.walkAndAssign(root);
    expect(r.getIdOf(root)).not.toBeNull();
    expect(r.getIdOf(root.a)).not.toBeNull();
    expect(r.getIdOf(root.a.b)).not.toBeNull();
    expect(r.getIdOf(root.arr)).not.toBeNull();
    expect(r.getIdOf(root.arr[0]!)).not.toBeNull();
    expect(r.getIdOf(root.arr[1]!)).not.toBeNull();
  });

  it("walkAndAssign handles cycles without infinite recursion", () => {
    const r = createObjectRegistry();
    interface Node { name: string; self?: Node; }
    const a: Node = { name: "a" };
    a.self = a;
    expect(() => r.walkAndAssign(a)).not.toThrow();
    expect(r.getIdOf(a)).not.toBeNull();
  });

  it("walkAndAssign handles shared subgraphs (same object at two paths)", () => {
    const r = createObjectRegistry();
    const shared = { value: 99 };
    const root = { left: shared, right: shared };
    r.walkAndAssign(root);
    expect(r.getIdOf(shared)).not.toBeNull();
    expect(r.getIdOf(root.left)).toBe(r.getIdOf(root.right));
  });

  it("walkAndAssign skips primitive leaves and Date/RegExp", () => {
    const r = createObjectRegistry();
    const root = {
      n: 5,
      s: "hi",
      d: new Date(),
      re: /abc/,
      nested: {},
    };
    r.walkAndAssign(root);
    expect(r.getIdOf(root)).not.toBeNull();
    expect(r.getIdOf(root.nested)).not.toBeNull();
    expect(r.getIdOf(root.d as object)).toBeNull();
    expect(r.getIdOf(root.re as object)).toBeNull();
  });

  it("walkAndAssign descends into Map keys, Map values, Set values, array items", () => {
    const r = createObjectRegistry();
    const k = { kind: "key" };
    const v = { kind: "value" };
    const mapItem = { i: 1 };
    const setItem = { i: 2 };
    const arrItem = { i: 3 };
    const root = {
      m: new Map<object, object>([[k, v]]),
      s: new Set<object>([setItem]),
      a: [arrItem],
    };
    r.walkAndAssign(root);
    expect(r.getIdOf(k)).not.toBeNull();
    expect(r.getIdOf(v)).not.toBeNull();
    expect(r.getIdOf(setItem)).not.toBeNull();
    expect(r.getIdOf(arrItem)).not.toBeNull();
    void mapItem; // appeased lint
  });

  it("entries iterates every tracked object", () => {
    const r = createObjectRegistry();
    const a = { name: "a" };
    const b = { name: "b" };
    r.assignId(a);
    r.assignId(b);
    const ids = Array.from(r.entries(), ([id]) => id);
    expect(ids).toHaveLength(2);
  });

  it("clear empties the id→obj map", () => {
    const r = createObjectRegistry();
    const obj = {};
    const id = r.assignId(obj);
    r.clear();
    expect(r.getObjectById(id)).toBeNull();
  });
});
