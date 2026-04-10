import { describe, it, expect } from "vitest";
import {
  createStateStream,
  createReceiver,
  applyOps,
  type Op,
} from "../src/index.js";

/**
 * End-to-end test: tx side mutates proxied state, ops flow to rx side, and
 * the reconstructed state matches the original at every step.
 */

function connect<T extends object>(initial: T) {
  const ops: Op[] = [];
  const stream = createStateStream(initial, {
    onOps: (batch) => ops.push(...batch),
    batch: "sync",
  });
  // v0.2: receiver starts empty. The snapshot adopts the source's
  // object ids into the receiver's registry, so subsequent ref-based
  // ops can be resolved.
  const receiver = createReceiver<T>();
  receiver.apply([stream.snapshot()]);

  return {
    state: stream.state,
    sync: () => {
      stream.flush();
      receiver.apply(ops);
      ops.length = 0;
    },
    receiver,
  };
}

describe("tx → rx round trip", () => {
  it("basic object mutations", () => {
    const { state, sync, receiver } = connect<{ count: number; name: string }>({
      count: 0,
      name: "a",
    });
    state.count = 5;
    state.name = "b";
    sync();
    expect(receiver.state).toEqual({ count: 5, name: "b" });
  });

  it("nested mutations", () => {
    const { state, sync, receiver } = connect<{ user: { name: string; age: number } }>({
      user: { name: "Alice", age: 30 },
    });
    state.user.name = "Bob";
    state.user.age = 31;
    sync();
    expect(receiver.state).toEqual({ user: { name: "Bob", age: 31 } });
  });

  it("array push / pop / splice", () => {
    const { state, sync, receiver } = connect<{ items: number[] }>({
      items: [1, 2, 3],
    });

    state.items.push(4);
    sync();
    expect(receiver.state).toEqual({ items: [1, 2, 3, 4] });

    state.items.pop();
    sync();
    expect(receiver.state).toEqual({ items: [1, 2, 3] });

    state.items.splice(1, 1, 20, 30);
    sync();
    expect(receiver.state).toEqual({ items: [1, 20, 30, 3] });
  });

  it("delete property", () => {
    const { state, sync, receiver } = connect<Record<string, number>>({
      a: 1,
      b: 2,
    });
    delete state.a;
    sync();
    expect(receiver.state).toEqual({ b: 2 });
  });

  it("replacing a subtree", () => {
    const { state, sync, receiver } = connect<{ user: { name: string } | null }>({
      user: { name: "Alice" },
    });
    state.user = null;
    sync();
    expect(receiver.state).toEqual({ user: null });

    state.user = { name: "Bob" };
    sync();
    expect(receiver.state).toEqual({ user: { name: "Bob" } });
  });

  it("Map mutations", () => {
    const { state, sync, receiver } = connect<{ users: Map<string, { age: number }> }>({
      users: new Map(),
    });
    state.users.set("alice", { age: 30 });
    state.users.set("bob", { age: 25 });
    sync();
    const received = receiver.state.users as Map<string, { age: number }>;
    expect(received.size).toBe(2);
    expect(received.get("alice")).toEqual({ age: 30 });

    state.users.delete("alice");
    sync();
    expect(received.size).toBe(1);
    expect(received.has("alice")).toBe(false);
  });

  it("Set mutations", () => {
    const { state, sync, receiver } = connect<{ tags: Set<string> }>({
      tags: new Set(),
    });
    state.tags.add("red");
    state.tags.add("blue");
    sync();
    const received = receiver.state.tags as Set<string>;
    expect(received.size).toBe(2);
    expect(received.has("red")).toBe(true);
  });

  it("complex mixed state tree", () => {
    interface S {
      todos: { id: number; text: string; done: boolean }[];
      filter: "all" | "active" | "done";
      tags: Set<string>;
      meta: Map<string, unknown>;
    }
    const { state, sync, receiver } = connect<S>({
      todos: [],
      filter: "all",
      tags: new Set(),
      meta: new Map(),
    });

    state.todos.push({ id: 1, text: "buy milk", done: false });
    state.todos.push({ id: 2, text: "walk dog", done: false });
    state.todos[0]!.done = true;
    state.filter = "active";
    state.tags.add("home");
    state.meta.set("lastUpdated", 12345);
    sync();

    expect(receiver.state.todos).toEqual([
      { id: 1, text: "buy milk", done: true },
      { id: 2, text: "walk dog", done: false },
    ]);
    expect(receiver.state.filter).toBe("active");
    expect((receiver.state.tags as Set<string>).has("home")).toBe(true);
    expect((receiver.state.meta as Map<string, unknown>).get("lastUpdated")).toBe(12345);
  });
});

describe("applyOps with snapshot", () => {
  it("snapshot op replaces the entire root", () => {
    let root: unknown = { old: true };
    root = applyOps(root, [
      { type: "snapshot", value: { fresh: "state", n: 7 } },
    ]);
    expect(root).toEqual({ fresh: "state", n: 7 });
  });
});
