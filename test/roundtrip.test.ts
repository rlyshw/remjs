import { describe, it, expect } from "vitest";
import { createRecorder } from "../src/recorder.js";
import { createPlayer } from "../src/player.js";
import { jsonCodec } from "../src/codec.js";
import type { Op } from "../src/ops.js";

describe("end-to-end roundtrip", () => {
  it("record → encode → decode → replay produces identical random sequence", () => {
    const recorded: Op[] = [];
    const recorder = createRecorder({
      onOps: (batch) => recorded.push(...batch),
      batchMode: "sync",
      events: false,
      timers: false,
      network: false,
      storage: false,
    });

    // Record
    recorder.start();
    const sourceValues = [Math.random(), Math.random(), Math.random()];
    recorder.stop();

    // Encode → decode (simulate wire)
    const wire = jsonCodec.encodeBatch(recorded);
    const decoded = jsonCodec.decodeBatch(wire);

    // Replay
    const player = createPlayer({
      mode: "instant",
      events: false,
      timers: false,
      network: false,
      storage: false,
    });

    const randomOps = decoded.filter((o) => o.type === "random");
    player.apply(randomOps);

    const replayValues = [Math.random(), Math.random(), Math.random()];
    player.destroy();

    expect(replayValues).toEqual(sourceValues);
  });

  it("record → replay produces identical clock values", () => {
    const recorded: Op[] = [];
    const recorder = createRecorder({
      onOps: (batch) => recorded.push(...batch),
      batchMode: "sync",
      events: false,
      timers: false,
      network: false,
      random: false,
      storage: false,
    });

    recorder.start();
    const t1 = Date.now();
    const t2 = Date.now();
    recorder.stop();

    const wire = jsonCodec.encodeBatch(recorded);
    const decoded = jsonCodec.decodeBatch(wire);

    const player = createPlayer({
      events: false,
      timers: false,
      network: false,
      random: false,
      storage: false,
    });

    player.apply(decoded.filter((o) => o.type === "clock"));

    const r1 = Date.now();
    const r2 = Date.now();
    player.destroy();

    expect(r1).toBe(t1);
    expect(r2).toBe(t2);
  });

  it("mixed random + clock round-trip preserves order", () => {
    const recorded: Op[] = [];
    const recorder = createRecorder({
      onOps: (batch) => recorded.push(...batch),
      batchMode: "sync",
      events: false,
      timers: false,
      network: false,
      storage: false,
    });

    recorder.start();
    const seq = [
      { kind: "random", v: Math.random() },
      { kind: "clock", v: Date.now() },
      { kind: "random", v: Math.random() },
      { kind: "clock", v: Date.now() },
    ];
    recorder.stop();

    const wire = jsonCodec.encodeBatch(recorded);
    const decoded = jsonCodec.decodeBatch(wire);

    const player = createPlayer({
      mode: "instant",
      events: false,
      timers: false,
      network: false,
      storage: false,
    });

    player.apply(decoded);

    const replay = [
      { kind: "random", v: Math.random() },
      { kind: "clock", v: Date.now() },
      { kind: "random", v: Math.random() },
      { kind: "clock", v: Date.now() },
    ];
    player.destroy();

    expect(replay).toEqual(seq);
  });

  it("async handler: recorder + player replicate oracles across an await fetch", async () => {
    // Install a fake real-fetch on the leader side so the recorder's
    // network patch has something to observe.
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string) =>
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });

    const recorded: Op[][] = [];
    const recorder = createRecorder({
      onOps: (batch) => recorded.push([...batch]),
      batchMode: "task",
      events: false, timers: false, storage: false,
    });
    recorder.start();

    // Simulate the leader's async handler: sync oracle, await fetch,
    // another sync oracle.
    const leaderA = Math.random();
    const leaderResp = await fetch("https://api.example.com/x");
    const leaderBody = await leaderResp.text();
    const leaderB = Math.random();

    // Let the task-boundary flush fire.
    await new Promise<void>((r) => setTimeout(r, 0));
    recorder.stop();
    (globalThis as any).fetch = origFetch;

    // Flatten all batches in order (preserves ts order).
    const allOps = recorded.flat();

    // Replay on the follower.
    const player = createPlayer({
      mode: "instant",
      events: false, timers: false, storage: false,
    });

    // Apply all recorded batches to seed queues and populate fetch.
    for (const batch of recorded) player.apply(batch);

    const followerA = Math.random();
    const followerResp = await fetch("https://api.example.com/x");
    const followerBody = await followerResp.text();
    const followerB = Math.random();

    expect(followerA).toBe(leaderA);
    expect(followerBody).toBe(leaderBody);
    expect(followerB).toBe(leaderB);

    player.destroy();
    void allOps; // silence unused
  });
});
