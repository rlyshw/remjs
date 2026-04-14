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

## Known limitations

- **Async handler continuations aren't covered by the replay invariant.**
  When a handler `await`s and reads oracles in the continuation — e.g.
  `await fetch(...); const r = Math.random()` — the continuation's
  oracle reads land in a different recorder batch from the trigger
  that resumed them. The player's in-batch reorder (0.3.2) can't move
  ops across batches, so the follower's continuation races ahead of
  its oracle queue and diverges. Tracked under epic #19 with the
  design discussion of cross-batch ordering mechanisms.

- **Pending timers and network are not reanimated on snapshot.** The
  `SnapshotOp` carries `pendingTimers` and `pendingNetwork` lists, but
  the player currently ignores them — a late-joining follower misses
  any tasks the leader had in flight at snapshot time. This is
  load-bearing for the op-stream inspector workstream (#19) and the
  rewind feature (#15).

## Future directions

- **More non-determinism sources.** `crypto.randomUUID`, `IntersectionObserver`
  timing, `navigator.onLine` transitions.
- **Op compaction.** Coalesce high-frequency scrolls / pointer moves
  in the recorder batcher (keep last per target).
- **Alternative codecs.** `jsonCodec` is the reference; msgpack or
  protobuf wrappers are straightforward given the plain-JSON op shape.
