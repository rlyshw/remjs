/**
 * Op protocol for remjs.
 *
 * An Op describes a single mutation to a JS state tree. The tx side emits ops
 * as mutations occur; the rx side applies them to reconstruct identical state.
 *
 * Paths are arrays of string keys. Array indices are encoded as their string
 * form ("0", "1", ...) since that matches JS property semantics on arrays.
 */

export type Path = string[];

/** Tag used to mark encoded special values that can't be represented as plain JSON. */
export const TAG = "__remjs";

/**
 * EncodedValue is a JSON-safe representation of any supported JS value.
 *
 * Primitives, plain arrays, and plain objects pass through mostly unchanged.
 * Special types (undefined, Date, Map, Set, RegExp, BigInt, NaN, ±Infinity)
 * are represented as tagged objects with a reserved `__remjs` key.
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
  | { [TAG]: "set"; values: EncodedValue[] };

/** Full snapshot of a value. Used for initial sync or resync. */
export interface SnapshotOp {
  type: "snapshot";
  value: EncodedValue;
}

/** Property assignment at a path. Creates or replaces the value at path. */
export interface SetOp {
  type: "set";
  path: Path;
  value: EncodedValue;
}

/** Property deletion at a path. */
export interface DeleteOp {
  type: "delete";
  path: Path;
}

/** Map.prototype.set on the Map at `path`. */
export interface MapSetOp {
  type: "mapSet";
  path: Path;
  key: EncodedValue;
  value: EncodedValue;
}

/** Map.prototype.delete on the Map at `path`. */
export interface MapDeleteOp {
  type: "mapDelete";
  path: Path;
  key: EncodedValue;
}

/** Map.prototype.clear on the Map at `path`. */
export interface MapClearOp {
  type: "mapClear";
  path: Path;
}

/** Set.prototype.add on the Set at `path`. */
export interface SetAddOp {
  type: "setAdd";
  path: Path;
  value: EncodedValue;
}

/** Set.prototype.delete on the Set at `path`. */
export interface SetDeleteOp {
  type: "setDelete";
  path: Path;
  value: EncodedValue;
}

/** Set.prototype.clear on the Set at `path`. */
export interface SetClearOp {
  type: "setClear";
  path: Path;
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
