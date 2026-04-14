# remjs architecture (v0.3)

This document is for people who want to understand or modify the
library's internals. For usage see [`USAGE.md`](./USAGE.md). For the
wire format see [`WIRE_FORMAT.md`](./WIRE_FORMAT.md).

## Thesis

Replicate a running JS program by replicating **what enters its event
loop**, not the state those inputs produce. The event loop is the
program's input surface; its run-to-completion semantics make each
task a natural atomic unit — the "op."

Same code + same ops in the same order → identical execution on every
replica. This is a replicated state machine in the classical sense,
where the "commands" are DOM events, timer fires, network responses,
and reads of non-deterministic values (`Math.random`, `Date.now`).

## Why not heap state (v0.1/v0.2)

The earlier protocol captured heap state via `Proxy` traps. It worked
for vanilla JS but broke for framework apps: React's reconciler, Vue's
reactive system, and similar runtimes manage state in internal loops
that don't route through the JS property-set machinery a Proxy can
observe. Proxies also can't cross into closures, module-scoped
bindings, or framework-private caches.

The event loop, by contrast, is architecturally external to all of
these. Anything the app does starts with an input crossing the event
loop boundary. Capture that boundary once, and framework-agnosticism
is free.

## Module layout

```
src/
  index.ts        // public exports
  ops.ts          // Op union + shape of each op type
  codec.ts        // jsonCodec — thin JSON wrapper, swappable later
  target.ts       // target-element → CSS-selector path helpers
  recorder.ts     // createRecorder, batching, subsystem orchestration
  player.ts       // createPlayer, temporal/instant replay, global patches
  patches/
    events.ts     // addEventListener + IDL on-handler shim
    timers.ts     // setTimeout/setInterval/rAF/idle
    network.ts    // fetch
    random.ts     // Math.random + crypto.getRandomValues
    clock.ts      // Date.now + performance.now + Date constructor
    storage.ts    // localStorage / sessionStorage
```

Each patch module exports an `install(emit)` function that monkey-
patches its subsystem, forwards intercepted inputs as ops via the
supplied `emit`, and returns an `uninstall` closure. The recorder
composes them; the player patches the symmetrical consumption side.

## Recorder pipeline

```
event loop input
        │
        ▼
  subsystem patch
  (e.g. events.ts)
        │
        │  emit(op)
        ▼
  recorder.ts
  ├─ stamps op.ts from a pre-patch performance.now
  ├─ pushes to pending[]
  └─ schedules flush per batchMode
        │
        ▼
  onOps(batch)     ← user code ships batch over transport
```

Key invariants:

- **Pre-patch time**: the recorder captures a reference to
  `performance.now` / `Date.now` **before** installing any patches, so
  the act of stamping `op.ts` doesn't recurse through the clock patch
  (which would itself emit an op).
- **Uninstall order**: patches install in a fixed order; uninstallers
  run in whatever order they were pushed, which is fine since none of
  them cross-depends.

## Player pipeline

```
batch from transport
        │
        ▼
   player.apply(batch, { mode? })
        │
        ├── mode === "instant"
        │     └─ applyOp for each op synchronously
        │
        └── mode === "temporal"
              ├─ find minTs in batch
              ├─ for each op: delay = op.ts - minTs
              ├─ if delay ≤ 0: applyOp immediately
              └─ else: setTimeout(applyOp, delay)
```

`applyOp` dispatches on `op.type`:

| Op type      | Player does …                                                                 |
| ------------ | ----------------------------------------------------------------------------- |
| `event`      | Resolves `targetPath` to an element, builds a synthetic event, dispatches.    |
| `random`     | Pushes values onto a queue consumed by the patched `Math.random`.             |
| `clock`      | Pushes a value onto a queue consumed by the patched `Date.now`.               |
| `network`    | Registers a response in a map keyed by `seq`; patched `fetch` looks up by URL. |
| `storage`    | Calls `setItem` / `removeItem` on the target storage.                          |
| `snapshot`   | Replaces `document.documentElement.innerHTML`.                                 |
| `timer`      | No-op today — the replica's own code schedules native timers.                 |
| `navigation` | No-op today — planned.                                                        |

## Determinism-relevant details

### IDL handler shim

