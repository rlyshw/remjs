# remjs wire format

The op protocol is plain JSON. Any language with a JSON library can produce
or consume it. This document is the canonical reference.

## v0.2 changes

v0.2 introduced **ref-based addressing** alongside the original path-based
addressing, plus **graph-shaped snapshots** that handle cycles and shared
references. This section summarizes the new wire shape; the rest of the
document still describes the v0.1 protocol, which v0.2 receivers continue
to accept and normalize on the fly.

### Ops carry a `target` discriminated union

```ts
type Target =
  | { kind: "path"; path: string[] }              // v0.1, walk a tree from a snapshot root
  | { kind: "ref"; id: string; prop?: string };   // v0.2, look up by id in the receiver's registry
```

```json
{ "type": "set", "target": { "kind": "ref", "id": "abc-123", "prop": "name" }, "value": "Bob" }
{ "type": "delete", "target": { "kind": "ref", "id": "abc-123", "prop": "email" } }
{ "type": "mapSet", "target": { "kind": "ref", "id": "xyz-456" }, "key": "k", "value": 42 }
```

For Map/Set ops where the target IS the Map/Set, `prop` is omitted.

### `__remjs: "ref"` tagged value

When an encoded value points at an already-tracked object, it's emitted as
a ref tag rather than recursively walked. The receiver resolves it through
its own registry.

```json
{ "__remjs": "ref", "id": "abc-123" }
```

### `__remjs: "newobj"` tagged value

When an encoded value introduces a brand-new tracked object, the encoder
assigns it an id at encode time and wraps the contents with the id so the
receiver can adopt the same id. The receiver creates a placeholder of the
right kind, registers it, and hydrates from the contents.

```json
{
  "__remjs": "newobj",
  "id": "def-456",
  "kind": "object",
  "contents": { "name": "Alice", "age": 30 }
}
```

`kind` is one of `"object"`, `"array"`, `"map"`, or `"set"` so the
receiver knows what container shape to allocate before hydrating.

### Graph-shaped snapshots

```json
{
  "type": "snapshot",
  "rootIds": ["root-1"],
  "objects": [
    { "id": "root-1", "encoded": { "user": { "__remjs": "ref", "id": "u-1" }, "tags": { "__remjs": "ref", "id": "t-1" } } },
    { "id": "u-1",    "encoded": { "name": "Alice", "joined": { "__remjs": "date", "v": 1735689600000 } } },
    { "id": "t-1",    "encoded": { "__remjs": "set", "values": ["admin", "active"] } }
  ]
}
```

The receiver does a **two-pass reconstruction**:

1. Walk `objects`, create an empty placeholder for each entry of the right
   kind (object/array/map/set), and adopt the supplied id into the
   receiver's registry.
2. Walk `objects` again, decode each `encoded` field. Refs in the encoded
   form resolve to the placeholders created in pass 1. Hydrate each
   placeholder with the decoded contents.

This is what makes shared references and cycles round-trip — `receiver.a
=== receiver.b` is preserved if `source.a === source.b` because both
sides resolve through the same id.

### Snapshot tree-mode (legacy)

The v0.1 snapshot shape is still accepted by the receiver:

```json
{ "type": "snapshot", "value": <encoded tree> }
```

The receiver checks for `value` first; if absent, it expects `objects` +
`rootIds`. New senders should always emit the graph form.

### Backward compatibility

v0.2 receivers normalize v0.1 ops on the fly:

```json
// v0.1 op (no target field, top-level path)
{ "type": "set", "path": ["count"], "value": 5 }

// Internally rewritten by the receiver to:
{ "type": "set", "target": { "kind": "path", "path": ["count"] }, "value": 5 }
```

So a v0.1 sender talking to a v0.2 receiver works with no changes. The
reverse (v0.2 sender to v0.1 receiver) does NOT work — v0.1 receivers
don't understand `target` or `__remjs: "ref"`.

---

## Stream model

A remjs stream is a sequence of **op batches**. Each batch is an array
of one or more ops, ordered such that applying them in order against an
initial state produces the sender's current state.

There is no explicit framing. The transport (WebSocket, postMessage,
HTTP, file, function call) is responsible for delivering each batch as
a unit. A typical transport serializes each batch with `JSON.stringify`
and parses it on the receiver with `JSON.parse`, but the choice is yours.

A receiver always starts from one of:

1. A **`snapshot`** op that contains the full encoded state, sent at
   connect time or whenever the sender wants to resync.
2. A pre-known initial value, with subsequent ops applied on top.

Once initialized, ops in any order produce the same final state as if
they had been applied directly to the sender — provided the transport
preserves order.

## Path

```
type Path = string[];
```

A path is an array of property keys identifying a location in the state
tree, walked from the root. Paths are always strings — including array
indices, which use the JS-canonical string form ("0", "1", "2", ...).
Empty paths are not legal for `set` or `delete`; use `snapshot` to
replace the root.

