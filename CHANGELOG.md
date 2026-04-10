# Changelog

## 0.2.0 — `createObserver` redesign

The headline change: a new primary primitive, `createObserver`, that
mirrors remdom's `createObserver` API conventions while adapting to JS
state's reality (no canonical root, multiple capture mechanisms expected
over time, graph-shaped state with cycles and shared references). The
v0.1 `createStateStream` API stays as a thin compatibility shim.

This is a **breaking change** at the wire format level. The old v0.1
op shape (`{ type: "set", path: [...], value }`) is no longer emitted —
v0.2 emits ref-addressed ops (`{ type: "set", target: { kind: "ref",
id, prop }, value }`). The receiver's `applyOps` no longer matches the
v0.1 signature either; it now requires a registry parameter.

If you only consumed remjs through `createStateStream` and shipped ops
over a transport (without inspecting their contents), your code keeps
working — the alias takes care of it. If you asserted on op shapes or
called `applyOps` directly, see the migration notes below.

### Added

- **`createObserver({ onOps, batchMode?, registry?, resyncInterval? })`**
  is the new primary primitive. Returns `{ track, snapshot, flush,
  destroy, registry }`. `track(obj)` adds an object to be observed and
  returns a Proxy-wrapped version. Multiple `track()` calls all share
  the same registry, so cross-references between tracked objects
  preserve identity.
- **`createObjectRegistry()`** — the JS analog of remdom's
  `NodeRegistry`. WeakMap + WeakRef Map pair, idempotent
  `assignId(obj)`, externally-supplied `adopt(obj, id)` for receiver-
  side id mirroring, `walkAndAssign(root)` for graph traversal,
  `getIdOf` / `getObjectById` lookups, `entries()` iterator, `clear()`.
- **Ref-based op addressing.** Every op now carries
  `target: { kind: "ref" | "path", ... }`. Refs identify a specific
  object in the registry's id space; paths walk a tree from a snapshot
  root. The receiver dispatches on `target.kind`.
- **`__remjs: "ref"` tagged value** for nested values that point at
  already-tracked objects.
- **`__remjs: "newobj"` tagged value** for nested values that
  introduce a brand-new object into the receiver's id space. The
  encoder assigns the id at the moment of encoding so source and
  receiver agree on it; the decoder creates a placeholder of the
  right kind, adopts the id, and hydrates from the contents.
- **Graph-shaped snapshots**: a snapshot op now carries
  `objects: [{id, encoded}]` plus `rootIds: string[]`. Receivers do a
  two-pass reconstruction (build placeholders by id, then hydrate)
  so shared references and cycles round-trip correctly.
- **`encodeContents(value, opts)`** — encoder helper for
  content-mode encoding (used by the snapshot builder where the
  top-level value should be described by its fields rather than
  wrapped in a tag).
- **`Receiver` interface** now exposes `registry` so the consumer can
  share it with an observer for bidirectional sync (see updated
  examples).
- 31 new tests across registry behavior, observer factory contract,
  ref-based op round-trips, cycles, shared references, and multi-root
  tracking.

### Changed

- **Wire format**: ops now have a `target` discriminated union instead
  of a top-level `path` field. v0.1 ops with bare `path` are normalized
  on the receiver via `normalizeLegacyOp` so v0.1 senders can still
  talk to v0.2 receivers.
- **`applyOps(root, ops)` signature**: now `applyOps(root, ops, registry)`.
  The registry is required for ref-based ops to resolve. Existing
  callers that don't have a registry can pass `createObjectRegistry()`
  to get the v0.1 behavior.
- **`createReceiver()`** now creates and exposes a registry by default.
  No API change — the registry is just newly accessible at
  `receiver.registry`.
- **Snapshot op shape**: v0.1's `{ type: "snapshot", value: ... }` is
  still accepted by the receiver (tree snapshot mode) but the source
  side now emits the graph form (`{ type: "snapshot", objects, rootIds }`).
- **`createStateStream` is now a compatibility shim** that constructs
  a `createObserver` under the hood and tracks the initial state. The
  return shape (`state`, `snapshot`, `flush`, `dispose`) is unchanged.
  Demos that only mutate state and ship ops over a transport are
  unaffected.
- **Examples (`counter`, `todo`, `dashboard`)**: updated to share a
  registry between the receiver and an observer on the client side, so
  bidirectional sync works with the new ref-based addressing.
- **Tests**: 17 v0.1 tests asserting on the old op shape were updated
  to assert on the v0.2 shape (using `objectContaining` /
  `refTarget()` helpers). The behavior they cover is unchanged.

### Removed

- **The `Symbol(remjs.id)` stamp on tracked objects**. v0.2 originally
  prototyped this as a O(1) read optimization but it caused stale
  bookkeeping during receiver-side adoption and added bug surface for
  no measurable benefit. The registry now uses only the WeakMap as
  the source of truth.

### Migration notes

If you only used `createStateStream` and shipped ops over a transport:

```ts
// v0.1 — still works in v0.2
import { createStateStream } from "remjs";
const { state, snapshot } = createStateStream({...}, { onOps });
state.foo = 5;
```

If you called `applyOps` directly:

```ts
// v0.1
applyOps(root, ops);

// v0.2 — pick one
applyOps(root, ops, registry);     // explicit registry, recommended
applyOps(root, ops, createObjectRegistry());  // fresh registry, v0.1-equivalent
```

If you asserted on op shapes in tests:

```ts
// v0.1
expect(ops).toEqual([{ type: "set", path: ["count"], value: 5 }]);

// v0.2
expect(ops[0]).toMatchObject({ type: "set", value: 5 });
expect(ops[0].target).toMatchObject({ kind: "ref", prop: "count" });
```

For new code, prefer `createObserver` directly:

```ts
import { createObserver, createReceiver } from "remjs";

// Source side
const observer = createObserver({ onOps: (ops) => ws.send(ops) });
const state = observer.track({ count: 0, todos: [] });
state.count++;

// Receiver side
const receiver = createReceiver();
ws.onmessage = (ev) => receiver.apply(JSON.parse(ev.data));

// Bidirectional — share the registry
const observer = createObserver({
  onOps: (ops) => ws.send(ops),
  registry: receiver.registry,
});
const state = observer.track(receiver.state);
```

### Why this redesign

The v0.1 MVP was built around explicit single-root tree state, which
turned out to be too narrow for the actual product goal: capture JS
state at a scope wide enough that the receiver, running the same JS
code, naturally produces the same DOM. v0.2 generalizes the protocol
and primitive in remdom's vein while staying honest about the
differences between DOM and JS state — JS has no canonical root, no
single observation mechanism, and no fixed set of node types, so the
remjs `createObserver` differs from remdom's in a few specific ways
documented in `docs/ARCHITECTURE.md`.

v0.2 is a baby step toward broader capture mechanisms — framework
hooks, constructor patches, global proxying, eventually script
transformation via rembrowser. The protocol shape and primitive are
designed so each future capture mechanism can be added without
breaking the wire format.

## 0.1.0 — initial scaffold

Initial release. `createStateStream(obj)` Proxy-based state mirroring,
path-addressed ops, four demos (counter, todo, dashboard, mirror
shuffleboard), 43 tests.
