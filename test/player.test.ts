import { describe, it, expect, afterEach } from "vitest";
import { createPlayer } from "../src/player.js";
import type { RandomOp, ClockOp, StorageOp, NetworkOp, TimerOp } from "../src/ops.js";

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

  it("fetch waits for NetworkOp when called before the op arrives", async () => {
    const player = createPlayer({ mode: "instant", events: false, timers: false, random: false, clock: false, storage: false, network: true });
    player.apply([]); // Force install so patched fetch is in place.

    // Call fetch FIRST — no op is queued yet. The returned Promise
    // must be pending until we apply the matching NetworkOp.
    const fetchPromise = fetch("https://api.example.com/slow");

    const op: NetworkOp = {
      type: "network",
      kind: "fetch",
      seq: 0,
      url: "https://api.example.com/slow",
      method: "GET",
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "ok",
    };

    // Apply the op; the pending fetch should resolve.
    player.apply([op]);

    const res = await fetchPromise;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    player.destroy();
  });

  it("destroy rejects pending fetch promises", async () => {
    const player = createPlayer({ mode: "instant", events: false, timers: false, random: false, clock: false, storage: false, network: true });
    player.apply([]); // Force install.

    const pending = fetch("https://api.example.com/never");
    player.destroy();

    await expect(pending).rejects.toThrow(/destroyed/);
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

  it("applies oracles before triggers within a batch (invariant)", () => {
    // Observability: use a fake querySelector that records the order
    // of calls. When applyEvent runs, it calls querySelector. By the
    // time the event is processed, the random queue must already be
    // populated with the oracle value from later in the batch.
    let randomQueueAtEvent: number | null = null;
    (globalThis as any).document = {
      querySelector: () => {
        randomQueueAtEvent = Math.random();
        return null; // short-circuit dispatch; we only need to observe ordering
      },
    };

    const player = createPlayer({ mode: "instant", timers: false, network: false, storage: false });

    // Batch in observation order: event first, random second.
    player.apply([
      { type: "event", eventType: "click", targetPath: "#x", timestamp: 0, detail: {} },
      { type: "random", source: "math", values: [0.42] },
    ]);

    // If the reorder works, by the time querySelector runs (inside
    // applyEvent), the random queue was already seeded with 0.42.
    expect(randomQueueAtEvent).toBe(0.42);

    delete (globalThis as any).document;
    player.destroy();
  });

  it("in temporal mode, oracles apply synchronously even with later ts", () => {
    let randomAtEvent: number | null = null;
    (globalThis as any).document = {
      querySelector: () => {
        randomAtEvent = Math.random();
        return null;
      },
    };

    const player = createPlayer({ mode: "temporal", timers: false, network: false, storage: false });

    // Event has EARLIER ts than the random that seeds its handler.
    // Before the fix, temporal scheduling would fire the event at ts 0
    // (immediately) while random waited until ts 100 — queue empty at
    // dispatch. With oracle-first apply, random lands synchronously
    // before any scheduling runs.
    player.apply([
      { type: "event", eventType: "click", targetPath: "#x", timestamp: 0, detail: {}, ts: 0 },
      { type: "random", source: "math", values: [0.91], ts: 100 },
    ]);

    expect(randomAtEvent).toBe(0.91);

    delete (globalThis as any).document;
    player.destroy();
  });

  it("accepts per-apply mode override", () => {
    // Default temporal, override to instant for catch-up batch
    const player = createPlayer({ mode: "temporal", events: false, timers: false, network: false, storage: false });

    player.apply(
      [
        { type: "random", source: "math", values: [0.5], ts: 1000 },
        { type: "random", source: "math", values: [0.75], ts: 5000 },
      ],
      { mode: "instant" },
    );

    // Under "instant" override both values land synchronously
    expect(Math.random()).toBe(0.5);
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

  describe("strict timers (0.5.1)", () => {
    it("setTimeout does not fire natively; fires on matching TimerOp", async () => {
      // Capture the native setTimeout BEFORE the player patches it,
      // so we can schedule our own wait independent of the gate.
      const nativeSetTimeout = globalThis.setTimeout;

      const player = createPlayer({
        mode: "instant", strict: true,
        events: false, network: false, random: false, clock: false, storage: false,
      });
      player.apply([]); // force install

      let fired = false;
      const id = setTimeout(() => { fired = true; }, 100);
      expect(typeof id).toBe("number");

      // Wait past the scheduled delay using native; no fire.
      await new Promise<void>((r) => nativeSetTimeout(r, 30));
      expect(fired).toBe(false);

      const op: TimerOp = { type: "timer", kind: "timeout", seq: id as unknown as number, scheduledDelay: 100, actualTime: 0 };
      player.apply([op]);
      expect(fired).toBe(true);

      player.destroy();
    });

    it("clearTimeout swallows the matching op", () => {
      const player = createPlayer({
        mode: "instant", strict: true,
        events: false, network: false, random: false, clock: false, storage: false,
      });
      player.apply([]);

      let fired = false;
      const id = setTimeout(() => { fired = true; }, 100);
      clearTimeout(id);

      const op: TimerOp = { type: "timer", kind: "timeout", seq: id as unknown as number, scheduledDelay: 100, actualTime: 0 };
      player.apply([op]);
      expect(fired).toBe(false);

      player.destroy();
    });

    it("setInterval fires once per op, not natively", () => {
      const player = createPlayer({
        mode: "instant", strict: true,
        events: false, network: false, random: false, clock: false, storage: false,
      });
      player.apply([]);

      let count = 0;
      const id = setInterval(() => { count++; }, 10);

      const op: TimerOp = { type: "timer", kind: "interval", seq: id as unknown as number, scheduledDelay: 10, actualTime: 0 };
      player.apply([op]);
      player.apply([op]);
      player.apply([op]);
      expect(count).toBe(3);

      clearInterval(id);
      player.apply([op]);
      expect(count).toBe(3);

      player.destroy();
    });

    it("non-strict: timer ops are no-ops; native timers fire", async () => {
      const player = createPlayer({
        mode: "instant",
        events: false, network: false, random: false, clock: false, storage: false,
      });
      player.apply([]);

      let fired = false;
      setTimeout(() => { fired = true; }, 5);
      await new Promise<void>((r) => setTimeout(r, 30));
      expect(fired).toBe(true);

      // Timer op is a no-op in non-strict mode.
      const op: TimerOp = { type: "timer", kind: "timeout", seq: 99999, scheduledDelay: 0, actualTime: 0 };
      player.apply([op]);

      player.destroy();
    });

    it("destroy restores setTimeout/setInterval/clearTimeout/clearInterval", () => {
      const origST = globalThis.setTimeout;
      const origSI = globalThis.setInterval;
      const origCT = globalThis.clearTimeout;
      const origCI = globalThis.clearInterval;

      const player = createPlayer({
        mode: "instant", strict: true,
        events: false, network: false, random: false, clock: false, storage: false,
      });
      player.apply([]);
      expect(globalThis.setTimeout).not.toBe(origST);

      player.destroy();
      expect(globalThis.setTimeout).toBe(origST);
      expect(globalThis.setInterval).toBe(origSI);
      expect(globalThis.clearTimeout).toBe(origCT);
      expect(globalThis.clearInterval).toBe(origCI);
    });
  });
});