```json
[]                              // root (snapshot only)
["count"]                       // root.count
["user", "name"]                // root.user.name
["todos", "0", "text"]          // root.todos[0].text
["matrix", "3", "7"]            // root.matrix[3][7]
```

Numeric indices are stored as strings because that matches what the JS
proxy `set` trap actually receives — `arr[5] = x` fires the trap with
`prop === "5"`. Receivers don't need to convert; assigning to a string
key on a JS array works identically (`arr["5"] = x` and `arr[5] = x`
are the same operation).

## Op types

There are nine op types. They fall into three groups: snapshot,
object/array mutations, and Map/Set mutations.

### `snapshot`

```json
{ "type": "snapshot", "value": <EncodedValue> }
```

Replaces the root state with `decode(value)`. Used for initial sync
when a new client connects, and for resyncing after the sender suspects
drift. A snapshot is the only op that can take effect on an empty
receiver.

### `set`

```json
{ "type": "set", "path": [...], "value": <EncodedValue> }
```

Assigns `decode(value)` to the location identified by `path`. Creates
the property if it didn't exist. The parent at `path.slice(0, -1)`
must already exist on the receiver — sets are not auto-vivifying.

```json
{ "type": "set", "path": ["count"],            "value": 5 }
{ "type": "set", "path": ["user", "name"],     "value": "Bob" }
{ "type": "set", "path": ["todos", "0"],       "value": { "text": "buy milk" } }
{ "type": "set", "path": ["todos", "length"],  "value": 3 }
```

The last form is how array length changes — JS arrays expose `length`
as a settable property and the receiver applies it the same way.

### `delete`

```json
{ "type": "delete", "path": [...] }
```

Deletes the property at `path`. On a JS object this becomes
`delete parent[key]`. On an array, deletes leave a hole; the
following `length` set typically tightens it.

```json
{ "type": "delete", "path": ["user", "email"] }
{ "type": "delete", "path": ["todos", "2"] }
```

### `mapSet`

```json
{ "type": "mapSet", "path": [...], "key": <EncodedValue>, "value": <EncodedValue> }
```

Calls `Map.prototype.set(decode(key), decode(value))` on the Map at
`path`. Both key and value are encoded so any supported type — including
objects, arrays, Dates, BigInts — can be used as Map keys.

```json
{ "type": "mapSet", "path": ["cache"], "key": "k1", "value": 42 }
{ "type": "mapSet", "path": ["userByEmail"], "key": "alice@example.com", "value": { "name": "Alice" } }
```

### `mapDelete`

```json
{ "type": "mapDelete", "path": [...], "key": <EncodedValue> }
```

Calls `Map.prototype.delete(decode(key))`.

### `mapClear`

```json
{ "type": "mapClear", "path": [...] }
```

Calls `Map.prototype.clear()`.

### `setAdd`

```json
{ "type": "setAdd", "path": [...], "value": <EncodedValue> }
```

Calls `Set.prototype.add(decode(value))`. The sender suppresses the op
when the value is already present in the Set, so receivers can apply
blindly without checking for duplicates.

### `setDelete`

```json
{ "type": "setDelete", "path": [...], "value": <EncodedValue> }
```

Calls `Set.prototype.delete(decode(value))`. Suppressed by the sender
when the value isn't actually present.

### `setClear`

```json
{ "type": "setClear", "path": [...] }
```

Calls `Set.prototype.clear()`.

## EncodedValue

`EncodedValue` is a JSON-safe representation of any supported JS value.
Primitives and plain composites pass through unchanged. Values JSON
can't natively express are wrapped in a tagged object using a reserved
key.

```typescript
const TAG = "__remjs";

type EncodedValue =
  | null
  | string
  | number
  | boolean
  | EncodedValue[]
  | { [key: string]: EncodedValue }
  | TaggedValue;

type TaggedValue =
  | { [TAG]: "undef" }
  | { [TAG]: "nan" }
  | { [TAG]: "inf" }
  | { [TAG]: "ninf" }
  | { [TAG]: "date";   v: number }                           // milliseconds since epoch
  | { [TAG]: "regex";  src: string; flags: string }
  | { [TAG]: "bigint"; v: string }                           // decimal string
  | { [TAG]: "map";    entries: [EncodedValue, EncodedValue][] }
  | { [TAG]: "set";    values: EncodedValue[] };
```

### Encoding rules

