# Changelog

## 0.5.5 — multi-writer support (epic #22, milestone 5)

Fifth slice of the strict-mode epic. Enables mesh P2P and any other
multi-writer topology. The core model: every peer runs both a
recorder (for local inputs) and a player (for remote inputs).
Identity is stamped on ops so consumers can route, dedup echoes,
and layer consensus above.

Closes #21.

### Added

- **`peer?: string` on every op.** Optional producer identifier,
  stamped by the recorder when `createRecorder({ peer })` is set.
  Absent otherwise. The framework never inspects this — it's
  metadata for consumers doing multi-writer routing, echo dedup,
  or consensus.
- **`RecorderOptions.peer`** — one-line opt-in. Every emitted op
  gets the stamp.
- **`BatchMeta` envelope** + **`jsonCodec.encodeBatchWithMeta` /
  `decodeBatchWithMeta`** — reference `{ from, ops }` wrapper for
  multi-writer transports. Consumers who want more (sequence
  numbers, signatures) wrap further; consumers who don't need this
  use plain `encodeBatch`.

### Docs

- `docs/WIRE_FORMAT.md` — `BaseOp` gains `peer?: string`.
- `docs/USAGE.md` — multi-writer / mesh P2P section with a
  BroadcastChannel example, echo-filter pattern, and notes on
  strict mode + recorder coexistence.

### Scope notes

- **Scope registration abandoned.** The original 0.5.5 sketch had a
  `captureScope` API for declaring event regions. Discarded after
  review: scoping app event chains isn't a goal; the recorder
  already captures everything local, and pairing it with a player
  is enough.
- **Echo loops are a foot-gun.** A peer that doesn't filter its own
  `peer` ID on ingress will double-fire handlers. Documented loudly
  in USAGE.md.
- **Trust model.** The `peer` field is unauthenticated — any peer
  can spoof. Authentication lives in the transport envelope, not
  the op field.

## 0.5.4 — pause primitive (epic #22, milestone 4)

Fourth slice of the strict-mode epic. Builds on the strict tier
(0.5.1–0.5.3) to ship a real pause/resume/step API. Because the
strict follower has no native timers, events, or oracle fallback
running underneath, pausing op application is an actual freeze —
not the best-effort freeze a pre-strict player could offer.

Closes #18.

### Added

- **`player.pause(options?)`** — stops draining the apply queue.
  Incoming `apply(ops)` calls buffer the batch instead of executing.
  Requires `createPlayer({ strict: true })`; throws on non-strict
  players (the name would lie about what the primitive does).
- **`player.step()`** — applies exactly one buffered batch while
  paused. Returns `true` if a batch was applied, `false` if the
  queue was empty or the player wasn't paused.
- **`player.resume({ mode, coalesce? }?)`** — drains buffered
  batches. `mode: "instant"` (default) drains synchronously in a
  burst; `mode: "temporal"` paces the drain by `ts` deltas via a
  single advancing timer loop. `coalesce` reserved for a future
  release; accepted but ignored in 0.5.4.
- **`PauseQueueOptions`** — `{ maxQueue, onQueueFull }` on
  `pause()` for unbounded-pause safety. When buffered ops exceed
  `maxQueue`, `onQueueFull: "drain"` (default) eagerly applies the
  oldest half under instant semantics and keeps the player paused;
  `"instant"` flips the player back to running and replays
  everything.
- **`player.paused`** — readonly boolean reporting current state.

### Changed

- **Player's `apply()`** now checks the paused state and either
  buffers or passes through. Internal applyInternal carries the
  unchanged apply-mode logic.
- **`destroy()`** now cancels any in-flight temporal drain timer
  and clears the pending-batch queue.

### Notes

- Rejected: `skip` resume mode. Dropping queued ops guarantees
  state drift for any non-idempotent handler; documented and
  rejected outright.
- No API to pause non-strict players. Pause-the-scheduler without
  the strict tier underneath is best-effort at most and doesn't
  generalize — better to have one tight semantic than two leaky
  ones.

### Docs

- `docs/USAGE.md` — documents the pause API and the instant-vs-
  temporal tradeoff.
