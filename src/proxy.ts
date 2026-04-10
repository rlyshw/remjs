/**
 * Deep proxy wrapping for state objects and graphs.
 *
 * `wrap(target, registry, emit)` returns a proxy over `target` that
 * emits an Op whenever the target is mutated. Nested objects returned
 * from reads are wrapped lazily with the same registry and `emit`
 * callback, so mutations through any path in the graph are tracked.
 *
 * Each tracked object gets a stable id from the registry; emitted ops
 * carry `target: { kind: "ref", id, prop }` so the receiver can mutate
 * the exact object regardless of which path it was reached through.
 * Shared references and cycles work because the registry assigns the
 * same id to the same target on every walk.
 */

import { encode } from "./codec.js";
import type { Op, Target } from "./ops.js";
import type { ObjectRegistry } from "./registry.js";
import { RAW } from "./proxy-symbol.js";

export type Emit = (op: Op) => void;

const proxyCache = new WeakMap<object, unknown>();

function isWrappable(v: unknown): v is object {
  if (v === null || typeof v !== "object") return false;
  if (v instanceof Date) return false;
  if (v instanceof RegExp) return false;
  return true;
}

function unwrap<T>(v: T): T {
  if (v !== null && typeof v === "object" && (v as Record<symbol, unknown>)[RAW]) {
    return (v as Record<symbol, T>)[RAW];
  }
  return v;
}

/** Encode helper bundle for the proxy. Emits refs for already-tracked
 *  objects and newobj tags (with freshly-assigned ids) for new ones, so
 *  the receiver can adopt every id this op introduces. */
function makeEncodeOpts(
  registry: ObjectRegistry,
): import("./codec.js").EncodeOptions {
  return {
    refOf: (obj) => registry.getIdOf(obj),
    assignId: (obj) => registry.assignId(obj),
  };
}

/**
 * Wrap a target object in a proxy that emits ops on mutation.
 *
 * @param target — the raw object to wrap (must not already be a proxy)
 * @param registry — the ObjectRegistry that owns id assignment
 * @param emit — callback that receives each op as it's produced
 */
export function wrap<T extends object>(
  target: T,
  registry: ObjectRegistry,
  emit: Emit,
): T {
  if (!isWrappable(target)) return target;

  const cached = proxyCache.get(target);
  if (cached) return cached as T;

  // Assign an id eagerly so the registry knows about this object before
  // any of its children are walked.
  registry.assignId(target);

  let proxy: T;
  if (target instanceof Map) {
    proxy = wrapMap(
      target as unknown as Map<unknown, unknown>,
      registry,
      emit,
    ) as unknown as T;
  } else if (target instanceof Set) {
    proxy = wrapSet(
      target as unknown as Set<unknown>,
      registry,
      emit,
    ) as unknown as T;
  } else {
    proxy = wrapObject(target, registry, emit);
  }

  proxyCache.set(target, proxy);
  return proxy;
}

function wrapObject<T extends object>(
  target: T,
  registry: ObjectRegistry,
  emit: Emit,
): T {
  const encodeOpts = makeEncodeOpts(registry);
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === RAW) return t;
      const value = Reflect.get(t, prop, receiver);
      if (typeof prop === "symbol") return value;
      if (isWrappable(value)) {
        return wrap(value as object, registry, emit);
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
          target: makeChildTarget(target, prop as string, registry),
          value: encode(rawValue, encodeOpts),
        });
      }
      return result;
    },

    deleteProperty(t, prop) {
      if (typeof prop === "symbol") return Reflect.deleteProperty(t, prop);
      const result = Reflect.deleteProperty(t, prop);
      if (result) {
        emit({
          type: "delete",
          target: makeChildTarget(target, prop as string, registry),
        });
      }
      return result;
    },
  });
}

function wrapMap<K, V>(
  target: Map<K, V>,
  registry: ObjectRegistry,
  emit: Emit,
): Map<K, V> {
  const encodeOpts = makeEncodeOpts(registry);
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
            target: makeSelfTarget(target, registry),
            key: encode(rawK, encodeOpts),
            value: encode(rawV, encodeOpts),
          });
          return proxy;
        };
      }

      if (prop === "delete") {
        return (k: K) => {
          const rawK = unwrap(k);
          const existed = t.delete(rawK);
          if (existed) {
            emit({
              type: "mapDelete",
              target: makeSelfTarget(target, registry),
              key: encode(rawK, encodeOpts),
            });
          }
          return existed;
        };
      }

      if (prop === "clear") {
        return () => {
          if (t.size > 0) {
            t.clear();
            emit({
              type: "mapClear",
              target: makeSelfTarget(target, registry),
            });
          }
        };
      }

      const val = Reflect.get(t, prop, t);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
  return proxy;
}

function wrapSet<V>(
  target: Set<V>,
  registry: ObjectRegistry,
  emit: Emit,
): Set<V> {
  const encodeOpts = makeEncodeOpts(registry);
  const proxy: Set<V> = new Proxy(target, {
    get(t, prop) {
      if (prop === RAW) return t;

      if (prop === "add") {
        return (v: V) => {
          const rawV = unwrap(v);
          if (!t.has(rawV)) {
            t.add(rawV);
            emit({
              type: "setAdd",
              target: makeSelfTarget(target, registry),
              value: encode(rawV, encodeOpts),
            });
          }
          return proxy;
        };
      }

      if (prop === "delete") {
        return (v: V) => {
          const rawV = unwrap(v);
          const existed = t.delete(rawV);
          if (existed) {
            emit({
              type: "setDelete",
              target: makeSelfTarget(target, registry),
              value: encode(rawV, encodeOpts),
            });
          }
          return existed;
        };
      }

      if (prop === "clear") {
        return () => {
          if (t.size > 0) {
            t.clear();
            emit({
              type: "setClear",
              target: makeSelfTarget(target, registry),
            });
          }
        };
      }

      const val = Reflect.get(t, prop, t);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
  return proxy;
}

/* ── Target construction ─────────────────────────────────────────── */

/** Build the `target` field for an op that affects a property of `parent`. */
function makeChildTarget(
  parent: object,
  prop: string,
  registry: ObjectRegistry,
): Target {
  return {
    kind: "ref",
    id: registry.assignId(parent),
    prop,
  };
}

/** Build the `target` field for an op that affects the wrapped object
 *  itself (e.g. mapClear, setAdd — the target IS the Map/Set). */
function makeSelfTarget(target: object, registry: ObjectRegistry): Target {
  return {
    kind: "ref",
    id: registry.assignId(target),
  };
}
