/**
 * Value encoding/decoding.
 *
 * `encode` turns an arbitrary JS value into a JSON-safe `EncodedValue`,
 * handling all the built-in types that plain JSON can't express.
 * `decode` is the inverse.
 *
 * v0.2 adds **ref encoding**. When the encoder is given an `EncodeOptions`
 * with a `refOf(obj)` callback, any tracked object encountered during
 * the walk (other than the top-level value itself) is emitted as
 * `{ __remjs: "ref", id }` rather than recursively encoded. The decoder
 * with a matching `resolveRef(id)` callback patches refs back to live
 * objects on the receiver side. This is what makes graph state with
 * shared references and cycles round-trip cleanly.
 *
 * Encoding rules:
 *   - Plain objects and arrays recurse normally.
 *   - Special types (undefined, Date, Map, Set, RegExp, BigInt, NaN,
 *     ±Infinity) are wrapped with the reserved `__remjs` tag key.
 *   - Tracked objects (per `refOf`) are encoded as `{ __remjs: "ref", id }`
 *     when they appear nested inside another value. The top-level value
 *     itself is always encoded by content — that's how a snapshot entry
 *     describes the object the entry is FOR rather than describing a ref
 *     to it.
 *
 * Backward compat: when called without `refOf`, the encoder behaves
 * identically to the v0.1 codec. The four current demos use this path
 * via the `createStateStream` alias.
 */

import { TAG, type EncodedValue } from "./ops.js";
import { RAW } from "./proxy-symbol.js";

export interface EncodeOptions {
  /** Optional callback. If present, returns the registry id of an object
   *  that should be encoded as a ref instead of recursively walked.
   *  Returns null for objects that haven't been assigned an id yet. */
  refOf?: (obj: object) => string | null;
  /** Optional callback. Called for trackable nested objects that don't
   *  yet have an id (`refOf` returned null). Returns a newly-assigned
   *  id, which will be embedded in a `newobj` tag along with the
   *  object's encoded contents. The receiver adopts the id when it
   *  decodes the tag. If absent, new objects are encoded by content
   *  with no id (the v0.1 fallback). */
  assignId?: (obj: object) => string;
}

export interface DecodeOptions {
  /** Optional callback. If present, resolves a ref id back to a live
   *  object on the receiver side. If the id is unknown to the receiver,
   *  the resolver may return null and the caller is responsible for any
   *  second-pass patch. */
  resolveRef?: (id: string) => object | null;
  /** Optional callback. Called when a `newobj` tag is decoded. The
   *  callback should adopt the supplied id for the supplied object so
   *  subsequent `ref` tags resolve correctly. */
  adoptObject?: (id: string, obj: object) => void;
}

function isTagged(v: unknown): v is { [TAG]: string } {
  return typeof v === "object" && v !== null && TAG in (v as object);
}

/** If the value is a remjs proxy, return its raw target; otherwise return as-is. */
function unwrapRaw(v: unknown): unknown {
  if (v !== null && typeof v === "object" && (v as Record<symbol, unknown>)[RAW]) {
    return (v as Record<symbol, unknown>)[RAW];
  }
  return v;
}

type EncodeMode = "value" | "content";

/**
 * Encode a value for transmission. Default "value" mode treats trackable
 * objects as references — a new object becomes a `newobj` tag, an existing
 * tracked one becomes a `ref` tag. Nested values inside any encoded
 * structure are also encoded in value mode, so a deeply-nested new object
 * also gets its own newobj tag.
 *
 * Used by ops (`op.value`, `op.key`) where the value being transmitted
 * may be a new object that needs to be introduced into the receiver's
 * registry.
 */
export function encode(value: unknown, opts: EncodeOptions = {}): EncodedValue {
  return encodeInner(value, opts, "value");
}

/**
 * Encode a tracked object's CONTENTS (its own fields/items), not as a
 * ref to itself. Nested tracked objects inside the contents are still
 * encoded in value mode (so they appear as ref tags in the output).
 *
 * Used by the snapshot builder, where each entry's `encoded` field
 * describes the object the entry is FOR rather than referring to it.
 */
export function encodeContents(value: unknown, opts: EncodeOptions = {}): EncodedValue {
  return encodeInner(value, opts, "content");
}