- `docs/ARCHITECTURE.md` — gains a "Pause primitive (0.5.4)"
  section covering the buffered-queue model and the single-timer-
  loop drain pattern.

## 0.5.3 — strict oracles (epic #22, milestone 3)

Third slice of the strict-mode epic. Closes the last fall-through
path on the follower: oracle reads (`Math.random`, `Date.now`,
`localStorage.getItem`, `sessionStorage.getItem`) no longer fall
back to native values on empty queue. They throw.

Under injection-mode (0.4.x and default 0.5.x), unmatched reads
dropping to native was a pragmatic choice — not every session
records every oracle, and returning *something* kept demos running.
The cost was silent divergence: the follower read a value the
leader never saw. Strict mode rejects that trade.

### Added

- **`RemjsStrictEmptyQueueError`** — thrown by strict-mode oracle
  reads when no matching op has been queued. Carries `oracle` (e.g.
  `"Math.random"`, `"localStorage.getItem"`) and `key` (present for
  storage). Exported from the package root for `instanceof` checks.
- **Strict storage-get handling.** Under strict mode the follower's
  `localStorage.getItem` / `sessionStorage.getItem` are patched to
  read from a per-`(kind, key)` FIFO queue populated by `storage`
  ops with `action: "get"`. Previously the follower let these reads
  hit native storage directly, which diverged from the leader's
  recorded values. Outside strict mode, behavior unchanged.

### Changed

- **`Math.random` under strict mode** — throws
  `RemjsStrictEmptyQueueError("Math.random")` on empty queue.
  Non-strict mode keeps falling through to native.
- **`Date.now` under strict mode** — throws
  `RemjsStrictEmptyQueueError("Date.now")` on empty queue.
  Non-strict mode keeps falling through to native.

### Docs

- `docs/USAGE.md` — strict-mode milestone list updated.
- `docs/ARCHITECTURE.md` — "Strict oracles (0.5.3)" section covering
  the sync-oracle queue model, storage-get support, and the
  `RemjsStrictEmptyQueueError` contract.

## 0.5.2 — strict events (epic #22, milestone 2)

Second slice of the strict-mode epic. Closes the native-event
channel on the follower: trusted events (real user input, browser-
synthesized cascades not originating from the player) no longer
reach user handlers; only player-driven dispatches and user-code
`dispatchEvent` calls do.

The mechanism is a filter on the wrapped `addEventListener` —
`event.isTrusted && !strictDispatching → drop`. `strictDispatching`
is a flag the player sets around its own dispatch (covering the
synchronous cascade that follows, so the browser's native
`click → input → change` still works on replay). Synthetic events
created by app code via `new Event(...)` carry `isTrusted = false`
and always pass, keeping deterministic app-code side effects
working on the follower.

The IDL on-handler shim (0.3.1) is reused on the follower so
`el.onclick = fn` registrations route through the wrapped
`addEventListener` and get the same filter.

### Added

- **Strict-events installation** in `src/player.ts`. When
  `strict: true` and events are enabled, wraps
  `EventTarget.prototype.addEventListener` / `removeEventListener`
  with a filter and installs the IDL shim.
- **`strictDispatching` flag** — set true across the whole
  `applyEvent` body (including `element.click()` activation path
  and any synchronous cascade). Save/restore pattern handles
  reentrant `apply()`.
- **`installIdlHandlerShim` export** from `src/patches/events.ts`
  so the player can reuse it on the follower.

### Changed

- **`applyEvent` split.** Dispatch body extracted into
  `dispatchEventFromOp` so the strict flag can wrap the whole
  critical section cleanly.

### Notes

- Handlers registered *before* the player installs are not wrapped.
  Install the player before your app's event-listener setup runs.
- `element.click()` from app code (not the player) is dropped by
  the filter — the recorder captured the original click as an op
  on the leader, so the op replay is the canonical invocation.
  Double-firing the handler would diverge.

## 0.5.1 — strict timers (epic #22, milestone 1)

First slice of the **strict mode** epic. The framework's thesis —
same code + same inputs → same state — is only provable if the
follower executes *only* as a function of applied ops. Today the
follower's native event loop continues to fire timers, rAF, and DOM
events underneath the player. Strict mode closes those channels.

