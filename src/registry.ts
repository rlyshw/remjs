/**
 * Object registry — stable id management for tracked JS objects.
 *
 * The JS-state analog of remdom's `NodeRegistry`. Assigns a UUID to
 * each tracked object on first observation, exposes bidirectional
 * lookup (`obj → id`, `id → obj`), and walks an object graph to assign
 * ids recursively (used at `track()` time and at `snapshot()` time).
 *
 * Storage:
 *   - A `WeakMap<object, string>` for the live `obj → id` lookup. Used
 *     so passing in a proxy (which has the raw target as a [[Target]])
 *     transparently maps to the underlying id.
 *   - A `Map<string, object>` for the `id → obj` lookup. **Strong** —
 *     the registry holds tracked objects alive for as long as it
 *     exists. The observer is the lifecycle manager: if you tracked it,
 *     you wanted it kept around until `destroy()` / `clear()`.
 *
 * Earlier versions used `WeakRef<object>` for the `id → obj` map. That
 * caused intermittent bugs where V8's GC would collect tracked roots
 * across async boundaries even when the host app held a module-level
 * strong reference, because the registry side had no strong link.
 * Strong references in the registry are the simpler and more
 * predictable contract — drop the registry to release the objects.
 *
 * Leaf types (Date, RegExp, BigInt, primitives) are not tracked —
 * they're encoded by value, never by reference.
 */

import { RAW } from "./proxy-symbol.js";

/** If `obj` is a remjs proxy, return the raw target underneath; otherwise
 *  return `obj` unchanged. The registry uses the raw target as the key
 *  in its WeakMap so passing in a proxy works transparently. */
function unwrapForLookup(obj: object): object {
  const raw = (obj as Record<symbol, unknown>)[RAW];
  return raw === undefined || raw === null ? obj : (raw as object);
}

export interface ObjectRegistry {
  /** Assign an id to an object if it doesn't have one. Returns the id.
   *  Idempotent: a second call returns the same id. */
  assignId(obj: object): string;
  /** Adopt a specific id for an object. Used by the receiver to mirror
   *  ids from the source's id space. If the object already has a
   *  different id, throws. */
  adopt(obj: object, id: string): void;
  /** Look up an object's id without assigning. Returns null if untracked. */
  getIdOf(obj: object): string | null;
  /** Look up an object by its id. Returns null if untracked or GCed. */
  getObjectById(id: string): object | null;
  /** Walk an object graph, recursively assigning ids to every reachable
   *  trackable object. Cycles are handled — already-assigned objects
   *  are not revisited. */
  walkAndAssign(root: object): void;
  /** Iterate every currently-live tracked object. Stale WeakRefs are
   *  pruned during iteration. */
  entries(): IterableIterator<[string, object]>;
  /** Drop all entries. */
  clear(): void;
}

/** Generate a fresh id. Uses crypto.randomUUID where available, falls
 *  back to a Math.random hex string elsewhere. Matches remdom's format. */
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** True for objects that should be tracked by reference (and thus get
 *  an id). Leaf types are encoded by value and don't get ids. */
function isTrackable(v: unknown): v is object {
  if (v === null || typeof v !== "object") return false;
  if (v instanceof Date) return false;
  if (v instanceof RegExp) return false;
  return true;
}

export function createObjectRegistry(): ObjectRegistry {
  const objToId = new WeakMap<object, string>();
  const idToObj = new Map<string, object>();

  function assignId(obj: object): string {
    const target = unwrapForLookup(obj);
    const cached = objToId.get(target);
    if (cached) return cached;
    const id = generateId();
    objToId.set(target, id);
    idToObj.set(id, target);
    return id;
  }

  function adopt(obj: object, id: string): void {
    const target = unwrapForLookup(obj);
    const existing = objToId.get(target);
    if (existing) {
      if (existing !== id) {
        throw new Error(
          `remjs: cannot adopt id ${id} for object that already has id ${existing}`,
        );
      }
      return;
    }
    objToId.set(target, id);
    idToObj.set(id, target);
  }

  function getIdOf(obj: object): string | null {
    return objToId.get(unwrapForLookup(obj)) ?? null;
  }

  function getObjectById(id: string): object | null {
    return idToObj.get(id) ?? null;
  }

  function walkAndAssign(root: object): void {
    if (!isTrackable(root)) return;
    const seen = new WeakSet<object>();
    const stack: object[] = [root];
    while (stack.length > 0) {
      const obj = stack.pop()!;
      if (seen.has(obj)) continue;
      seen.add(obj);
      assignId(obj);

      if (obj instanceof Map) {
        for (const [k, v] of obj as Map<unknown, unknown>) {
          if (isTrackable(k)) stack.push(k);
          if (isTrackable(v)) stack.push(v);
        }
        continue;
      }
      if (obj instanceof Set) {
        for (const v of obj as Set<unknown>) {
          if (isTrackable(v)) stack.push(v);
        }
        continue;
      }
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          const v = obj[i];
          if (isTrackable(v)) stack.push(v);
        }
        continue;
      }
      // Plain object — walk its own enumerable string keys. Symbol-keyed
      // properties (including our own ID symbol) are intentionally skipped.
      for (const k of Object.keys(obj)) {
        const v = (obj as Record<string, unknown>)[k];
        if (isTrackable(v)) stack.push(v);
      }
    }
  }

  function* entries(): IterableIterator<[string, object]> {
    yield* idToObj;
  }

  function clear(): void {
    idToObj.clear();
    // The WeakMap can't be cleared directly; it'll GC naturally as
    // references die. The next assignId on a previously-tracked object
    // will see no entry and assign a fresh id.
  }

  return { assignId, adopt, getIdOf, getObjectById, walkAndAssign, entries, clear };
}
