# remjs usage (v0.3)

A practical guide to recording event loop inputs, shipping them over a
transport, and replaying them on another runtime. For the wire
reference see [`WIRE_FORMAT.md`](./WIRE_FORMAT.md). For internal design
see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

> **Note.** v0.3 replaces the v0.1/v0.2 heap-state API
> (`createObserver`, `createReceiver`, `applyOps`) with an event loop
> replication API (`createRecorder`, `createPlayer`). The old API is
> gone; if you were on v0.2 and need to migrate, read `CHANGELOG.md`.

## Install

```bash
npm install remjs
```

Requires Node 22+ for development; the browser runtime uses only
standard Web APIs.

## Quick start

See the [README](../README.md#quick-start) for the minimal leader /
follower snippet. The rest of this document is the full API and
transport recipes.

## Recorder

```ts
interface RecorderOptions {
  onOps: (ops: Op[]) => void;
  batchMode?: "task" | "raf" | "microtask" | "sync";
  // per-subsystem toggles — each defaults to true
  events?: boolean;
  timers?: boolean;
  network?: boolean;
  random?: boolean;
  clock?: boolean;
  storage?: boolean;
}

interface Recorder {
  start(): void;
  stop(): void;
  snapshot(): SnapshotOp;
  destroy(): void;
}
```

### `start()` / `stop()`

`start()` installs monkey-patches on enabled subsystems and begins
capturing. `stop()` flushes any pending batch, restores originals, and
keeps the recorder reusable (`start()` again after a `stop()` works).
`destroy()` is `stop()` plus clears internal buffers.

### Batch modes

| Mode          | When `onOps` fires                                                     | Use when                                   |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `"task"`      | Next event-loop task (default, via `setTimeout(fn, 0)`)                | Most cases. Required for async-handler determinism — groups a trigger and its microtask-drain continuations into one batch. |
| `"microtask"` | End of the current microtask (lower latency, but splits async handlers) | Low-latency scenarios that only involve sync handlers; tests that need same-tick delivery. |
| `"raf"`       | Next animation frame                                                    | UI-driven apps where per-frame grouping is natural. |
| `"sync"`      | Every emitted op flushes immediately                                    | Tests, debugging.                           |

**Why `"task"` is the default.** An `await` in a handler yields to
the event loop. The continuation after the await runs in a separate
microtask. Under `"microtask"` batching, the flush scheduled by the
first emit wins the race against the continuation — so the
continuation's oracle reads land in a *later* batch. On the follower,
the continuation races ahead of its oracle queue and diverges.
`"task"` batching groups everything in one task, closing the gap.
See [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md#determinism-across-the-event-loop).

### Per-subsystem toggles

You don't have to record everything. If you only want pointer events on
a canvas, pass `{ events: true, timers: false, network: false, random:
false, clock: false, storage: false }`. The framework is scope-agnostic
— each patch is opt-in independently.

### Snapshot

`recorder.snapshot()` returns a `SnapshotOp` containing the current
`document.documentElement.outerHTML` plus metadata. Send it to
late-joining followers as their bootstrap before live ops.

## Player

```ts
interface PlayerOptions {
  mode?: "temporal" | "instant";   // default "temporal"
  events?: boolean;
  timers?: boolean;
  network?: boolean;
  random?: boolean;
  clock?: boolean;
  storage?: boolean;
}

interface ApplyOptions {
  mode?: "temporal" | "instant";   // per-call override
}

interface Player {
  apply(ops: readonly Op[], options?: ApplyOptions): void;
  destroy(): void;
}
```

### Temporal vs instant

- **`temporal`** (default): uses each op's `ts` field to replay at the
  original cadence — a click recorded 2 seconds after the previous op
  fires 2 seconds after the previous op on the follower. Preserves
  timing-dependent behavior (animations, debouncing).
- **`instant`**: applies all ops synchronously. Used for catch-up,
  fast-forward, and tests.

### Per-apply override (0.3.1+)

A single player can do both. Typical late-joiner flow:

```ts
const player = createPlayer();   // default temporal

// Catch up on session history immediately
player.apply(historyOps, { mode: "instant" });

// Take live ops at natural cadence from here
ws.onmessage = (e) => player.apply(jsonCodec.decodeBatch(e.data));
```

### Per-subsystem toggles

Same as the recorder. Useful when you want the follower to execute its
own timers natively but still accept recorded random and clock values
(e.g. `{ timers: false, random: true, clock: true }`).

## Transports

remjs is transport-agnostic. The library calls `onOps` with an op
array; it's up to you how to ship it.

### WebSocket (most common)

```ts
// leader
const recorder = createRecorder({
  onOps: (ops) => ws.send(jsonCodec.encodeBatch(ops)),
});
recorder.start();

// follower
const player = createPlayer();
ws.onmessage = (e) => player.apply(jsonCodec.decodeBatch(e.data));
```

### postMessage / iframe

```ts
// in the leader window
const recorder = createRecorder({
  onOps: (ops) => followerIframe.contentWindow.postMessage(
    { kind: "remjs:ops", ops }, "*"),
});

// in the follower iframe
const player = createPlayer();
window.addEventListener("message", (e) => {
  if (e.data?.kind === "remjs:ops") player.apply(e.data.ops);
});
```

No codec needed here — postMessage structured-clones the array.

### BroadcastChannel (same origin, multi-tab)

```ts
const ch = new BroadcastChannel("remjs");
const recorder = createRecorder({ onOps: (ops) => ch.postMessage(ops) });
const player = createPlayer();
ch.onmessage = (e) => player.apply(e.data);
```

### In-process (tests)

```ts
const player = createPlayer({ mode: "instant" });
const recorder = createRecorder({ onOps: (ops) => player.apply(ops) });
recorder.start();
```

## Late joiners

A peer joining 60 seconds into a session has three options:

1. **Full history replay.** Buffer every op batch from the start and
   ship it on connect. Follower runs `player.apply(allOps, { mode:
   "instant" })` then takes live ops normally. Works but scales linearly
   with session length.

2. **Snapshot + resume.** Leader sends `recorder.snapshot()` followed
   by live ops from that point on. Follower bootstraps from the
   snapshot's `html` and resumes. Much cheaper for long sessions; loses
   any state held in JS heap that isn't reflected in the DOM.

3. **Application-level sync.** Use the leader's own persistence layer
   (database, cache) to bring the follower up to the current moment,
   then begin streaming live ops. remjs doesn't prescribe this; it's a
   system-architecture choice.

## What to do when things drift

Event loop replication is deterministic *if* the two runtimes run the
same code with the same inputs. If you see drift:

- **Unpatched non-determinism.** Did your code reach for
  `performance.timeOrigin`, `crypto.randomUUID()`, or another
  environment source the recorder doesn't hook? Check
  `src/patches/` for the current coverage.
- **Initial state mismatch.** Follower started from a different
  hydrated state than the leader did at t=0. Ship a snapshot on
  connect.
- **Out-of-order delivery.** Transport is expected to preserve op
  ordering; if you're using UDP, QUIC datagrams, or a lossy channel,
  wrap it with a sequence layer.

## Gotchas

### Cascade events

A click on a `<label>` with a child `<input>` fires `click` on label,
then a synthesized `click` on the input, then `change` on the input —
all trusted, all going through `addEventListener`. The recorder's
dispatch-depth guard (0.3.1+) suppresses the derived events so the
replica's browser can cascade them naturally.

### Anchor navigation and form submit

`dispatchEvent(new MouseEvent("click"))` does **not** run the
activation algorithm — anchors don't navigate, buttons don't submit.
The player (0.3.1+) routes clicks on `<a href>`, `<button>`, and
activation-typed `<input>` through `element.click()` instead, which
does run activation and still respects `preventDefault()`.

### Inline HTML event attributes

`<button onclick="doThing()">` is parsed by the browser before any JS
runs and bypasses `addEventListener` entirely. The recorder cannot see
these. If you control the HTML, rewrite to `addEventListener` or use
`el.onclick = ...` (which the IDL shim in 0.3.1+ does catch).

### Reserved globals

The player replaces `Math.random`, `Date.now`, and `globalThis.fetch`
while installed. If your test framework or a sibling library also
patches these, install order matters — install the player last, or
`destroy()` it between tests.

## Minimal end-to-end example

```ts
import { createRecorder, createPlayer } from "remjs";

// Leader writes, follower mirrors — same tab, no transport
const ops: any[][] = [];

const recorder = createRecorder({
  onOps: (batch) => ops.push(batch),
  batchMode: "sync",
});

const player = createPlayer({ mode: "instant" });

recorder.start();
const r = Math.random();     // captured as a random op
const t = Date.now();        // captured as a clock op
recorder.stop();

// Later, on the follower (same page, same code)…
for (const batch of ops) player.apply(batch);
console.log(Math.random() === r);   // true — queued value replayed
console.log(Date.now() === t);      // true
```

For a richer runnable example, see `examples/` in the repo —
each subdirectory isolates one subsystem (events, random, clock,
network, storage).
