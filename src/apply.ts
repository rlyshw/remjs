/**
 * Receiver-side op application.
 *
 * `applyOp` / `applyOps` take a state graph and mutate it in place to
 * match the sender's state. The receiver maintains its own
 * `ObjectRegistry` that mirrors the source's id space — when an
 * incoming op carries a ref-based target, the receiver looks up the
 * id in its own registry to find the target object to mutate.
 *
 * v0.2 supports two op-target shapes:
 *  - **Path** (`target.kind === "path"`): walk a path from the snapshot
 *    root, mutate the leaf. v0.1 model. Used by the `createStateStream`
 *    legacy alias and tree-shaped state.
 *  - **Ref** (`target.kind === "ref"`): look up the target object by id
 *    in the receiver's registry, mutate the named property. v0.2 model.
 *    Used by `createObserver` and graph-shaped state.
 *
 * Snapshot ops come in two flavors:
 *  - **Tree snapshot** (v0.1): a single encoded value at the root.
 *    `decode`d directly and returned as the new root.
 *  - **Graph snapshot** (v0.2): a flat list of `{id, encoded}` entries.
 *    Two-pass reconstruction: phase 1 builds empty placeholder objects
 *    of the right type and registers them by id; phase 2 fills in each
 *    placeholder with decoded contents, with refs resolved against the
 *    just-built registry.
 *
 * Backward compat: v0.1 ops with a top-level `path` field (no `target`)
 * are normalized via `normalizeLegacyOp` before dispatch.
 */

import { decode, type DecodeOptions } from "./codec.js";
import {
  normalizeLegacyOp,
  type Op,
  type Path,
  type Target,
  type SnapshotOp,
  type EncodedValue,
  TAG,
} from "./ops.js";
import { createObjectRegistry, type ObjectRegistry } from "./registry.js";

/* ── Path resolution ──────────────────────────────────────────────── */

