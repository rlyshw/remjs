/**
 * Deep proxy wrapping for state trees.
 *
 * `wrap(target, path, emit)` returns a proxy over `target` that emits an Op
 * whenever the target is mutated. Nested objects/arrays/Maps/Sets returned
 * from reads are wrapped lazily with an extended path, so mutations through
 * any path in the tree are tracked.
 *
 * Caching note: once a target is wrapped, the resulting proxy is cached. If
 * the same target is later placed at a different path in the tree, mutations
 * through the cached proxy will still be reported at its original path. Most
 * apps store each object at exactly one path so this is rarely an issue, but
 * it's a known limitation of the lightweight design.
 */

import { encode } from "./codec.js";
import type { Op, Path } from "./ops.js";
import { RAW } from "./proxy-symbol.js";

export type Emit = (op: Op) => void;

const proxyCache = new WeakMap<object, unknown>();

function isWrappable(v: unknown): v is object {
  if (v === null || typeof v !== "object") return false;
  // Leaf types — encoded as values, never mutated in place.
  if (v instanceof Date) return false;
  if (v instanceof RegExp) return false;
  return true;
}

function unwrap<T>(v: T): T {
  if (v !== null && typeof v === "object" && (v as any)[RAW]) {
    return (v as any)[RAW];
  }
  return v;
}

export function wrap<T extends object>(target: T, path: Path, emit: Emit): T {
  if (!isWrappable(target)) return target;

  const cached = proxyCache.get(target);
  if (cached) return cached as T;

  let proxy: T;
  if (target instanceof Map) {
    proxy = wrapMap(target as unknown as Map<unknown, unknown>, path, emit) as unknown as T;
  } else if (target instanceof Set) {
    proxy = wrapSet(target as unknown as Set<unknown>, path, emit) as unknown as T;
  } else {
    proxy = wrapObject(target, path, emit);
  }

  proxyCache.set(target, proxy);
  return proxy;
}

function wrapObject<T extends object>(target: T, path: Path, emit: Emit): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === RAW) return t;
      const value = Reflect.get(t, prop, receiver);
      if (typeof prop === "symbol") return value;
      if (isWrappable(value)) {
        return wrap(value as object, [...path, prop as string], emit);
      }
      return value;
    },

    set(t, prop, value, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.set(t, prop, value, receiver);
      }
      const rawValue = unwrap(value);
      const result = Reflect.set(t, prop, rawValue, receiver);
      if (result) {
        emit({
          type: "set",
          path: [...path, prop as string],
          value: encode(rawValue),
        });
      }
      return result;
    },

    deleteProperty(t, prop) {
      if (typeof prop === "symbol") return Reflect.deleteProperty(t, prop);
      const result = Reflect.deleteProperty(t, prop);
      if (result) {
        emit({ type: "delete", path: [...path, prop as string] });
      }
      return result;
    },
  });
}

function wrapMap<K, V>(target: Map<K, V>, path: Path, emit: Emit): Map<K, V> {
  const proxy: Map<K, V> = new Proxy(target, {
    get(t, prop) {
      if (prop === RAW) return t;

      if (prop === "set") {
        return (k: K, v: V) => {
          const rawK = unwrap(k);
          const rawV = unwrap(v);
          t.set(rawK, rawV);
          emit({
            type: "mapSet",
            path,
            key: encode(rawK),
            value: encode(rawV),
          });
          return proxy;
        };
      }

      if (prop === "delete") {
        return (k: K) => {
          const rawK = unwrap(k);
          const existed = t.delete(rawK);
          if (existed) {
            emit({ type: "mapDelete", path, key: encode(rawK) });
          }
          return existed;
        };
      }

      if (prop === "clear") {
        return () => {
          if (t.size > 0) {
            t.clear();
            emit({ type: "mapClear", path });
          }
        };
      }

      // Everything else (get, has, size, keys, values, entries, forEach, @@iterator)
      // reads from the raw target. Function results are bound to the raw target
      // so internal slot access works.
      const val = Reflect.get(t, prop, t);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
  return proxy;
}

function wrapSet<V>(target: Set<V>, path: Path, emit: Emit): Set<V> {
  const proxy: Set<V> = new Proxy(target, {
    get(t, prop) {
      if (prop === RAW) return t;

      if (prop === "add") {
        return (v: V) => {
          const rawV = unwrap(v);
          if (!t.has(rawV)) {
            t.add(rawV);
            emit({ type: "setAdd", path, value: encode(rawV) });
          }
          return proxy;
        };
      }

      if (prop === "delete") {
        return (v: V) => {
          const rawV = unwrap(v);
          const existed = t.delete(rawV);
          if (existed) {
            emit({ type: "setDelete", path, value: encode(rawV) });
          }
          return existed;
        };
      }

      if (prop === "clear") {
        return () => {
          if (t.size > 0) {
            t.clear();
            emit({ type: "setClear", path });
          }
        };
      }

      const val = Reflect.get(t, prop, t);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
  return proxy;
}
