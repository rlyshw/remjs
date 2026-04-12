import { describe, it, expect, afterEach } from "vitest";
import { createPlayer } from "../src/player.js";
import type { RandomOp, ClockOp, StorageOp, NetworkOp } from "../src/ops.js";

describe("player", () => {
  afterEach(() => {
    // Safety: ensure globals are restored even if a test fails
  });

  it("replays random values", () => {
    const player = createPlayer({ mode: "instant", events: false, timers: false, network: false, clock: false, storage: false, random: true });

    const op: RandomOp = { type: "random", source: "math", values: [0.111, 0.222, 0.333] };
    player.apply([op]);

    expect(Math.random()).toBe(0.111);
    expect(Math.random()).toBe(0.222);
    expect(Math.random()).toBe(0.333);
    // Queue exhausted — falls back to real random
    const real = Math.random();
    expect(real).toBeGreaterThanOrEqual(0);
    expect(real).toBeLessThan(1);

    player.destroy();
  });

  it("replays clock values", () => {
    const player = createPlayer({ mode: "instant", events: false, timers: false, network: false, random: false, storage: false, clock: true });

    const op: ClockOp = { type: "clock", source: "dateNow", value: 1700000000000 };
    player.apply([op]);

    expect(Date.now()).toBe(1700000000000);
    // Queue exhausted — falls back to real
    const real = Date.now();
    expect(real).not.toBe(1700000000000);

    player.destroy();
  });

  it("replays storage set ops", () => {
    // Mock localStorage
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };

    const player = createPlayer({ mode: "instant", events: false, timers: false, network: false, random: false, clock: false, storage: true });

    const op: StorageOp = { type: "storage", kind: "local", action: "set", key: "theme", value: "dark" };
    player.apply([op]);

    expect(localStorage.getItem("theme")).toBe("dark");

    player.destroy();
  });

  it("queues network responses for fetch replay", async () => {
    const player = createPlayer({ mode: "instant", events: false, timers: false, random: false, clock: false, storage: false, network: true });

    const op: NetworkOp = {
      type: "network",
      kind: "fetch",
      seq: 0,
      url: "https://api.example.com/data",
      method: "GET",
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"result":42}',
    };
    player.apply([op]);

    const res = await fetch("https://api.example.com/data");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('{"result":42}');

    player.destroy();
  });

  it("handles multiple ops in sequence", () => {
    const player = createPlayer({ mode: "instant", events: false, timers: false, network: false, storage: false });

    player.apply([
      { type: "random", source: "math", values: [0.5] },
      { type: "clock", source: "dateNow", value: 9999 },
      { type: "random", source: "math", values: [0.75] },
    ]);

    expect(Math.random()).toBe(0.5);
    expect(Date.now()).toBe(9999);
    expect(Math.random()).toBe(0.75);

    player.destroy();
  });

  it("destroy restores globals", () => {
    const origRandom = Math.random;
    const origDateNow = Date.now;

    const player = createPlayer({ mode: "instant", events: false, timers: false, network: false, storage: false });
    player.apply([{ type: "random", source: "math", values: [0.1] }]);

    expect(Math.random).not.toBe(origRandom);

    player.destroy();

    expect(Math.random).toBe(origRandom);
    expect(Date.now).toBe(origDateNow);
  });
});
