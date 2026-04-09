# remjs

Streaming JavaScript state serialization. Encodes JS heap deltas as a structured op stream — the same paradigm as remdom but at the execution level instead of the DOM level.

## Relationship to remdom

```
remjs  → streams JS execution state (objects, closures, bindings)
remdom → streams DOM mutation state (nodes, attributes, text)
```

remdom encodes what JS *did* to the DOM. remjs encodes what JS *is* — the live application state that drives DOM mutations. Together, they can fully reconstruct a running web app on the receiving end.

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

This is tractable now and immediately useful for streaming React/Redux state between clients.

## Current state

Scaffolded. Research phase.

## Related repos

- `../remdom/` — DOM-level streaming (production)
- `../remdom-browser/` — browser client for remdom
- `../remdom-ios/` — iOS client for remdom
- `../remdom-platform/` — managed service platform
