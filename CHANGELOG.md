# Changelog

## 0.3.2 — replay ordering invariant (sync handlers)

A remjs follower ends up in the same state as the leader iff one
invariant holds: every oracle value a handler consumes must be
queued on the follower before the trigger that runs the handler.
Oracle reads are non-deterministic inputs the runtime pulls —
`Math.random`, `Date.now`, `fetch` response bodies, storage gets.
Triggers are what initiate a handler — events, timer fires, navigation.

The recorder emits in observation order (trigger first, then oracles
the handler pulls). Applied in that order, the follower's handler
runs with empty queues and diverges. 0.3.2 enforces the invariant on
the player side for synchronous handlers.

The async case (handler awaits, oracles read in a `.then`
continuation) remains a known limitation — continuation oracles land
in a separate batch from the trigger that resumed them, so in-batch
reorder cannot cover them. Tracked under epic #19.

### Changed

- **Player applies oracles before triggers within each batch.**
  `player.apply()` now splits the incoming batch by class — oracles
  (`random`, `clock`, `network`, `storage`-`get`) apply first,
  triggers (`event`, `timer`, `navigation`, `snapshot`,
  `storage`-`set`/`remove`) apply second. Order among oracles and
  among triggers is preserved. Closes #17.
- **Temporal mode no longer paces oracle ops.** Oracles have no
  user-visible timing; pacing them would cause triggers to fire
  before their queues populate. Triggers still honor their
  original `ts`.

### Docs

- `docs/ARCHITECTURE.md` adds the async-handler known limitation.
- Issue #19 rewritten around the invariant framing (was
  "causal groups").

## 0.3.1 — event patching hardening

Round of recorder/player fixes surfaced by driving real apps through
remjs-proxy (TodoMVC, Hacker News, counter demos). All backwards-compatible.

### Added

- **`ApplyOptions` on `player.apply()`** — pass `{ mode: "instant" | "temporal" }`
  as a second arg to override the player's default mode for a single call.
  Enables late-joiner flow: `player.apply(historyOps, { mode: "instant" })`
  to snap up to current state, then default `apply(liveOps)` for temporal
  pacing. (#4)
- **`scrollTopPct` / `scrollLeftPct` on scroll event detail** — recorder now
  emits scroll position as a fraction of scrollable range in addition to
  absolute pixels. Player prefers the percentage form when present, falling
  back to pixels — so two peers with different viewport sizes land at the
  same logical position (e.g. "50% down"). (#13)

### Fixed

- **IDL on-event handlers (`el.onclick = fn`) are now captured.** The
  recorder shims `on*` property setters on `HTMLElement`, `Document`, and
  `Window` prototypes to route through `addEventListener`, which was the
  only path the recorder previously observed. Fixes silent event loss on
  apps that use the single-slot IDL registration (TodoMVC, counter). (#2)
- **Cascading events no longer double-emit or bounce.** A user click on a
  `<label>` fires synthesized click+change events on the underlying input;
  the recorder was capturing all three and the player was re-triggering
  the browser's cascade on replay, producing visible flicker. Recorder
  now tracks dispatch depth and skips events fired synchronously inside
  another handler; a per-Event WeakSet dedupes multiple listener fires of
  the same Event. (#3)
- **Anchor click navigation now replays.** `dispatchEvent` on a synthetic
  click doesn't run the browser's activation algorithm — links don't
  navigate, buttons don't submit. Player now routes click ops on
  `<a href>`, `<button>`, and activation-typed `<input>` through
  `element.click()`, which does run activation (and still respects
  `preventDefault`). (#12)
- **Scroll events actually scroll.** Synthetic scroll events are
  notifications only and don't move the viewport. Player now sets
  `scrollTop` / `scrollLeft` on the target before dispatching so
  handlers see the new position. (#13)

## 0.3.0 — event loop replication

Complete pivot from heap-state capture (v0.1/v0.2) to event loop input
capture. Same code + same event loop inputs = identical execution. Frees
the framework from depending on what's observable through Proxy traps,
which broke down on React/Vue apps that manage state in internal loops
bypassing JS scope bindings.

This is a **breaking change** — the v0.2 `createObserver` / `applyOps`
API is gone. The new API is `createRecorder` / `createPlayer`, and ops
describe event loop inputs rather than state mutations.

### Added

- **`createRecorder({ onOps, batchMode?, events?, timers?, network?,
  random?, clock?, storage? })`** installs monkey-patches on the event
  loop entry points you opt into and emits ops for everything that
  crosses them. Returns `{ start, stop, snapshot, destroy }`.
- **`createPlayer({ mode?, events?, timers?, network?, random?, clock?,
  storage? })`** patches the follower runtime so that recorded values
  (random, clock, network responses, storage reads) return on demand,
  and replays recorded events via `dispatchEvent`. Modes are `"temporal"`
  (replay at original cadence, default) or `"instant"` (apply
  immediately).
- **New op types**: `event`, `timer`, `network`, `random`, `clock`,
  `storage`, `navigation`, `snapshot`. All plain JSON, no registry, no
  ref addressing.
- **Per-subsystem patches** in `src/patches/`: `events.ts`, `timers.ts`,
  `network.ts`, `random.ts`, `clock.ts`, `storage.ts`. Each is
  independently installable.
- **`jsonCodec`** for encoding/decoding op batches over a transport.

### Removed

- `createObserver`, `createReceiver`, `createStateStream`,
  `createObjectRegistry`, all ref/path target addressing,
  `__remjs: "ref" | "newobj"` tagged values. These belonged to the heap
  state model and don't apply to event loop replication.

### Docs

- `README.md`, `docs/USAGE.md`, `docs/WIRE_FORMAT.md`, and
  `docs/ARCHITECTURE.md` rewritten for the v0.3 event-loop-replication
  model. The v0.2 heap-state docs (`createObserver` / `__remjs` tagged
  values / ref-path addressing) are gone along with that API.

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
