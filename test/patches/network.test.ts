import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installNetworkPatch } from "../../src/patches/network.js";
import type { NetworkOp } from "../../src/ops.js";

describe("network patch", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("records fetch response", async () => {
    // Mock fetch
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof globalThis.fetch;

    const ops: NetworkOp[] = [];
    const uninstall = installNetworkPatch((op) => ops.push(op));

    const res = await fetch("https://api.example.com/data");
    const body = await res.text();

    uninstall();

    expect(body).toBe('{"ok":true}');
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe("network");
    expect(ops[0]!.kind).toBe("fetch");
    expect(ops[0]!.seq).toBe(0);
    expect(ops[0]!.url).toBe("https://api.example.com/data");
    expect(ops[0]!.method).toBe("GET");
    expect(ops[0]!.status).toBe(200);
    expect(ops[0]!.body).toBe('{"ok":true}');
  });

  it("assigns incrementing seq numbers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    ) as typeof globalThis.fetch;

    const ops: NetworkOp[] = [];
    const uninstall = installNetworkPatch((op) => ops.push(op));

    await fetch("https://a.com");
    await fetch("https://b.com");

    uninstall();

    expect(ops).toHaveLength(2);
    expect(ops[0]!.seq).toBe(0);
    expect(ops[1]!.seq).toBe(1);
  });

  it("records POST method", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("created", { status: 201 }),
    ) as typeof globalThis.fetch;

    const ops: NetworkOp[] = [];
    const uninstall = installNetworkPatch((op) => ops.push(op));

    await fetch("https://api.example.com/items", { method: "POST" });

    uninstall();

    expect(ops[0]!.method).toBe("POST");
  });

  it("restores original fetch on uninstall", () => {
    const mock = vi.fn().mockResolvedValue(new Response("")) as typeof globalThis.fetch;
    globalThis.fetch = mock;

    const uninstall = installNetworkPatch(() => {});
    expect(globalThis.fetch).not.toBe(mock);

    uninstall();
    expect(globalThis.fetch).toBe(mock);
  });
});
