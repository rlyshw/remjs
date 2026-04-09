# remjs

Streaming JavaScript state serialization. Wrap a JS state tree in a proxy,
get a stream of structured ops describing every mutation, ship them
anywhere, reconstruct identical state on the other side.

```
remjs  → streams JS execution state (objects, arrays, Maps, Sets)
remdom → streams DOM mutation state (nodes, attributes, text)
```

## Live demo

**→ [remjs shuffleboard](https://rlyshw.github.io/remjs/mirror.html)** —
a single 45 KB self-contained HTML file. No server, no bundler, no
framework. Click-and-drag to fire a puck. The physics + scoring lives
in a proxied source state; every mutation flows as a JSON op batch to
a separate plain object that drives a second canvas. They stay byte-for-byte
identical, verified every tick.

## The idea

V8's `v8.serialize()` / `v8.deserialize()` can snapshot structured-cloneable
values, but they work as full dumps, not streams. remjs streams **deltas**:

- Intercept property assignments, array and Map/Set mutations via `Proxy`
- Emit structured ops describing each state change
- Receiver applies ops to reconstruct identical JS state
- No full heap dump — continuous streaming of deltas as they happen

## Install

```bash
npm install remjs
```

## Usage

```typescript
import { createStateStream, applyOps, decode } from 'remjs';

// Sender side — wrap any plain state object
const { state, snapshot, flush, dispose } = createStateStream(
  { count: 0, todos: [], user: { name: 'Alice' } },
  {
    onOps: (ops) => ws.send(JSON.stringify(ops)),
    batch: 'microtask',
  },
);

// Mutate normally — ops are emitted automatically
state.count++;
state.todos.push('buy milk');
state.user.name = 'Bob';

// Receiver side — start from a snapshot, then apply incoming op batches
let mirror = decode(snapshot().value);
ws.onmessage = (ev) => {
  mirror = applyOps(mirror, JSON.parse(ev.data));
};
```

## What ops look like

```json
{ "type": "set",       "path": ["count"],          "value": 1 }
{ "type": "set",       "path": ["user", "name"],   "value": "Bob" }
{ "type": "delete",    "path": ["todos", "0"] }
{ "type": "mapSet",    "path": ["cache"], "key": "k", "value": 42 }
{ "type": "snapshot",  "value": { ... } }
```

Plus: `mapDelete`, `mapClear`, `setAdd`, `setDelete`, `setClear`.

Special values that plain JSON can't express — `undefined`, `NaN`,
`±Infinity`, `Date`, `RegExp`, `BigInt`, `Map`, `Set` — are tagged with
a reserved `__remjs` key during encoding and restored on decode.

## What's interceptable

| Kind                 | Captured? | How                                     |
| -------------------- | :-------: | ---------------------------------------- |
| Object property set  | ✓         | `Proxy` set trap                         |
| Object property del  | ✓         | `Proxy` deleteProperty trap              |
| Array index set      | ✓         | set trap (push/pop/splice decompose)     |
| Array length changes | ✓         | set trap on `length`                     |
| Map set/delete/clear | ✓         | Wrapped method on the Map proxy          |
| Set add/delete/clear | ✓         | Wrapped method on the Set proxy          |
| Nested mutations     | ✓         | Child proxies wrapped lazily on read     |
| Closures / locals    | ✗         | Not observable without source rewrite    |
| Primitive variables  | ✗         | Not observable                           |

Closure state and plain variable bindings can only be captured via a
build-time source transform, not via `Proxy`. remjs scopes itself to
**application state** (things you keep in plain objects — Redux stores,
Zustand stores, React state trees, arbitrary JS object graphs), which
is usually what you want to mirror anyway.

## Transports

remjs has no built-in transport — `onOps` hands you a batch of ops and
it's your job to move them. Some reasonable choices:

- **WebSocket** — for multi-client sync
- **`postMessage`** — to a Worker or iframe
- **`BroadcastChannel`** — peer-to-peer between tabs, no server
- **WebRTC data channel** — peer-to-peer across machines
- **A local `applyOps` call** — in-page mirroring (see the shuffleboard
  demo — its entire "transport" is a function call)
- **A log file** — for record/replay debugging

## Performance

Headless benchmark (250 rigid-body physics bodies, 4 field updates per
body per frame, full JSON serialize/parse round-trip, node 24):

| Metric         | Value               |
| -------------- | ------------------- |
| Ops/sec        | ~990,000            |
| Frame rate cap | ~989 fps            |
| Wire bytes/sec | ~67 MB/s            |
| Bytes/op       | ~70                 |

The full suite passes in ~0.5s across 43 tests covering codec
round-trips, proxy interception, tx/rx integrity, special types, and
batching modes.

## Examples

Run `npm install && npm run build` first, then:

| Demo        | Command                      | Notes                               |
| ----------- | ---------------------------- | ----------------------------------- |
| Shuffleboard | **open `examples/mirror/index.html`** | Single file. No server. Open it directly. |
| Counter     | `npm run example:counter`    | Bidirectional WebSocket sync        |
| Todo        | `npm run example:todo`       | Multi-writer collaborative list     |
| Dashboard   | `npm run example:dashboard`  | Server-driven live metrics          |

The three WebSocket demos live in `examples/counter/`, `examples/todo/`,
and `examples/dashboard/` — each is a tiny Node HTTP + WebSocket server
plus a static HTML client. The shuffleboard demo is a single self-contained
HTML file; everything runs in one tab.

## Architecture

```
src/ops.ts            Op protocol and EncodedValue type
src/codec.ts          encode / decode for JSON-unsafe values
src/proxy.ts          Deep Proxy wrapping — object, array, Map, Set
src/apply.ts          applyOp / applyOps / createReceiver
src/stream.ts         createStateStream — batching, dispose, flush
src/index.ts          Public API surface
```

- **Proxy wrapping is lazy.** Child objects aren't wrapped until they're
  read. The proxy cache is keyed by target, so identity is preserved
  (`state.a === state.a`) within the reasonable case where each object
  lives at exactly one path.
- **Special types are tagged at encode.** `encode()` replaces Date/Map/Set/
  BigInt/NaN/etc. with `{ __remjs: "type", ... }` objects that survive
  `JSON.stringify`. `decode()` reverses it.
- **Maps and Sets are proxied via method wrapping**, not via the generic
  Proxy trap, because their mutators (`set`, `delete`, `clear`, `add`) go
  through internal slots that generic traps don't see.
- **Batching modes**: `sync` (flush immediately), `microtask` (default,
  coalesce within a tick), `raf` (one flush per animation frame), or a
  number (flush after N ms).
- **The sender is the only place a `Proxy` lives.** The receiver works
  on a plain object, mutated in place by `applyOps`. No proxy overhead
  on the reader side.

## Scope / non-goals

remjs deliberately doesn't do:

- **Transport** — you pick the wire. No sockets, no auth, no framing.
- **Conflict resolution** — ops are applied in order. Concurrent writers
  from multiple sources would need a CRDT or OT layer above remjs.
- **Schema enforcement** — the receiver trusts the op stream.
- **Closures / primitives / local variables** — use a source transform
  if you need those.
- **Heap snapshots** — `snapshot()` serializes the state tree you wrapped,
  not the JS heap.
- **Infinite scale-out** — it's a sync library, not a database. Per-stream
  throughput is ~1M ops/sec in-process; across a WebSocket you're bound
  by your transport.

## Related

- [`remdom`](https://github.com/rlyshw/remdom) — DOM-level streaming
  (production). Together, remdom + remjs can mirror both "what JS did to
  the DOM" and "what JS is" — enough to reconstruct a running web app
  on the receiving end.

## License

MIT
