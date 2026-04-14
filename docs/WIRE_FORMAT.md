# remjs wire format (v0.3)

The op protocol is plain JSON. Any language with a JSON library can
produce or consume it. This document is the canonical reference for the
v0.3 event-loop-replication protocol.

> **Note.** v0.1/v0.2 used a different protocol based on heap-state
> mutations (ref/path-addressed `set` / `delete` / `mapSet` / `setAdd`
> ops, `__remjs`-tagged values, graph-shaped snapshots). v0.3 replaces
> that wholesale with event-loop input capture. The protocols are not
> wire-compatible. See `CHANGELOG.md` for the 0.3.0 rationale.

## Model

A remjs stream carries the inputs the JavaScript event loop received —
not the state those inputs produced. Each op describes one thing that
crossed into the runtime from the environment:

- a DOM event fired,
- a timer callback ran,
- a network response arrived,
- `Math.random()` or `Date.now()` was read,
- `localStorage` was accessed,
- navigation happened,
- (or) a full page snapshot for a late-joining receiver.

Replay feeds those same inputs into another runtime's event loop. With
the same code, same code path deterministically falls out.

## Op envelope

Every op is a JSON object with a `type` discriminator and an optional
`ts` timestamp:

```ts
interface BaseOp {
  type: "event" | "timer" | "network" | "random" | "clock"
      | "storage" | "navigation" | "snapshot";
  ts?: number;   // wall clock (performance.now preferred) when recorded
}
```

`ts` is what the temporal-replay mode pacings to. Ops without `ts`
replay immediately.

## Stream model

A remjs stream is a sequence of **op batches**. Each batch is an array
of one or more ops. The recorder batches emitted ops between flushes
(default: next event-loop task, so one batch contains one task plus
its microtask drain — see `ARCHITECTURE.md`); the player applies each
batch in array order.

There is no framing at the wire level. Transport (WebSocket,
postMessage, HTTP, in-process callback) is responsible for delivering
each batch as a unit. Typical usage is `JSON.stringify(batch)` on the
sender and `JSON.parse(data)` on the receiver — `jsonCodec` in the
library does exactly that.

A receiver starts from either:

1. A `snapshot` op carrying the full DOM + URL, followed by live ops, or
2. An empty page running the same application code, with live ops
   applied from the moment the recorder started.

## Op types

### `event` — DOM events

```json
{
  "type": "event",
  "ts": 1712345678901.2,
  "eventType": "click",
  "targetPath": "button#submit",
  "timestamp": 42.5,
  "detail": { "clientX": 100, "clientY": 80, "button": 0, "buttons": 1 }
}
```

| Field        | Type                     | Meaning                                                      |
| ------------ | ------------------------ | ------------------------------------------------------------ |
| `eventType`  | string                   | DOM event name (`"click"`, `"keydown"`, `"input"`, …)        |
| `targetPath` | string                   | CSS-selector-ish path to the event target                    |
| `timestamp`  | number                   | `event.timeStamp` at the time of the original dispatch       |
| `detail`     | object                   | Event-type-specific fields (see below)                       |

#### `detail` fields by event family