function encodeInner(value: unknown, opts: EncodeOptions, mode: EncodeMode): EncodedValue {
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

  // Ref / newobj encoding (only in "value" mode — "content" mode skips
  // straight to the structural walk so the top-level object is described
  // by its fields rather than wrapped in a tag).
  if (mode === "value" && t === "object" && v !== null) {
    if (opts.refOf) {
      const id = opts.refOf(v as object);
      if (id !== null) {
        return { [TAG]: "ref", id };
      }
    }
    if (opts.assignId) {
      const id = opts.assignId(v as object);
      const kind: "object" | "array" | "map" | "set" = v instanceof Map
        ? "map"
        : v instanceof Set
          ? "set"
          : Array.isArray(v)
            ? "array"
            : "object";
      return {
        [TAG]: "newobj",
        id,
        kind,
        contents: encodeInner(v, opts, "content"),
      };
    }
  }

  // Structural walk (used for "content" mode and as a fallback when no
  // ref/newobj options are provided). Nested values are encoded in
  // "value" mode so deeply-nested new objects get their own tags.
  if (v instanceof Map) {
    const entries: [EncodedValue, EncodedValue][] = [];
    for (const [k, val] of v as Map<unknown, unknown>) {
      entries.push([encodeInner(k, opts, "value"), encodeInner(val, opts, "value")]);
    }
    return { [TAG]: "map", entries };
  }

  if (v instanceof Set) {
    const values: EncodedValue[] = [];
    for (const val of v as Set<unknown>) values.push(encodeInner(val, opts, "value"));
    return { [TAG]: "set", values };
  }

  if (Array.isArray(v)) {
    return v.map((item) => encodeInner(item, opts, "value"));
  }

  if (t === "object") {
    const out: Record<string, EncodedValue> = {};
    for (const k of Object.keys(v as object)) {
      out[k] = encodeInner((v as Record<string, unknown>)[k], opts, "value");
    }
    return out;
  }

  throw new Error(`remjs: cannot encode value of type ${t}`);
}

export function decode(value: EncodedValue, opts: DecodeOptions = {}): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t !== "object") return value;

  if (Array.isArray(value)) return value.map((item) => decode(item, opts));

  if (isTagged(value)) {
    const tag = (value as { [TAG]: string })[TAG];
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
        return BigInt((value as { v: string }).v);
      case "date":
        return new Date((value as { v: number }).v);
      case "regex":
        return new RegExp(
          (value as { src: string }).src,
          (value as { flags: string }).flags,
        );
      case "map": {
        const m = new Map<unknown, unknown>();
        for (const [k, v] of (value as { entries: [EncodedValue, EncodedValue][] }).entries) {
          m.set(decode(k, opts), decode(v, opts));
        }
        return m;
      }
      case "set": {
        const s = new Set<unknown>();
        for (const v of (value as { values: EncodedValue[] }).values) {
          s.add(decode(v, opts));
        }
        return s;
      }
      case "ref": {
        const id = (value as { id: string }).id;
        if (opts.resolveRef) {
          const resolved = opts.resolveRef(id);
          if (resolved !== null) return resolved;
        }
        // Resolver missing or didn't know this id — return a placeholder
        // marker that the caller can detect and patch in a second pass.
        return makeRefPlaceholder(id);
      }
      case "newobj": {
        // Build the right shaped placeholder, register it with the
        // supplied id, then hydrate it from the contents. Adopt-first
        // means a self-referential newobj (object whose own contents
        // contain a ref back to itself) resolves cleanly during the
        // contents decode below.
        const tagged = value as {
          id: string;
          kind: "object" | "array" | "map" | "set";
          contents: EncodedValue;
        };
        let placeholder: object;
        switch (tagged.kind) {
          case "array":
            placeholder = [];
            break;
          case "map":
            placeholder = new Map<unknown, unknown>();
            break;
          case "set":
            placeholder = new Set<unknown>();
            break;
          default:
            placeholder = {};
        }
        if (opts.adoptObject) opts.adoptObject(tagged.id, placeholder);
        const decoded = decode(tagged.contents, opts);
        // Copy decoded contents into the placeholder so the placeholder
        // is the canonical instance (in case anything already holds a
        // reference to it via the registry).
        if (placeholder instanceof Map && decoded instanceof Map) {
          for (const [k, v] of decoded) placeholder.set(k, v);
        } else if (placeholder instanceof Set && decoded instanceof Set) {
          for (const v of decoded) placeholder.add(v);
        } else if (Array.isArray(placeholder) && Array.isArray(decoded)) {
          for (const item of decoded) placeholder.push(item);
        } else if (
          typeof decoded === "object" &&
          decoded !== null &&
          !Array.isArray(decoded)
        ) {
          for (const k of Object.keys(decoded)) {
            (placeholder as Record<string, unknown>)[k] = (
              decoded as Record<string, unknown>
            )[k];
          }
        }
        return placeholder;
      }
      default:
        throw new Error(`remjs: unknown tag ${tag}`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as object)) {
    out[k] = decode((value as Record<string, EncodedValue>)[k], opts);
  }
  return out;
}

/* ── Ref placeholders ─────────────────────────────────────────────── */

const REF_PLACEHOLDER = Symbol.for("remjs.ref-placeholder");

interface RefPlaceholder {
  [REF_PLACEHOLDER]: true;
  id: string;
}

function makeRefPlaceholder(id: string): RefPlaceholder {
  return { [REF_PLACEHOLDER]: true, id };
}

export function isRefPlaceholder(v: unknown): v is RefPlaceholder {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<symbol, unknown>)[REF_PLACEHOLDER] === true
  );
}

export function getRefPlaceholderId(v: unknown): string {
  return (v as RefPlaceholder).id;
}