Many apps register handlers via `el.onclick = fn` — a single-slot IDL
property, not `addEventListener`. The recorder's event patch wraps
`addEventListener` only, so these registrations would be invisible.
The IDL shim (added in 0.3.1) redefines `on*` property descriptors on
`HTMLElement`, `Document`, and `Window` prototypes so the setter
routes through `addEventListener`, surfacing the registration to the
recorder's wrapper. The getter/setter preserve the original IDL
semantics (single slot, replacement on reassign).

### Cascade dedup

A user click on a `<label>` fires `click` on the label, then the
browser synthesizes `click` on the child input and `change` on the
input — all trusted, all routing through `addEventListener`. Without
intervention, the recorder would emit all three, and on replay the
follower's browser would cascade from the *first* dispatch, producing
duplicate state changes.

The recorder tracks a `dispatchDepth` counter: incremented around each
handler invocation. Any event observed while `depth > 0` is treated as
cascade-derived and suppressed. On the follower, replaying the outer
event lets the browser cascade naturally.

A per-`Event` `WeakSet` additionally dedupes a single event that hits
multiple listeners (capture / target / bubble phases).

### Activation algorithm

`target.dispatchEvent(new MouseEvent("click"))` fires listeners but
does NOT run the DOM "activation" algorithm — anchors don't navigate,
buttons don't submit, radios/checkboxes don't toggle. The player
detects click ops on anchors, buttons, and activation-typed inputs and
routes through `element.click()`, which does run activation while
still respecting `preventDefault()`.

### Scroll replay

Synthetic scroll events are notifications: dispatching one does not
move the viewport. The player sets `scrollTop` / `scrollLeft` on the
target *before* dispatching so listeners observe the new position.
Since absolute pixels don't translate across viewports of different
sizes, the recorder also captures the scroll position as a fraction of
the scrollable range (`scrollTopPct`, `scrollLeftPct`); the player
prefers the fractional form when present.

## Non-goals

- **Multi-writer / conflict resolution.** remjs replicates a single
  sender's event loop. Multi-leader or OT-style merging is the job of
  a layer above.
- **Reliable transport.** Ordering, duplication detection, and
  reconnect logic live in the transport layer.
- **Cross-origin / cross-runtime determinism.** If two replicas have
  different code, different libraries, or different locale/timezone
  defaults, replay will still drift. remjs assumes the replicas run
  the same application.

## Determinism across the event loop

The JS event loop processes one task to completion, then drains the
microtask queue exhaustively, then may render, then picks the next
task. Microtasks queued during the drain run in the same drain — so
`await` chains of arbitrary length finish before the next task.

**One unit of handler causality** — everything that runs because of a
single trigger — is one task plus its microtask drain. The recorder
must group its emitted ops by this unit, and the player must make
each unit's oracle reads available before the follower's handler
reads them.

### Oracles split by language semantics

- **Sync oracles** (`Math.random`, `Date.now`, `localStorage.getItem`)
  return synchronously and cannot wait. The follower needs their
  values pre-queued before the handler runs.
- **Async oracles** (`fetch`, and future XHR / WebSocket / framework
  sources) return a Promise or invoke a callback later. The follower
  can wait — returning an unresolved Promise that the player resolves
  when the matching leader op arrives.

### How remjs satisfies the invariant

- **Recorder batching is task-granular** (0.4.0+). `setTimeout(flush,
  0)` schedules the flush as a new task, so it runs after the current
  task's microtask checkpoint completes. All ops emitted within one
  unit of handler causality — the trigger, sync-oracle reads during
  the sync handler, sync-oracle reads during microtask-drain
  continuations — land in one wire batch.
- **Player reorders within each batch** (0.3.2+). Oracles applied
  first, triggers second. Sync-oracle queues populate before the
  trigger dispatches.