| Event family                               | Fields captured                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Pointer (`pointer*`)                       | `clientX`, `clientY`, `button`, `buttons`, `pointerId`                          |
| Mouse (`click`, `dblclick`, `mouse*`)      | `clientX`, `clientY`, `button`, `buttons`                                       |
| Keyboard (`key*`)                          | `key`, `code`, `altKey`, `ctrlKey`, `shiftKey`, `metaKey`                       |
| Input (`InputEvent`)                       | `data`, `inputType`                                                             |
| `input` / `change` on form controls        | adds `value` (the target element's new value)                                   |
| `scroll`                                   | `scrollTop`, `scrollLeft`, `scrollTopPct`, `scrollLeftPct` *(pct added in 0.3.1)* |

`scrollTopPct` / `scrollLeftPct` are the scroll position as a fraction
of the scrollable range (`scrollTop / (scrollHeight - clientHeight)`).
The player prefers the pct form when present, falling back to absolute
pixels, so two peers on different viewport sizes land at the same
logical position.

### `timer` — Timer fires

```json
{ "type": "timer", "ts": 1712345678902, "kind": "timeout", "seq": 3, "scheduledDelay": 1000, "actualTime": 1008 }
```

| Field            | Meaning                                              |
| ---------------- | ---------------------------------------------------- |
| `kind`           | `"timeout"`, `"interval"`, `"raf"`, `"idle"`         |
| `seq`            | Per-recorder monotonic id for this timer             |
| `scheduledDelay` | The delay the caller asked for (ms)                  |
| `actualTime`     | Time the callback actually fired                     |

The v0.3 player does **not** currently schedule replica timers from
these ops — it lets the replica's own code call `setTimeout` natively.
Timer ops are recorded for future use (e.g. forcing precise firing
order on replicas that drift).

### `network` — Fetch / XHR responses

```json
{
  "type": "network",
  "ts": 1712345678903,
  "kind": "fetch",
  "seq": 7,
  "url": "https://api.example.com/data",
  "method": "GET",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{\"result\":42}"
}
```

| Field     | Meaning                                             |
| --------- | --------------------------------------------------- |
| `kind`    | `"fetch"`, `"xhr"`, `"websocket"`                   |
| `seq`     | Per-recorder monotonic id                           |
| `url`     | Request URL                                         |
| `method`  | HTTP method (optional)                              |
| `status`  | Response status (optional)                          |
| `headers` | Response headers as a flat object (optional)        |
| `body`    | Response body as a string, or `null` for no body    |

The player replaces `globalThis.fetch` so calls return a Promise that
resolves when the matching `NetworkOp` arrives (via the player's async-
oracle protocol, see `ARCHITECTURE.md`). There is no native fallback in
0.4.0+: a follower-side `fetch` with no matching leader op hangs until
one arrives, or rejects on `destroy()`. Hanging is safer than silently
diverging.

### `random` — Non-determinism: randomness

```json
{ "type": "random", "ts": 1712345678904, "source": "math", "values": [0.7291, 0.1123] }
```

| Field    | Meaning                                            |
| -------- | -------------------------------------------------- |
| `source` | `"math"` (Math.random) or `"crypto"` (getRandomValues) |
| `values` | Array of values to return to the replica in order  |

The player replaces `Math.random` so each call pops the next value from
the queue. When the queue is exhausted, it falls back to the real
`Math.random` — so ops only need to cover the deterministic prefix of
the recorded session.

### `clock` — Non-determinism: time

```json
{ "type": "clock", "ts": 1712345678905, "source": "dateNow", "value": 1712345678905 }
```

| Field    | Meaning                                                            |
| -------- | ------------------------------------------------------------------ |
| `source` | `"dateNow"`, `"performanceNow"`, `"dateConstructor"`               |
| `value`  | Value to return to the replica                                     |

Same queue model as `random`: the player returns queued values, falling
back to the real clock when exhausted.

### `storage` — localStorage / sessionStorage

```json
{ "type": "storage", "ts": 1712345678906, "kind": "local", "action": "set", "key": "theme", "value": "dark" }
```

| Field    | Meaning                                            |
| -------- | -------------------------------------------------- |
| `kind`   | `"local"` or `"session"`                           |
| `action` | `"get"`, `"set"`, `"remove"`                       |
| `key`    | Storage key                                        |
| `value`  | New value (for `"set"`) or read value (for `"get"`); `null` otherwise |

### `navigation` — History API events

```json
{ "type": "navigation", "ts": 1712345678907, "kind": "pushState", "url": "/page/2", "state": { "id": 2 } }
```

| Field   | Meaning                                                       |
| ------- | ------------------------------------------------------------- |
| `kind`  | `"popstate"`, `"hashchange"`, `"pushState"`, `"replaceState"` |
| `url`   | Target URL                                                    |
| `state` | Optional history state payload                                |

### `snapshot` — Full replica bootstrap

```json
{
  "type": "snapshot",
  "ts": 1712345678908,
  "html": "<!doctype html><html>...</html>",
  "url": "https://example.com/app",
  "timestamp": 1712345678908,
  "pendingTimers": [ { "seq": 3, "kind": "timeout", "remainingDelay": 450 } ],
  "pendingNetwork": [ { "seq": 7, "url": "/api/data", "method": "GET" } ]
}
```

Used when a late-joining replica needs to start from the leader's
current state rather than from the beginning of the session. The
replica replaces `document.documentElement.innerHTML` with `html` and
then resumes with live ops. `pendingTimers` and `pendingNetwork`
describe tasks in flight on the leader at snapshot time; the v0.3
player records them but does not yet reanimate them (planned).

## Ordering and determinism

Determinism requires **the same ops in the same order** on every
replica. Within a batch, ops apply in array order. Across batches,
batches apply in the order delivered.

Ops are not individually idempotent — `random` and `clock` ops consume
queue state, `event` ops dispatch side-effecting events. Replaying a
batch twice is not equivalent to replaying it once. Transport must
preserve ordering and avoid duplication.

The recorder applies two invariants to what it emits:

1. **Cascade dedup.** When a user-supplied handler synchronously fires
   another event (label click synthesizing input click → change), the
   derived events are *not* emitted. The replica's browser cascades
   them naturally when the outer event replays.
2. **Listener dedup.** A single `Event` instance that hits multiple
   listeners (capture phase, target, bubble phase) emits at most once.

## Timestamps and temporal replay

Each op carries `ts` — `performance.now()` when available, otherwise
`Date.now()`. The player's `temporal` mode computes the delta from the
first op in a batch to each subsequent op, and schedules each
application that many ms in the future. `instant` mode ignores `ts`
and applies synchronously.

For mixed workloads (catch-up then live), use the per-apply override:

```js
player.apply(historyOps, { mode: "instant" });
player.apply(liveOps);   // defaults to temporal
```

## Validation and trust

The receiver trusts the op stream. There is no schema enforcement, no
integrity hash, no authentication. These belong above the remjs layer
(WebSocket authn, message signing, rate limiting).

## Example session

```json
// leader → follower (full bootstrap)
[
  { "type": "snapshot", "html": "...", "url": "https://app.example/",
    "timestamp": 1712345678000, "pendingTimers": [], "pendingNetwork": [] }
]

// leader → follower (user clicks a button, handler uses Math.random)
[
  { "type": "random", "ts": 1000.1, "source": "math", "values": [0.7291] },
  { "type": "event",  "ts": 1000.2, "eventType": "click",
    "targetPath": "button#roll", "timestamp": 1000, "detail": { "clientX": 80, "clientY": 40, "button": 0, "buttons": 1 } }
]

// leader → follower (fetch returns, callback runs)
[
  { "type": "network", "ts": 1500.0, "kind": "fetch", "seq": 0,
    "url": "/api/roll", "status": 200, "headers": { "content-type": "application/json" },
    "body": "{\"face\":4}" }
]

// leader → follower (user scrolls)
[
  { "type": "event", "ts": 2000.0, "eventType": "scroll",
    "targetPath": "main#content", "timestamp": 2000,
    "detail": { "scrollTop": 600, "scrollLeft": 0, "scrollTopPct": 0.5, "scrollLeftPct": 0 } }
]
```

## Implementing a non-JS sender or receiver

A minimal implementation needs:

1. A JSON codec.
2. For a **sender**: the ability to hook the platform's event loop —
   e.g. a browser extension, a headless runtime, or an instrumented
   build. Emit ops in the shapes above, with a monotonic `ts`.
3. For a **receiver**: the ability to dispatch synthetic events, seed
   queues for `random` / `clock` / `fetch`-like APIs, and set
   `localStorage` / history state. For DOM replicas, bootstrap from
   the `snapshot.html`.

Because ops describe event loop inputs and not runtime-internal state,
any replica that runs the same application code can consume the stream.
