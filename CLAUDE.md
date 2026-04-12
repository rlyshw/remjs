# remjs

Event loop replication for JavaScript. Captures event loop inputs as structured ops so multiple JS runtimes produce identical execution — the running program, not its rendered output.

## What this is

remjs serializes a JavaScript program's execution by intercepting everything that enters the event loop: DOM events, timer fires, network responses, `Math.random()`, `Date.now()`. These inputs are encoded as structured ops and streamed to other runtimes. Replaying the same ops produces identical execution — same state, same side effects, same output.

The formal model is a **replicated state machine**: same code + same inputs + same ordering = identical execution on every replica. The JS event loop's run-to-completion semantics make each task an atomic unit — the natural "op."

## What this is for

The target scenario is **peers that each run their own copy of an app** — multiplayer games, collaborative editors, real-time dashboards, distributed simulations. Each peer runs the full application code independently. remjs ensures they all receive the same event loop inputs, so they all produce the same state as a side effect of deterministic execution.

remjs is a **protocol and codec**, not an architecture. It defines op shapes, how to encode/decode, how to record and replay. Topology (leader/follower, peer-to-peer), conflict resolution, and transport are implementation concerns — the framework doesn't prescribe them.

## Relationship to remdom

remjs and remdom reify different surfaces of the same runtime:

```
remdom → reifies the OUTPUT surface (DOM mutations)
remjs  → reifies the INPUT surface  (event loop tasks)
```

**remdom** captures what comes OUT of the JS runtime — DOM mutations streamed to passive viewers who don't run app code.

**remjs** captures what goes IN to the JS runtime — event loop inputs replayed on peers who each run the same app code.

Together they form a complete round-trip: remjs replicates the program, remdom replicates its output. They can be used independently. A system using remjs typically doesn't need remdom — if every peer processes the same inputs, their DOMs are implicitly identical.

## Architecture

```
                    Recorder                              Player
              ┌─────────────────┐                  ┌─────────────────┐
  browser     │ monkey-patches: │                  │ replays:        │
  event loop  │  addEventListener│                  │  dispatchEvent  │
  inputs ───► │  setTimeout     │ ── ops[] ──────► │  seed random    │
              │  fetch          │    (transport)   │  align clock    │
              │  Math.random    │                  │  inject response│
              │  Date.now       │                  │  fire callback  │
              └─────────────────┘                  └─────────────────┘
```

The recorder installs monkey-patches on event loop entry points. When an input arrives (click, timer fire, fetch response, random value), it emits a structured op. The player receives ops and feeds them into the replica's event loop — dispatching events, seeding random values, aligning clocks.

No Proxy wrapping. No heap inspection. No framework hooks. Pure runtime patching of the environment API surface.

## Op types

| Type | What it captures |
|------|-----------------|
| `event` | DOM events — click, keydown, input, scroll, pointer* |
| `timer` | setTimeout / setInterval / rAF callback fires |
| `network` | fetch / XHR responses — status, headers, body |
| `random` | Math.random() / crypto.getRandomValues() values |
| `clock` | Date.now() / performance.now() timestamps |
| `storage` | localStorage / sessionStorage reads and writes |
| `navigation` | pushState / popstate / hashchange |
| `snapshot` | Full page state for late-joining replicas |

All ops are plain JSON. No tagged values, no special encoding.

## Core API

```typescript
// Record event loop inputs
const recorder = createRecorder({
  onOps: (ops) => transport.send(ops),
});
recorder.start();

// Replay on another runtime
const player = createPlayer();
transport.onMessage = (ops) => player.apply(ops);
```

## Key design decisions

- **Transport-agnostic**: the library emits ops and accepts ops. WebSocket, postMessage, BroadcastChannel, function call — your choice.
- **Scope-agnostic**: the framework doesn't mandate global monkey-patching. You can intercept all event loop inputs or just specific ones (e.g. only pointer events on one canvas). The recorder accepts flags for each subsystem.
- **Framework-agnostic**: no React hooks, no Vue plugins, no Babel transforms. Works with any JS code because it operates at the environment API level, below all frameworks.
- **Op format is plain JSON**: no registry, no object IDs, no ref-based addressing. Ops describe inputs, not heap state.

## Evolution

- **v0.1–v0.2**: Proxy-based heap state capture. Worked for vanilla JS but broke for framework apps (React, Vue) that manage state in internal loops bypassing JS scope bindings. Proved that heap state is insufficient — a running program is an open system with side effects, pending tasks, and environmental interactions that can't be cloned by copying values.
- **v0.3**: Event loop replication. Captures inputs instead of state. Same code + same inputs = identical execution. Framework-agnostic by design.

## Related repos

- `../remdom/` — DOM output streaming
- `../remdom-browser/` — browser client for remdom
- `../remdom-ios/` — iOS client for remdom
- `../remdom-platform/` — managed service platform
- `../remjs-proxy/` — Babel transform proxy server (private, uses remjs as dependency)
