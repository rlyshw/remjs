import { describe, it, expect } from "vitest";
import { jsonCodec } from "../src/codec.js";
import type { Op, EventOp, TimerOp, NetworkOp, RandomOp, ClockOp, StorageOp, NavigationOp, SnapshotOp } from "../src/ops.js";

describe("jsonCodec", () => {
  it("round-trips an EventOp", () => {
    const op: EventOp = {
      type: "event",
      eventType: "click",
      targetPath: "div#root > button:nth-child(2)",
      timestamp: 1234567890.5,
      detail: { clientX: 100, clientY: 200, button: 0 },
    };
    expect(jsonCodec.decode(jsonCodec.encode(op))).toEqual(op);
  });

  it("round-trips a TimerOp", () => {
    const op: TimerOp = {
      type: "timer",
      kind: "timeout",
      seq: 3,
      scheduledDelay: 1000,
      actualTime: 1234568890.5,
    };
    expect(jsonCodec.decode(jsonCodec.encode(op))).toEqual(op);
  });

  it("round-trips a NetworkOp", () => {
    const op: NetworkOp = {
      type: "network",
      kind: "fetch",
      seq: 1,
      url: "https://api.example.com/data",
      method: "GET",
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"items":[1,2,3]}',
    };
    expect(jsonCodec.decode(jsonCodec.encode(op))).toEqual(op);
  });

  it("round-trips a RandomOp", () => {
    const op: RandomOp = {
      type: "random",
      source: "math",
      values: [0.123456, 0.789012, 0.345678],
    };
    expect(jsonCodec.decode(jsonCodec.encode(op))).toEqual(op);
  });

  it("round-trips a ClockOp", () => {
    const op: ClockOp = {
      type: "clock",
      source: "dateNow",
      value: 1712345678000,
    };
    expect(jsonCodec.decode(jsonCodec.encode(op))).toEqual(op);
  });

  it("round-trips a StorageOp", () => {
    const op: StorageOp = {
      type: "storage",
      kind: "local",
      action: "set",
      key: "user-pref",
      value: '{"theme":"dark"}',
    };
    expect(jsonCodec.decode(jsonCodec.encode(op))).toEqual(op);
  });

  it("round-trips a NavigationOp", () => {
    const op: NavigationOp = {
      type: "navigation",
      kind: "pushState",
      url: "/page/2",
      state: { page: 2 },
    };
    expect(jsonCodec.decode(jsonCodec.encode(op))).toEqual(op);
  });

  it("round-trips a SnapshotOp", () => {
    const op: SnapshotOp = {
      type: "snapshot",
      html: "<html><body>hello</body></html>",
      url: "http://localhost:3000",
      timestamp: 1712345678000,
      pendingTimers: [{ seq: 0, kind: "interval", remainingDelay: 500 }],
      pendingNetwork: [{ seq: 1, url: "https://api.example.com", method: "GET" }],
    };
    expect(jsonCodec.decode(jsonCodec.encode(op))).toEqual(op);
  });

  it("round-trips a batch of mixed ops", () => {
    const ops: Op[] = [
      { type: "clock", source: "dateNow", value: 1000 },
      { type: "random", source: "math", values: [0.5] },
      { type: "event", eventType: "click", targetPath: "button", timestamp: 1001, detail: {} },
      { type: "timer", kind: "timeout", seq: 0, scheduledDelay: 100, actualTime: 1100 },
    ];
    expect(jsonCodec.decodeBatch(jsonCodec.encodeBatch(ops))).toEqual(ops);
  });

  it("handles NetworkOp with null body", () => {
    const op: NetworkOp = {
      type: "network",
      kind: "fetch",
      seq: 0,
      url: "https://example.com",
      status: 204,
      body: null,
    };
    expect(jsonCodec.decode(jsonCodec.encode(op))).toEqual(op);
  });

  it("preserves optional peer field on ops", () => {
    const op: EventOp = {
      type: "event",
      peer: "alice",
      eventType: "click",
      targetPath: "#btn",
      timestamp: 0,
      detail: {},
    };
    expect(jsonCodec.decode(jsonCodec.encode(op))).toEqual(op);
  });

  it("encodes and decodes batch envelope with meta", () => {
    const ops: Op[] = [
      { type: "random", source: "math", values: [0.5] },
      { type: "clock", source: "dateNow", value: 1000 },
    ];
    const encoded = jsonCodec.encodeBatchWithMeta({ from: "alice", ops });
    const decoded = jsonCodec.decodeBatchWithMeta(encoded);
    expect(decoded.from).toBe("alice");
    expect(decoded.ops).toEqual(ops);
  });
});