function walkPath(root: unknown, path: Path): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || current === undefined) {
      throw new Error(
        `remjs: cannot walk path ${path.join(".")} — encountered nullish at ${key}`,
      );
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Resolve a target to `{ parent, key }` for ops that mutate a property,
 *  or `{ target, key: null }` for ops that mutate the target itself
 *  (mapClear, setAdd, etc). */
function resolveTarget(
  root: unknown,
  registry: ObjectRegistry,
  target: Target,
): { container: unknown; key: string | null } {
  if (target.kind === "path") {
    if (target.path.length === 0) {
      return { container: root, key: null };
    }
    const parentPath = target.path.slice(0, -1);
    const key = target.path[target.path.length - 1]!;
    const parent = walkPath(root, parentPath);
    return { container: parent, key };
  }
  // Ref-based: look up the object by id in the receiver's registry.
  const obj = registry.getObjectById(target.id);
  if (!obj) {
    throw new Error(
      `remjs: cannot resolve ref id ${target.id} — not in receiver registry. Did you miss a snapshot?`,
    );
  }
  return { container: obj, key: target.prop ?? null };
}

/* ── Op application ───────────────────────────────────────────────── */

/**
 * Apply a single op to `root`. Returns the (possibly new) root.
 *
 * For most op types the root is mutated in place and returned unchanged.
 * For `snapshot` ops a brand-new root is constructed and returned, so
 * callers must always re-bind to the return value.
 *
 * The `registry` parameter is the receiver's own ObjectRegistry. It's
 * populated by snapshot ops (which assign ids to reconstructed objects)
 * and used by ref-target resolution. For pure path-addressed op streams
 * (legacy v0.1) the registry is unused but must still be provided.
 */
export function applyOp(
  root: unknown,
  op: Op,
  registry: ObjectRegistry,
): unknown {
  // Normalize legacy v0.1 ops (top-level `path`) into the v0.2 shape.
  op = normalizeLegacyOp(op);

  switch (op.type) {
    case "snapshot":
      return applySnapshot(op, registry);

    case "set": {
      const decodeOpts = makeDecodeOpts(registry);
      const value = decode(op.value, decodeOpts);
      const { container, key } = resolveTarget(root, registry, op.target);
      if (key === null) {
        throw new Error("remjs: cannot apply set op with empty target");
      }
      (container as Record<string, unknown>)[key] = value;
      return root;
    }

    case "delete": {
      const { container, key } = resolveTarget(root, registry, op.target);
      if (key === null) {
        throw new Error("remjs: cannot apply delete op with empty target");
      }
      delete (container as Record<string, unknown>)[key];
      return root;
    }

    case "mapSet": {
      const decodeOpts = makeDecodeOpts(registry);
      const { container } = resolveTarget(root, registry, op.target);
      (container as Map<unknown, unknown>).set(
        decode(op.key, decodeOpts),
        decode(op.value, decodeOpts),
      );
      return root;
    }

    case "mapDelete": {
      const decodeOpts = makeDecodeOpts(registry);
      const { container } = resolveTarget(root, registry, op.target);
      (container as Map<unknown, unknown>).delete(decode(op.key, decodeOpts));
      return root;
    }

    case "mapClear": {
      const { container } = resolveTarget(root, registry, op.target);
      (container as Map<unknown, unknown>).clear();
      return root;
    }

    case "setAdd": {
      const decodeOpts = makeDecodeOpts(registry);
      const { container } = resolveTarget(root, registry, op.target);
      (container as Set<unknown>).add(decode(op.value, decodeOpts));
      return root;
    }

    case "setDelete": {
      const decodeOpts = makeDecodeOpts(registry);
      const { container } = resolveTarget(root, registry, op.target);
      (container as Set<unknown>).delete(decode(op.value, decodeOpts));
      return root;
    }

    case "setClear": {
      const { container } = resolveTarget(root, registry, op.target);
      (container as Set<unknown>).clear();
      return root;
    }
  }
}

export function applyOps(
  root: unknown,
  ops: readonly Op[],
  registry: ObjectRegistry,
): unknown {
  for (const op of ops) root = applyOp(root, op, registry);
  return root;
}

/* ── Snapshot reconstruction ──────────────────────────────────────── */

function applySnapshot(op: SnapshotOp, registry: ObjectRegistry): unknown {
  // Tree snapshot (v0.1): single encoded value at the root.
  if (op.value !== undefined) {
    return decode(op.value, makeDecodeOpts(registry));
  }

  // Graph snapshot (v0.2): two-pass reconstruction.
  if (op.objects && op.rootIds) {
    // Phase 1: clear the registry and create empty placeholders for
    // each tracked object. The placeholder type matches what the
    // encoded form is — array, Map, Set, or plain object.
    registry.clear();
    const placeholders = new Map<string, object>();
    for (const { id, encoded } of op.objects) {
      const placeholder = makePlaceholder(encoded);
      placeholders.set(id, placeholder);
      registry.adopt(placeholder, id);
    }

    // Phase 2: decode each entry's contents (refs resolve through the
    // registry, returning the placeholders) and copy into the placeholder.
    const decodeOpts = makeDecodeOpts(registry);
    for (const { id, encoded } of op.objects) {
      const placeholder = placeholders.get(id)!;
      const decoded = decode(encoded, decodeOpts);
      hydratePlaceholder(placeholder, decoded);
    }

    // Return the first root id's object as the new root. If there are
    // multiple roots, callers should consult `registry.getObjectById`
    // for each root id.
    if (op.rootIds.length === 0) return null;
    return placeholders.get(op.rootIds[0]!) ?? null;
  }

  throw new Error("remjs: snapshot op has neither `value` nor `objects`+`rootIds`");
}

/** Build an empty placeholder of the right type for an encoded value. */
function makePlaceholder(encoded: EncodedValue): object {
  if (Array.isArray(encoded)) return [];
  if (encoded && typeof encoded === "object" && TAG in encoded) {
    const tag = (encoded as { [TAG]: string })[TAG];
    if (tag === "map") return new Map();
    if (tag === "set") return new Set();
  }
  return {};
}

/** Copy decoded contents into an existing placeholder of the right type. */
function hydratePlaceholder(placeholder: object, decoded: unknown): void {
  if (Array.isArray(placeholder) && Array.isArray(decoded)) {
    placeholder.length = 0;
    for (const item of decoded) placeholder.push(item);
    return;
  }
  if (placeholder instanceof Map && decoded instanceof Map) {
    placeholder.clear();
    for (const [k, v] of decoded) placeholder.set(k, v);
    return;
  }
  if (placeholder instanceof Set && decoded instanceof Set) {
    placeholder.clear();
    for (const v of decoded) placeholder.add(v);
    return;
  }
  if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
    // Plain object — copy own keys
    for (const k of Object.keys(decoded)) {
      (placeholder as Record<string, unknown>)[k] = (
        decoded as Record<string, unknown>
      )[k];
    }
    return;
  }
  throw new Error("remjs: placeholder type mismatch during snapshot hydration");
}

/* ── Decode options ───────────────────────────────────────────────── */

function makeDecodeOpts(registry: ObjectRegistry): DecodeOptions {
  return {
    resolveRef: (id) => registry.getObjectById(id),
    adoptObject: (id, obj) => registry.adopt(obj, id),
  };
}

/* ── Receiver helper ──────────────────────────────────────────────── */

/**
 * A receiver holds the reconstructed state and the registry that backs
 * ref resolution. The `state` getter always returns the current root
 * (which may be replaced by a snapshot op).
 */
export interface Receiver<T> {
  readonly state: T;
  readonly registry: ObjectRegistry;
  apply(ops: readonly Op[]): void;
}

export function createReceiver<T = unknown>(initial?: T): Receiver<T> {
  let root: unknown = initial ?? {};
  const registry = createObjectRegistry();
  return {
    get state() {
      return root as T;
    },
    get registry() {
      return registry;
    },
    apply(ops) {
      root = applyOps(root, ops, registry);
    },
  };
}

/* ── Helper for callers that don't have a registry ────────────────── */

/** Backward-compat shim: applyOps with an implicit fresh registry.
 *  The original v0.1 signature was `applyOps(root, ops)` (no registry).
 *  Tests and demos that use the legacy alias still expect the two-arg
 *  form to work. This wrapper provides it. */
export function applyOpsLegacy(root: unknown, ops: readonly Op[]): unknown {
  return applyOps(root, ops, createObjectRegistry());
}

/** Same backward-compat shim for single-op application. */
export function applyOpLegacy(root: unknown, op: Op): unknown {
  return applyOp(root, op, createObjectRegistry());
}
