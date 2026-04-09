/**
 * Value encoding/decoding.
 *
 * `encode` turns an arbitrary JS value into a JSON-safe EncodedValue,
 * handling all the built-in types that plain JSON can't express.
 * `decode` is the inverse.
 *
 * Plain objects and arrays are encoded recursively. Special types
 * (undefined, Date, Map, Set, RegExp, BigInt, NaN, ±Infinity) are
 * wrapped in an object with a reserved `__remjs` tag key.
 *
 * Circular references are not supported in the initial version.
 */

import { TAG, type EncodedValue } from "./ops.js";
import { RAW } from "./proxy-symbol.js";

function isTagged(v: unknown): v is { [TAG]: string } {
  return typeof v === "object" && v !== null && TAG in (v as object);
}

/** If the value is a remjs proxy, return its raw target; otherwise return as-is. */
function unwrapRaw(v: unknown): unknown {
  if (v !== null && typeof v === "object" && (v as any)[RAW]) {
    return (v as any)[RAW];
  }
  return v;
}

export function encode(value: unknown): EncodedValue {
  const v = unwrapRaw(value);

  if (v === null) return null;
  if (v === undefined) return { [TAG]: "undef" };

  const t = typeof v;
  if (t === "string" || t === "boolean") return v as string | boolean;
  if (t === "number") {
    const n = v as number;
    if (Number.isNaN(n)) return { [TAG]: "nan" };
    if (n === Infinity) return { [TAG]: "inf" };
    if (n === -Infinity) return { [TAG]: "ninf" };
    return n;
  }
  if (t === "bigint") return { [TAG]: "bigint", v: (v as bigint).toString() };

  if (v instanceof Date) return { [TAG]: "date", v: v.getTime() };
  if (v instanceof RegExp) return { [TAG]: "regex", src: v.source, flags: v.flags };

  if (v instanceof Map) {
    const entries: [EncodedValue, EncodedValue][] = [];
    for (const [k, val] of v as Map<unknown, unknown>) {
      entries.push([encode(k), encode(val)]);
    }
    return { [TAG]: "map", entries };
  }

  if (v instanceof Set) {
    const values: EncodedValue[] = [];
    for (const val of v as Set<unknown>) values.push(encode(val));
    return { [TAG]: "set", values };
  }

  if (Array.isArray(v)) return v.map(encode);

  if (t === "object") {
    const out: Record<string, EncodedValue> = {};
    for (const k of Object.keys(v as object)) {
      out[k] = encode((v as Record<string, unknown>)[k]);
    }
    return out;
  }

  throw new Error(`remjs: cannot encode value of type ${t}`);
}

export function decode(value: EncodedValue): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t !== "object") return value;

  if (Array.isArray(value)) return value.map(decode);

  if (isTagged(value)) {
    const tag = (value as any)[TAG];
    switch (tag) {
      case "undef":
        return undefined;
      case "nan":
        return NaN;
      case "inf":
        return Infinity;
      case "ninf":
        return -Infinity;
      case "bigint":
        return BigInt((value as any).v);
      case "date":
        return new Date((value as any).v);
      case "regex":
        return new RegExp((value as any).src, (value as any).flags);
      case "map": {
        const m = new Map<unknown, unknown>();
        for (const [k, v] of (value as any).entries) m.set(decode(k), decode(v));
        return m;
      }
      case "set": {
        const s = new Set<unknown>();
        for (const v of (value as any).values) s.add(decode(v));
        return s;
      }
      default:
        throw new Error(`remjs: unknown tag ${tag}`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as object)) {
    out[k] = decode((value as Record<string, EncodedValue>)[k]);
  }
  return out;
}