- **Player's async-oracle protocol** (0.4.0+). `awaitAsyncOracle(kind,
  id)` and `signalAsyncOracle(kind, id, value)` are a small pair of
  primitives in `player.ts`. The follower's `fetch` patch calls
  `awaitAsyncOracle` and returns the resulting Promise;
  `applyNetwork` calls `signalAsyncOracle` when the matching op lands.
  New async oracle types (XHR, WebSocket, framework-specific) plug
  into the same primitives — they just need an identifier scheme and
  a value-builder for their op type.

### What this doesn't cover

- **Multiple concurrent fetches to the same URL.** The current
  `(method, url)` key treats them as FIFO; if the leader's two calls
  returned distinct responses, the follower pairs them in order.
  Correct as long as both runtimes issue the calls in the same order.
- **Sync-oracle reads on the follower that happen outside any
  replayed handler.** If the follower's code reads `Math.random()`
  without a trigger having fired, the queue may be empty and the
  read falls through to native. Don't do that; keep non-deterministic
  reads inside handlers.

## Strict mode (0.5.x)

Injection-mode replication (0.4.x and earlier) hands recorded inputs
to the follower's native event loop, which keeps firing its own
timers, rAF, and DOM events underneath. That works when the follower
is quiescent between triggers — most framework apps that only re-
render in response to events — but any app with an independent rAF
loop (shuffleboard), live DOM interactivity, or autosave timers can
drift.

**Strict mode** (opt-in via `createPlayer({ strict: true })`) closes
the native channels one subsystem at a time. The follower stops
scheduling native timers, stops dispatching native DOM events to
user handlers, and stops falling through to native oracles. Every
handler invocation on the follower traces back to an op the player
applied.

The thesis remjs has always made — same code + same inputs → same
state — becomes *testable* under strict mode. Non-goals still apply
(GC, layout, paint, iframe lifecycle aren't input channels; we
don't claim to control them), but the enumerable set of input
channels is fully gated.

### Strict timers (0.5.1)

Patch points on the follower: `setTimeout`, `setInterval`,
`clearTimeout`, `clearInterval`, `requestAnimationFrame`,
`cancelAnimationFrame`, `requestIdleCallback`, `cancelIdleCallback`.

Registration model: `setTimeout(cb, delay)` assigns a player-local
monotonic `seq`, stores `{ kind, cb }` under that seq, returns the
seq as handle, does **not** call native. `TimerOp { kind, seq }`
from the leader looks up the callback and invokes it — deleting the
entry for one-shot kinds (`timeout`/`raf`/`idle`), keeping it for
`interval`. `clearTimeout(seq)` deletes the entry so a straggler op
for that seq is a no-op.

The leader's `TimerOp.actualTime` is passed to `rAF` callbacks as
the `DOMHighResTimeStamp` argument — prevents animation time-drift
across replicas.

Seq alignment rests on the follower registering timers in the same
order as the leader. This holds iff both runtimes run the same app
code against the same op prefix; any divergence in state before the
first timer registration breaks alignment and everything downstream.
The larger-scope strict milestones (events, oracles) are what remove
the remaining sources of pre-timer divergence.

### Strict events (0.5.2)

The follower's `EventTarget.prototype.addEventListener` is wrapped:
each registered listener is replaced with a thin wrapper that filters
on `event.isTrusted && !strictDispatching`. `strictDispatching` is a
player-owned flag, set `true` across the whole body of `applyEvent`
— covering both the `dispatchEvent` call and the `element.click()`
activation path. Any synchronous cascade triggered by the player's
dispatch (e.g. `label` click → synthesized `input` click → `change`)
runs inside the same flag window and passes through.

Events outside that window fall into three cases:

- **Native user input on the follower DOM** (`isTrusted=true`,
  flag false) — dropped. The follower cannot produce handler
  invocations from local input; only applied ops can.
- **App-code `dispatchEvent(new Event(...))`** (`isTrusted=false`) —
  passes. These are deterministic side effects of already-applied
  ops; filtering them would diverge from the leader.
- **App-code `element.click()`** (`isTrusted=true`, flag false) —
  dropped. The leader's recorder captured the original click as an
  op; the op replay is the canonical invocation. Letting the
  follower's own `.click()` also fire would double-invoke the
  handler and diverge.

The IDL on-handler shim (0.3.1) is reused on the follower so
`el.onclick = fn` routes through the wrapped `addEventListener` and
inherits the same filter.

**Installation order matters.** Handlers registered before the player
installs are attached through the unwrapped native
`addEventListener`, and the filter cannot reach them. Install the
player before app code runs — typically at boot, before module
imports that register listeners.

### Strict oracles (0.5.3)

Under injection mode (and strict mode before 0.5.3), oracle reads
that didn't have a queued op fell through to native
(`origMath.random()`, real `Date.now()`, native storage). That
provided pragmatic degradation in partial-capture sessions but
opened a divergence channel: any read the recorder didn't cover
returned a value the leader never saw.

0.5.3 closes it. Under strict mode, oracle reads on an empty queue
throw `RemjsStrictEmptyQueueError`. The error carries `oracle`
(`"Math.random"`, `"Date.now"`, `"localStorage.getItem"`,
`"sessionStorage.getItem"`) and `key` (for storage). Non-strict
mode still falls through.

Storage support extends beyond set/remove (0.4.x applied those on
the follower already) to include get: a follower-side patch on
`localStorage.getItem` / `sessionStorage.getItem` reads from a
per-`(kind, key)` FIFO queue populated by `storage` ops with
`action: "get"`. Without this, the follower's reads hit native
storage directly and returned whatever was locally present —
rarely what the leader read.

The thrown-error path is intentionally hostile to silent
divergence. If your app reads an oracle under strict mode and no
one records that subsystem, you want to find out at the offending
call, not later via mystery state drift.

### Pause primitive (0.5.4)

With 0.5.1–0.5.3 landed, the follower's three native channels —
timers, events, oracles — are all gated. Between op applications
nothing runs. That's what makes pause-the-scheduler equivalent to
freeze-the-follower.

The implementation is a buffered queue. When `paused`, `apply(ops)`
pushes `[...ops]` onto `pendingBatches` instead of calling
`applyInternal`. `step()` shifts one batch off and applies it
instantly. `resume()` drains.

**Instant drain** is a plain `for` loop over `pendingBatches`.
Every handler fires; state converges; wall-clock compresses.
Correct for debug, catch-up, and test harnesses.

**Temporal drain** uses a single advancing setTimeout loop — not
N setTimeouts — so large backlogs don't bloat the timer heap. The
loop computes `targetDelta = nextBatchTs - firstBatchTs` and
schedules the next pump at `Math.max(0, targetDelta - elapsed)`.
Per-batch application still goes through `applyInternal({ mode:
"instant" })` because in-batch ordering (oracles-before-triggers,
per-op ts pacing within a batch) is independent of the outer
drain's pacing.

**The `maxQueue` safety knob** caps how much can buffer during an
unbounded pause. Overflow policy is user-chosen:
`"drain"` applies the oldest half instantly and keeps paused;
`"instant"` returns to running and replays everything. Both
converge state; they differ in who controls the wake-up.

**Why pause is strict-only.** A non-strict player's `pause()`
would be a lie: native rAF on the follower would keep firing, a
rAF-driven physics loop would keep advancing, user clicks on the
follower DOM would still produce handler invocations. The feature
name implies a guarantee the non-strict tier can't provide.
Rather than ship two pause semantics (leaky and true) and explain
the difference, the API refuses the leaky one.

### Multi-writer (0.5.5)

Every peer runs both a recorder (for local inputs) and a player
(for remote inputs). `RecorderOptions.peer` stamps an identifier on
every emitted op; consumers use it for echo dedup and consensus.
`jsonCodec.encodeBatchWithMeta({ from, ops })` provides a minimal
transport envelope for consumers who want a batch-level producer
field in addition to the per-op one.

The framework takes no position on consensus, conflict resolution,
or topology. The peer field is transport-level metadata; the
framework never inspects it.

**Strict mode + recorder tension.** Pure followers run a strict
player for provable consistency. Peers that emit (recorder +
player) face a tension: the strict event filter drops trusted
events, but the recorder *needs* to see trusted events (they're the
local user's input). Practical guidance: emitting peers stay in
non-strict player mode; they gain replication via ops but not
provable freeze. A peer that needs pause-for-debug while also
emitting is an unresolved design question — see #22.

### Milestone 6

P2P topology docs: echo-filtering idioms, server-authoritative
vs. mesh patterns, reference consensus pointers. Descriptive, not
prescriptive.

[#22]: https://github.com/rlyshw/remjs/issues/22

## Known limitations

- **Pending timers and network are not reanimated on snapshot.** The
  `SnapshotOp` carries `pendingTimers` and `pendingNetwork` lists, but
  the player currently ignores them — a late-joining follower misses
  any tasks the leader had in flight at snapshot time. Load-bearing
  for the op-stream inspector workstream (rewind #15; pause/step
  #18).

## Future directions

- **More non-determinism sources.** `crypto.randomUUID`, `IntersectionObserver`
  timing, `navigator.onLine` transitions.
- **Op compaction.** Coalesce high-frequency scrolls / pointer moves
  in the recorder batcher (keep last per target).
- **Alternative codecs.** `jsonCodec` is the reference; msgpack or
  protobuf wrappers are straightforward given the plain-JSON op shape.
