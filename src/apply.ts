/**
 * Receiver-side op application.
 *
 * `applyOp` / `applyOps` take a plain state tree (no proxies) and mutate it
 * in place to match the sender's state. A `snapshot` op replaces the root
 * entirely; all other ops walk to a target by path and mutate.
 */

import { decode } from "./codec.js";
import type { Op, Path } from "./ops.js";

function walkTo(root: unknown, path: Path): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || current === undefined) {
      throw new Error(`remjs: cannot walk path ${path.join(".")} — encountered nullish at ${key}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Apply a single op to `root`.
 *
 * Returns the (possibly new) root. For most op types the root is mutated in
 * place and returned unchanged; for `snapshot` ops a brand-new root is
 * constructed and returned, so callers must always re-bind to the return
 * value.
 */
export function applyOp(root: unknown, op: Op): unknown {
  switch (op.type) {
    case "snapshot":
      return decode(op.value);

    case "set": {
      if (op.path.length === 0) {
        throw new Error("remjs: cannot apply set op with empty path — use snapshot instead");
      }
      const parentPath = op.path.slice(0, -1);
      const key = op.path[op.path.length - 1]!;
      const parent = walkTo(root, parentPath) as Record<string, unknown>;
      parent[key] = decode(op.value);
      return root;
    }

    case "delete": {
      if (op.path.length === 0) {
        throw new Error("remjs: cannot apply delete op with empty path");
      }
      const parentPath = op.path.slice(0, -1);
      const key = op.path[op.path.length - 1]!;
      const parent = walkTo(root, parentPath) as Record<string, unknown>;
      delete parent[key];
      return root;
    }

    case "mapSet": {
      const target = walkTo(root, op.path) as Map<unknown, unknown>;
      target.set(decode(op.key), decode(op.value));
      return root;
    }

    case "mapDelete": {
      const target = walkTo(root, op.path) as Map<unknown, unknown>;
      target.delete(decode(op.key));
      return root;
    }

    case "mapClear": {
      const target = walkTo(root, op.path) as Map<unknown, unknown>;
      target.clear();
      return root;
    }

    case "setAdd": {
      const target = walkTo(root, op.path) as Set<unknown>;
      target.add(decode(op.value));
      return root;
    }

    case "setDelete": {
      const target = walkTo(root, op.path) as Set<unknown>;
      target.delete(decode(op.value));
      return root;
    }

    case "setClear": {
      const target = walkTo(root, op.path) as Set<unknown>;
      target.clear();
      return root;
    }
  }
}

export function applyOps(root: unknown, ops: readonly Op[]): unknown {
  for (const op of ops) root = applyOp(root, op);
  return root;
}

/**
 * A receiver holds the reconstructed state and applies incoming op batches.
 * The `state` getter always returns the current root (which may be replaced
 * by a snapshot op), so consumers should read via `receiver.state` rather
 * than caching a reference.
 */
export interface Receiver<T> {
  readonly state: T;
  apply(ops: readonly Op[]): void;
}

export function createReceiver<T = unknown>(initial?: T): Receiver<T> {
  let root: unknown = initial ?? {};
  return {
    get state() {
      return root as T;
    },
    apply(ops) {
      root = applyOps(root, ops);
    },
  };
}
