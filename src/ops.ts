/**
 * Op protocol for remjs.
 *
 * An Op describes a single mutation to a JS state graph. The source side
 * (a `JsObserver` from `observer.ts`, or a legacy `createStateStream`)
 * emits ops as mutations occur; the receiver applies them to reconstruct
 * identical state.
 *
 * v0.2 introduces ref-based addressing alongside path-based addressing.
 * Each op carries a `target` discriminated union: either a `path` (an
 * array of string keys walked from a single root, the v0.1 model) or a
 * `ref` (a stable object id from an `ObjectRegistry`, allowing graph
 * state with shared references and cycles).
 *
 * The wire format also gains a new tagged value type, `{ __remjs: "ref" }`,
 * which the encoder emits whenever a value is itself a ref-tracked object.
 * The decoder turns it into a placeholder that gets resolved during the
 * second pass of graph snapshot reconstruction.
 *
 * Backward compatibility: ops without a `target` field are accepted by the
 * receiver and rewritten on the fly to `target: { kind: "path", path }`,
 * so v0.1 op streams continue to apply cleanly.
 */

export type Path = string[];

/** Tag used to mark encoded special values that can't be represented as plain JSON. */
export const TAG = "__remjs";

/* ── Targets ──────────────────────────────────────────────────────── */

/** A target identified by a path walked from a single state root. The
 *  v0.1 addressing mode. Used by `createStateStream` (the legacy alias)
 *  and any consumer that operates on a tree-shaped state with no shared
 *  references. */
export interface PathTarget {
  kind: "path";
  /** Property keys walked from the root, e.g. `["user", "name"]`. */
  path: Path;
}

/** A target identified by an object id from a registry. The v0.2
 *  addressing mode. Used by `createObserver().track()` to address
 *  individual objects in a graph regardless of how many paths reach them.
 *
 *  `id` is the registry-assigned object id; `prop` is the property on
 *  that object that the op affects (or omitted for whole-object ops like
 *  `mapClear` / `setClear` where the target itself is the Map/Set). */
export interface RefTarget {
  kind: "ref";
  /** Object id from the source-side registry. */
  id: string;
  /** Property key on the targeted object. Omitted for whole-target ops. */
  prop?: string;
}

export type Target = PathTarget | RefTarget;

/* ── Encoded values ───────────────────────────────────────────────── */

/**
 * EncodedValue is a JSON-safe representation of any supported JS value.
 *
 * Primitives, plain arrays, and plain objects pass through mostly
 * unchanged. Special types (undefined, Date, Map, Set, RegExp, BigInt,
 * NaN, ±Infinity) are tagged with the reserved `__remjs` key. Refs to
 * tracked objects are encoded as `{ __remjs: "ref", id: "..." }` and
 * resolved on the receiver via the receiver's own ObjectRegistry.
 */
export type EncodedValue =
  | null
  | string
  | number
  | boolean
  | EncodedValue[]
  | { [key: string]: EncodedValue }
  | TaggedValue;

export type TaggedValue =
  | { [TAG]: "undef" }
  | { [TAG]: "nan" }
  | { [TAG]: "inf" }
  | { [TAG]: "ninf" }
  | { [TAG]: "date"; v: number }
  | { [TAG]: "regex"; src: string; flags: string }
  | { [TAG]: "bigint"; v: string }
  | { [TAG]: "map"; entries: [EncodedValue, EncodedValue][] }
  | { [TAG]: "set"; values: EncodedValue[] }
  | { [TAG]: "ref"; id: string }
  /** A brand-new tracked object being introduced into the receiver's
   *  registry. The receiver creates the object from `contents`, adopts
   *  the supplied id, and from then on can resolve `ref` tags pointing
   *  to it. Used by op.value when the source assigns a previously
   *  unknown object to a tracked location. */
  | { [TAG]: "newobj"; id: string; kind: "object" | "array" | "map" | "set"; contents: EncodedValue };

/* ── Op shapes ────────────────────────────────────────────────────── */

/**
 * Snapshot — full encoded state.
 *
 * Two flavors:
 *  - **Tree snapshot** (v0.1, used by `createStateStream`): a single
 *    encoded value at the root, no ref ids.
 *  - **Graph snapshot** (v0.2, used by `createObserver`): a flat list of
 *    `{ id, encoded }` entries plus a list of root ids. The encoded
 *    values may contain `{ __remjs: "ref" }` placeholders that the
 *    receiver resolves during a second-pass reconstruction.
 *
 * Both shapes are valid wire format. Receivers detect which flavor by
 * checking for the `objects` field.
 */
export interface SnapshotOp {
  type: "snapshot";
  /** Tree-flavor snapshot value (v0.1). Mutually exclusive with `objects`. */
  value?: EncodedValue;
  /** Graph-flavor snapshot entries (v0.2). Each entry is one tracked object. */
  objects?: { id: string; encoded: EncodedValue }[];
  /** Graph-flavor snapshot root ids — the objects the source explicitly tracked. */
  rootIds?: string[];
}

/** Property assignment at a target. Creates or replaces the value. */
export interface SetOp {
  type: "set";
  target: Target;
  value: EncodedValue;
}

/** Property deletion at a target. */
export interface DeleteOp {
  type: "delete";
  target: Target;
}

/** Map.prototype.set on the Map at `target`. */
export interface MapSetOp {
  type: "mapSet";
  target: Target;
  key: EncodedValue;
  value: EncodedValue;
}

/** Map.prototype.delete on the Map at `target`. */
export interface MapDeleteOp {
  type: "mapDelete";
  target: Target;
  key: EncodedValue;
}

/** Map.prototype.clear on the Map at `target`. */
export interface MapClearOp {
  type: "mapClear";
  target: Target;
}

/** Set.prototype.add on the Set at `target`. */
export interface SetAddOp {
  type: "setAdd";
  target: Target;
  value: EncodedValue;
}

/** Set.prototype.delete on the Set at `target`. */
export interface SetDeleteOp {
  type: "setDelete";
  target: Target;
  value: EncodedValue;
}

/** Set.prototype.clear on the Set at `target`. */
export interface SetClearOp {
  type: "setClear";
  target: Target;
}

export type Op =
  | SnapshotOp
  | SetOp
  | DeleteOp
  | MapSetOp
  | MapDeleteOp
  | MapClearOp
  | SetAddOp
  | SetDeleteOp
  | SetClearOp;

/* ── Legacy v0.1 op shapes (for backward compat in the receiver) ─── */

/**
 * v0.1 ops carried `path: Path` directly on the op instead of inside a
 * `target` discriminated union. The receiver normalizes legacy ops to
 * the v0.2 shape on the fly via `normalizeLegacyOp`. New code should
 * never construct these.
 *
 * @internal
 */
export interface LegacyPathOp {
  type: string;
  path?: Path;
  value?: EncodedValue;
  key?: EncodedValue;
}

/**
 * Normalize a legacy v0.1 op (with top-level `path`) into the v0.2
 * shape (with `target: { kind: "path", path }`). Returns the input
 * unchanged if it already has a `target` field.
 *
 * The receiver runs every incoming op through this so a v0.1 sender
 * can talk to a v0.2 receiver without any sender-side changes.
 */
export function normalizeLegacyOp(op: Op | LegacyPathOp): Op {
  if ("target" in op && op.target) return op as Op;
  if (op.type === "snapshot") return op as Op;
  const legacy = op as LegacyPathOp;
  if (!legacy.path) {
    // No target, no path — only valid for snapshot, which we already returned.
    return op as Op;
  }
  return { ...op, target: { kind: "path", path: legacy.path } } as Op;
}