| JS value                   | Encoded                                              |
| -------------------------- | ---------------------------------------------------- |
| `null`                     | `null`                                               |
| `string`                   | the same string                                      |
| `boolean`                  | `true` / `false`                                     |
| finite `number`            | the same number                                      |
| `undefined`                | `{ "__remjs": "undef" }`                             |
| `NaN`                      | `{ "__remjs": "nan" }`                               |
| `Infinity`                 | `{ "__remjs": "inf" }`                               |
| `-Infinity`                | `{ "__remjs": "ninf" }`                              |
| `BigInt`                   | `{ "__remjs": "bigint", "v": "12345" }`              |
| `Date`                     | `{ "__remjs": "date", "v": 1735689600000 }`          |
| `RegExp`                   | `{ "__remjs": "regex", "src": "abc", "flags": "gi" }`|
| `Map`                      | `{ "__remjs": "map", "entries": [[k, v], ...] }`     |
| `Set`                      | `{ "__remjs": "set", "values": [...] }`              |
| `Array`                    | `[...]` recursively encoded                          |
| plain `Object`             | `{...}` recursively encoded                          |

### Reserved key conflict

`__remjs` is reserved. A plain object with a literal `__remjs` key in
the source state will be misinterpreted as a tagged value on decode.
Avoid this key in your state. (A future codec version may add escape
handling, but for the current version it's a documented limitation.)

### Unsupported types

The following JS values are **not** supported and will throw on encode:

- `Function` (use a source transform if you need to ship code)
- `Symbol` (not structured-cloneable in any case)
- `WeakMap`, `WeakSet` (not iterable)
- `Promise`, `Proxy` (proxies are unwrapped, but only remjs proxies)
- Class instances with private fields, getters, or methods that need
  to round-trip — they encode as plain objects and lose their prototype

For class instances you control, write a `toJSON()` method or store
them as plain data + reconstruct on the receiver.

### Circular references

Circular references are **not** supported in the initial version.
`encode` will recurse infinitely. If your state has cycles, either:

- Replace cycles with IDs and rebuild references on the receiver, or
- Wait for a future codec version that handles them via reference IDs

## Ordering and idempotence

Within a batch, ops apply in array order. Across batches, batches apply
in the order they're delivered.

Ops are **not** all idempotent on their own:

- `set` and `delete` are idempotent (replaying gives the same result).
- `mapSet` and `setAdd` are idempotent.
- `mapDelete` and `setDelete` are idempotent.
- `mapClear` and `setClear` are idempotent.
- `snapshot` is idempotent — it always replaces the root.

But **the stream as a whole is order-sensitive**. A `set` followed by a
later `set` to the same path leaves the second value; replaying out of
order leaves the first. The transport must preserve order within a
single sender.

For multiple concurrent senders, you need a CRDT or OT layer above
remjs. The library does not handle conflicts.

## Validation and trust

The receiver trusts the op stream. There is no schema enforcement; if a
sender ships `{ "type": "set", "path": ["foo", "bar"], "value": ... }`
and the receiver has no `foo` field, `applyOps` will throw with a path
walk error. There is no integrity hash, no message authentication, no
permission check. Authentication and access control belong above the
remjs layer (e.g. in your WebSocket server).

## Example session

A complete session from a server to a single connecting client:

```json
// server → client (initial)
[
  {
    "type": "snapshot",
    "value": {
      "count": 0,
      "todos": [],
      "user": { "name": "Alice", "joined": { "__remjs": "date", "v": 1735689600000 } }
    }
  }
]

// server → client (user changes name)
[
  { "type": "set", "path": ["user", "name"], "value": "Bob" }
]

// server → client (two todos added in the same tick — coalesced into one batch)
[
  { "type": "set", "path": ["todos", "0"],      "value": { "text": "buy milk", "done": false } },
  { "type": "set", "path": ["todos", "length"], "value": 1 },
  { "type": "set", "path": ["todos", "1"],      "value": { "text": "walk dog", "done": false } },
  { "type": "set", "path": ["todos", "length"], "value": 2 }
]

// server → client (mark first todo done)
[
  { "type": "set", "path": ["todos", "0", "done"], "value": true }
]

// server → client (delete first todo via splice — three ops in one batch)
[
  { "type": "set",    "path": ["todos", "0"],      "value": { "text": "walk dog", "done": false } },
  { "type": "delete", "path": ["todos", "1"] },
  { "type": "set",    "path": ["todos", "length"], "value": 1 }
]
```

## Implementing a non-JS receiver

A minimal receiver in any language needs:

1. A JSON parser.
2. A representation of the state tree (a dict / map / dynamic object).
3. A function `walkTo(root, path)` that follows a path through nested
   dicts/lists and returns the parent + last key.
4. A `decode(EncodedValue)` that handles the tagged types your language
   supports. Unsupported tags should be either preserved as-is, dropped,
   or raised — pick a policy.
5. An `applyOp` dispatch on `op.type` that mutates the local state per
   the op type table above.

For Maps and Sets, you'll need a target language that has equivalent
ordered hash-keyed and ordered unique-value collection types — Python's
`dict` and `set` work; in older languages you may need to fall back to
plain dicts/lists with the understanding that some semantics (insertion
order, complex key support) may differ.
