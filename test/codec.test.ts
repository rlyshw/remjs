import { describe, it, expect } from "vitest";
import { encode, decode } from "../src/codec.js";

describe("codec round-trips", () => {
  const cases: [string, unknown][] = [
    ["null", null],
    ["string", "hello"],
    ["number", 42],
    ["boolean", true],
    ["zero", 0],
    ["negative", -7.5],
    ["empty object", {}],
    ["empty array", []],
    ["nested object", { a: { b: { c: 1 } } }],
    ["nested array", [[1, 2], [3, 4]]],
    ["mixed", { list: [1, { x: "y" }], name: "hi" }],
  ];

  for (const [label, value] of cases) {
    it(`round-trips ${label}`, () => {
      expect(decode(encode(value))).toEqual(value);
    });
  }

  it("round-trips undefined", () => {
    expect(decode(encode(undefined))).toBe(undefined);
  });

  it("round-trips NaN / Infinity / -Infinity", () => {
    expect(decode(encode(NaN))).toBeNaN();
    expect(decode(encode(Infinity))).toBe(Infinity);
    expect(decode(encode(-Infinity))).toBe(-Infinity);
  });

  it("round-trips Date", () => {
    const d = new Date("2025-01-15T10:30:00Z");
    const out = decode(encode(d)) as Date;
    expect(out).toBeInstanceOf(Date);
    expect(out.getTime()).toBe(d.getTime());
  });

  it("round-trips RegExp", () => {
    const r = /foo[a-z]+/gi;
    const out = decode(encode(r)) as RegExp;
    expect(out).toBeInstanceOf(RegExp);
    expect(out.source).toBe(r.source);
    expect(out.flags).toBe(r.flags);
  });

  it("round-trips BigInt", () => {
    const b = 123456789012345678901234567890n;
    expect(decode(encode(b))).toBe(b);
  });

  it("round-trips Map", () => {
    const m = new Map<string, unknown>([
      ["a", 1],
      ["b", { nested: true }],
    ]);
    const out = decode(encode(m)) as Map<string, unknown>;
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(2);
    expect(out.get("a")).toBe(1);
    expect(out.get("b")).toEqual({ nested: true });
  });

  it("round-trips Set", () => {
    const s = new Set([1, 2, 3, "x"]);
    const out = decode(encode(s)) as Set<unknown>;
    expect(out).toBeInstanceOf(Set);
    expect(out.size).toBe(4);
    expect(out.has(1)).toBe(true);
    expect(out.has("x")).toBe(true);
  });

  it("round-trips JSON through a codec → JSON.stringify → JSON.parse → decode", () => {
    const original = {
      name: "Alice",
      created: new Date(2024, 0, 1),
      tags: new Set(["admin", "user"]),
      meta: new Map<string, number>([["version", 2]]),
      bigNumber: 10n ** 20n,
    };
    const wire = JSON.parse(JSON.stringify(encode(original)));
    const restored = decode(wire) as typeof original;
    expect(restored.name).toBe("Alice");
    expect((restored.created as Date).getTime()).toBe(original.created.getTime());
    expect(restored.tags).toBeInstanceOf(Set);
    expect((restored.tags as Set<string>).has("admin")).toBe(true);
    expect(restored.meta).toBeInstanceOf(Map);
    expect((restored.meta as Map<string, number>).get("version")).toBe(2);
    expect(restored.bigNumber).toBe(original.bigNumber);
  });
});