0.5.1 closes the timer channel. The follower's `setTimeout`,
`setInterval`, `requestAnimationFrame`, `requestIdleCallback` (and
their cancel variants) are gated: registration records the callback
against a player-local monotonic seq and returns the seq as handle;
no native timer is scheduled. The callback fires only when the
matching leader `TimerOp` arrives via `player.apply()`.

Opt-in under `createPlayer({ strict: true })`. Default behavior
unchanged.

### Added

- **`strict` option on `createPlayer`.** When `true`, strict-mode
  patches activate. Under 0.5.1 only the timer patch is affected;
  events, oracles, and fetch gain strict behavior in subsequent
  milestones.
- **Strict timer patch on the follower.** Gates `setTimeout`,
  `setInterval`, `clearTimeout`, `clearInterval`,
  `requestAnimationFrame`, `cancelAnimationFrame`,
  `requestIdleCallback`, `cancelIdleCallback`. Callbacks fire only
  when a matching `TimerOp` is applied.
- **Recorder-side rAF / rIC coverage.** `src/patches/timers.ts` now
  emits `TimerOp` for `requestAnimationFrame` and
  `requestIdleCallback` fires, not just `setTimeout`/`setInterval`.
  Required for strict follower to have ops to wait on.
- **`applyTimer`.** The player's op dispatcher stops short-circuiting
  on `timer` ops under strict mode; invokes the registered callback.

### Changed

- **`case "timer"` in `applyOp`** — was a no-op; now calls
  `applyTimer(op)` which is a no-op in non-strict mode (preserving
  0.4.x behavior) and an invocation in strict mode.

### Docs

- `docs/ARCHITECTURE.md` gains a **Strict mode** section covering the
  epic framing and the strict-timers mechanism.
- `docs/USAGE.md` documents the `strict` option and the
  subsystem-coupling contract.

## 0.4.0 — async handler determinism

0.3.2 enforced the replay invariant for synchronous handlers. Async
handlers — those that `await` and read oracles in the continuation —
still diverged, because the recorder's microtask-granularity flush
fragmented one handler's ops across multiple wire batches and the
player's `fetch` patch fell through to native when a match wasn't
already queued.

Two changes close the gap, framed against the event loop:

**Recorder: batch at the next event-loop task, not the next microtask.**
Under HTML-spec ordering, a task's microtask checkpoint drains
exhaustively before the next task runs. Flushing via
`setTimeout(flush, 0)` groups a trigger, its sync handler, and all
microtask-drain continuations chained from it into one wire batch.

**Player: async oracles wait on signal.** `fetch` is the first
consumer of a generic async-oracle protocol — `awaitAsyncOracle` /
`signalAsyncOracle` — that any async source (XHR, WebSocket, future
framework-specific task sources) can plug into. The follower's
`fetch` returns a Promise that resolves only when the matching
leader-side `NetworkOp` is applied. Native fallback is gone —
hanging is safer than silent divergence.

Sync oracles (`Math.random`, `Date.now`, `localStorage.getItem`)
keep the queue-and-pop model; task-boundary batching ensures queues
are populated before handlers read.

### Added

- **`BatchMode: "task"`** — flushes at the next event-loop task
  boundary. New default for `createRecorder`.
- **Generic async-oracle protocol** in `src/player.ts`:
  `awaitAsyncOracle(kind, id)` and `signalAsyncOracle(kind, id, value)`.
  Extension point for XHR, WebSocket, and framework-added async
  sources.

### Changed

- **Default `batchMode` is now `"task"`.** `"microtask"` remains
  available as an opt-in for low-latency consumers that don't need
  async correctness.
- **Player `fetch` patch waits for the matching `NetworkOp`** instead
  of falling through to native. Pending fetches are rejected by
  `destroy()`. Closes #19.

### Docs

- `docs/ARCHITECTURE.md`: replaced the async known-limitation entry
  with a "determinism across the event loop" section covering the
  sync/async oracle split and the generic protocol.
- `docs/USAGE.md`: documented the new default and the `"microtask"`
  opt-in.

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
