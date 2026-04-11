# remjs

Streaming JavaScript execution state. Encodes heap mutations as a structured op stream so multiple JS runtimes can share live application state — the running program, not its rendered output.

## What this is for

remjs keeps JS execution state synchronized across independent runtimes. Each runtime executes the same application code. As state mutates on one side, ops stream to the other side and apply to its heap, so both sides continue executing with identical state.

The target scenario is **peers that each run their own copy of an app** — multiplayer games, collaborative editors, real-time dashboards, distributed simulations — where keeping the running programs in sync is the primary concern. Each peer renders its own UI from its own state; rendering is a local concern.

## Relationship to remdom

remjs and remdom solve different problems at different layers of the stack:

```
remjs  → streams JS execution state (running program, shared between peers)
remdom → streams DOM output state  (rendered document, server → thin clients)
```

**remdom** is for "one source of truth renders, many passive viewers observe." The server executes the app and the DOM is the shared artifact. Clients don't run app code.

**remjs** is for "many peers each run the app, keep their state in sync." Every peer executes the code independently, and heap-level mutations propagate so they stay in lockstep. DOM is rendered locally on each side from the same state.

They can be used independently. A system that uses remjs typically does not need remdom: if the application state is consistent across peers and each peer runs the same code, each peer's DOM is implicitly consistent as a side effect of deterministic execution.

## The idea

V8's `v8.serialize()` / `v8.deserialize()` can snapshot structured-cloneable values. But they work as full dumps, not streams. The goal is to stream deltas:

- Intercept property assignments, object creation, Map/Set mutations, Array modifications
- Emit structured ops describing each state change
- Receiving side applies ops to reconstruct identical JS state
- No full heap dump — continuous streaming of deltas as they happen

## Research questions

1. **What's interceptable?** Proxy can wrap objects, but Proxy has overhead and doesn't cover primitives. Prototype patching covers property setters but not plain assignment.
2. **Closures** — can closure state be observed? Not directly. Could be captured via source transformation (rewrite function bodies to emit ops on variable assignment).
3. **Deterministic replay** — instead of serializing state, record all inputs (events, network, timers, random) and replay them. The state reconstruction is a side effect of identical execution.
4. **Scope** — full heap is impractical. Scoped to application state (React state tree, Redux store, specific objects) is tractable.
5. **Performance** — interception overhead per operation needs to be <1μs to be viable for hot paths.

## Possible approaches

### A. Proxy-based object streaming
Wrap target objects in Proxies that emit ops on mutation. Works for objects/arrays/maps. Doesn't work for primitives or closures.

### B. Source transformation
Babel plugin that rewrites JS to emit ops on every assignment. `x = 5` becomes `x = __remjs_set('x', 5)`. Captures everything but requires build step.

### C. Record/replay
Record every input to the JS engine (events, XHR responses, Date.now(), Math.random()) and replay deterministically. Used by Replay.io and rr. Full fidelity but requires instrumented environment.

### D. V8 streaming snapshots
Use V8's heap snapshot API but stream deltas between snapshots. Heavy, requires V8 internals access, but captures everything.

## Practical first step

Start with Proxy-based streaming for explicit state objects:

```typescript
import { createStateStream } from 'remjs';

const state = createStateStream({
  count: 0,
  todos: [],
  user: { name: 'Alice' }
}, {
  onOps: (ops) => ws.send(JSON.stringify(ops))
});

// Mutations are automatically captured and streamed:
state.count++;           // → { type: 'set', path: ['count'], value: 1 }
state.todos.push('hi');  // → { type: 'arrayPush', path: ['todos'], value: 'hi' }
state.user.name = 'Bob'; // → { type: 'set', path: ['user', 'name'], value: 'Bob' }
```

This is tractable now and immediately useful for streaming React/Redux state between peers.

## Current state

Scaffolded. Research phase.

## Related repos

- `../remdom/` — DOM output streaming (production)
- `../remdom-browser/` — browser client for remdom
- `../remdom-ios/` — iOS client for remdom
- `../remdom-platform/` — managed service platform
