import { describe, it, expect } from "vitest";
import {
  createObserver,
  createReceiver,
  type Op,
} from "../src/index.js";

/**
 * Graph-state tests: cycles, shared references, multi-root tracking,
 * and the cases that v0.1's tree-shaped path-addressing couldn't
 * support.
 */

describe("graph state round-trip", () => {
  it("preserves shared references on the receiver", () => {
    const ops: Op[] = [];
    const observer = createObserver({
      onOps: (b) => ops.push(...b),
      batchMode: "sync",
    });

    const shared = { value: 42 };
    interface Container { left: typeof shared; right: typeof shared; }
    const root = observer.track<Container>({ left: shared, right: shared });

    const receiver = createReceiver<Container>();
    receiver.apply([observer.snapshot()]);
    receiver.apply(ops);

    expect(receiver.state.left).toBe(receiver.state.right);
    expect(receiver.state.left.value).toBe(42);
  });

  it("preserves shared references after a mutation through one path", () => {
    const ops: Op[] = [];
    const observer = createObserver({
      onOps: (b) => ops.push(...b),
      batchMode: "sync",
    });

    interface S { left: { value: number }; right: { value: number } }
    const shared = { value: 42 };
    const root = observer.track<S>({ left: shared, right: shared });

    const receiver = createReceiver<S>();
    receiver.apply([observer.snapshot()]);

    // Mutate through one path. The other path should see the same change
    // because they're literally the same object.
    root.left.value = 99;
    receiver.apply(ops);

    expect(receiver.state.left).toBe(receiver.state.right);
    expect(receiver.state.left.value).toBe(99);
    expect(receiver.state.right.value).toBe(99);
  });

  it("round-trips a self-cycle (obj.self = obj)", () => {
    interface SelfCycle { name: string; self?: SelfCycle }
    const observer = createObserver({ onOps: () => {}, batchMode: "sync" });
    const obj: SelfCycle = { name: "alice" };
    obj.self = obj;
    observer.track(obj);

    const receiver = createReceiver<SelfCycle>();
    receiver.apply([observer.snapshot()]);

    expect(receiver.state.name).toBe("alice");
    expect(receiver.state.self).toBe(receiver.state);
  });

  it("round-trips a parent-child cycle", () => {
    interface Parent { name: string; child?: Child }
    interface Child { name: string; parent?: Parent }

    const observer = createObserver({ onOps: () => {}, batchMode: "sync" });
    const p: Parent = { name: "parent" };
    const c: Child = { name: "child", parent: p };
    p.child = c;
    observer.track(p);

    const receiver = createReceiver<Parent>();
    receiver.apply([observer.snapshot()]);

    const recoveredParent = receiver.state;
    expect(recoveredParent.name).toBe("parent");
    expect(recoveredParent.child?.name).toBe("child");
    expect(recoveredParent.child?.parent).toBe(recoveredParent);
  });

  it("multi-root tracking: two independent trees in one observer", () => {
    interface S { name: string; }
    const observer = createObserver({ onOps: () => {}, batchMode: "sync" });
    const a = observer.track<S>({ name: "alice" });
    const b = observer.track<S>({ name: "bob" });
    a.name = "alicia";
    b.name = "bobby";
    const snap = observer.snapshot();
    expect(snap.rootIds).toHaveLength(2);
    // Both roots are in the objects list
    const aId = observer.registry.getIdOf(a)!;
    const bId = observer.registry.getIdOf(b)!;
    const aEntry = snap.objects!.find((o) => o.id === aId);
    const bEntry = snap.objects!.find((o) => o.id === bId);
    expect(aEntry).toBeDefined();
    expect(bEntry).toBeDefined();
    expect((aEntry!.encoded as { name: string }).name).toBe("alicia");
    expect((bEntry!.encoded as { name: string }).name).toBe("bobby");
  });

  it("introducing a new object via mutation flows through as a newobj tag", () => {
    const ops: Op[] = [];
    const observer = createObserver({
      onOps: (b) => ops.push(...b),
      batchMode: "sync",
    });
    interface S { user: { name: string } | null }
    const root = observer.track<S>({ user: null });

    const receiver = createReceiver<S>();
    receiver.apply([observer.snapshot()]);

    root.user = { name: "alice" };
    receiver.apply(ops);

    expect(receiver.state.user?.name).toBe("alice");

    // The new object should be tracked on the receiver side too — a
    // subsequent mutation to it should round-trip via ref addressing.
    ops.length = 0;
    root.user!.name = "alicia";
    receiver.apply(ops);
    expect(receiver.state.user?.name).toBe("alicia");
  });

  it("array-of-objects: pushed objects can be mutated through their proxy", () => {
    const ops: Op[] = [];
    const observer = createObserver({
      onOps: (b) => ops.push(...b),
      batchMode: "sync",
    });
    interface Todo { id: number; text: string; done: boolean; }
    interface S { todos: Todo[] }
    const root = observer.track<S>({ todos: [] });

    const receiver = createReceiver<S>();
    receiver.apply([observer.snapshot()]);

    root.todos.push({ id: 1, text: "buy milk", done: false });
    root.todos.push({ id: 2, text: "walk dog", done: false });
    root.todos[0]!.done = true;
    receiver.apply(ops);

    expect(receiver.state.todos).toEqual([
      { id: 1, text: "buy milk", done: true },
      { id: 2, text: "walk dog", done: false },
    ]);
  });
});
