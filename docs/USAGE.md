# remjs usage

A practical guide to wrapping state, shipping ops, and rebuilding state
on the receiver. For the wire-level reference see
[`WIRE_FORMAT.md`](./WIRE_FORMAT.md). For internal design see
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Install

```bash
npm install remjs
```

remjs has zero runtime dependencies. The published library is plain
ES modules with TypeScript declarations.

```typescript
import {
  createStateStream,
  applyOp,
  applyOps,
  createReceiver,
  encode,
  decode,
} from "remjs";
```

## The two halves

remjs has exactly two roles. **One side** holds the source-of-truth
state and emits ops as it mutates. **The other side** holds a mirror
that gets reconstructed by applying those ops. The library doesn't
know or care how ops travel between them — that's the transport, and
you write it.

```
┌────────────────────┐                    ┌─────────────────────┐
│  source            │   op batches       │  receiver           │
│                    │  ─────────────►    │                     │
│  createStateStream │   (your transport) │  applyOps           │
│  proxy → state     │                    │  plain object       │
└────────────────────┘                    └─────────────────────┘
```

## Source side: `createStateStream`

```typescript
const { state, snapshot, flush, dispose } = createStateStream(initial, {
  onOps: (ops) => {
    /* ship the batch somewhere */
  },
  batch: "microtask",
});
```

`initial` is your starting state — a plain JS object (or array, or
Map, or Set, but typically an object root). The function wraps it in
a deep `Proxy` and returns:

| Returned             | What it is                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `state`              | Proxied root. **Mutate this** to produce ops. Don't mutate `initial`.   |
| `snapshot()`         | Returns a `SnapshotOp` containing the full encoded current state.       |
| `flush()`            | Force an immediate flush of any queued ops.                             |
| `dispose()`          | Stop emitting ops. Mutations still apply but `onOps` is no longer called. |

### Mutate normally

Once wrapped, the `state` proxy behaves like the underlying object.
Read it, write it, pass it around, iterate it. Every mutation that
goes through the proxy is captured.

```typescript
state.count++;
state.user.name = "Bob";
state.todos.push({ text: "buy milk", done: false });
state.todos[0].done = true;
state.todos.splice(0, 1);
delete state.user.email;
state.tags.add("admin");          // if state.tags is a Set
state.cache.set("k1", value);     // if state.cache is a Map
```

Each of these produces one or more ops, batched per the `batch` option
and handed to `onOps` as a single array.

### What does **not** produce ops

These mutate `initial` directly (not through the proxy) and are
invisible to remjs:

```typescript
initial.count++;          // ❌ bypasses the proxy
const raw = initial;
raw.user.name = "Bob";    // ❌ same
```

Always work through `state`, never through `initial` after wrapping.

Closure variables and primitive locals also can't be intercepted —
that needs a build-time source transform, which remjs doesn't provide.

## Batching modes

`onOps` is called with an array of ops. The `batch` option controls
when that array is flushed.

| Mode          | When `onOps` fires                                  | Use when                                        |
| ------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `"sync"`      | Immediately on every single mutation                | Tests, debugging, deterministic stepping        |
| `"microtask"` | At the end of the current microtask (default)       | Most apps. Coalesces a tick of mutations.       |
| `"raf"`       | On the next `requestAnimationFrame`                  | Browser game loops, animation-driven UIs        |
| `number`      | After N milliseconds (`setTimeout`)                  | Throttling slow / chatty senders                |

```typescript
// One op per call
createStateStream(state, { onOps, batch: "sync" });

// Default — coalesce same-tick mutations
createStateStream(state, { onOps, batch: "microtask" });

// One batch per frame
createStateStream(state, { onOps, batch: "raf" });

// One batch per 100ms
createStateStream(state, { onOps, batch: 100 });
```

`flush()` always drains immediately, regardless of mode. Useful when
the page is about to unload, when you want to align stats to frame
boundaries, or when sending an explicit "checkpoint" through the wire.

### Why batching matters

A single user action can trigger many proxy traps. Calling
`state.todos.push({ id, text, done: false })` produces three set ops
(`set [0] = obj`, `set length = 1`) and one nested `set [0]` for the
new object. Without batching, the receiver would see them one at a
time and re-render between each — wasted work. Microtask batching
collapses all the ops from one tick into a single `onOps` call so
the receiver does one apply pass and one re-render.

## Snapshots

```typescript
const snap = snapshot();
// → { type: "snapshot", value: <full encoded state> }
```

A snapshot is a single op that contains the entire current state,
encoded for the wire. Use it for:

- **Initial sync.** When a new client connects, send a snapshot first
  so the receiver has a starting point. Then stream live ops.
- **Resync after suspected drift.** If you've crashed, lost ops, or
  got disconnected, sending a fresh snapshot replaces whatever the
  receiver has and gets you back in sync.
- **Persistence.** Save the snapshot to disk and reload it later as
  the receiver's initial state.

`snapshot()` is fast — it walks the current state tree and serializes
it. For very large states this is the only "stop the world" call in
the library.

## Receiver side: `applyOps` and `createReceiver`

The receiver works on a plain object — no proxy, no overhead. Two
options:

### Direct: `applyOps`

```typescript
import { applyOps, decode } from "remjs";

let mirror = decode(initialSnapshot.value);
ws.onmessage = (ev) => {
  const ops = JSON.parse(ev.data);
  mirror = applyOps(mirror, ops);
};
```

`applyOps` mutates the root in place for `set`/`delete`/`map*`/`set*`
ops, but returns a brand-new root for `snapshot` ops. **Always
re-bind** to the return value, even if you think you only get
non-snapshot ops — this lets you accept resync snapshots transparently.

### Convenience wrapper: `createReceiver`

```typescript
import { createReceiver } from "remjs";

const receiver = createReceiver();
ws.onmessage = (ev) => {
  receiver.apply(JSON.parse(ev.data));
  render(receiver.state);
};
```

`createReceiver()` returns `{ state, apply }`. `state` is a getter
that always returns the current root (handles snapshot replacements
transparently). `apply` takes a batch of ops and mutates the internal
state in place.

## Special types

remjs supports more types than plain JSON. The codec tags non-JSON-safe
values at encode time and restores them at decode.

```typescript
const { state } = createStateStream(
  {
    createdAt: new Date(),
    counters: new Map([["likes", 0], ["views", 0]]),
    tags: new Set(["admin", "active"]),
    bigNumber: 123n ** 5n,
    pattern: /foo[a-z]+/gi,
    optional: undefined,
    fraction: NaN,
  },
  { onOps },
);
```

All survive a round-trip through `JSON.stringify` and back. The wire
format spec lists every supported type and its encoded shape.

If you need a type remjs doesn't support, encode it manually as a
plain object on the source side and decode it on the receiver.

## Edge cases and gotchas

### Proxy identity is preserved (mostly)

`state.foo === state.foo` returns the same proxy each time, because
remjs caches the wrapper per target object. This matches React's
expectation that reference equality means "same object".

The one caveat: if you move the **same target object** to a different
path in the tree, the cached proxy still tracks mutations under its
**original** path. Example:

```typescript
const obj = { name: "Alice" };
state.user = obj;
state.userBackup = obj;
state.userBackup.name = "Bob";
// → emits set ["user", "name"] = "Bob", NOT set ["userBackup", "name"]
```

In practice this is rare — most apps store each object at exactly one
location in the tree. If you do need cross-references, store IDs
instead of the object itself.

### Array operations decompose

`Array.prototype` methods that mutate go through the underlying
`set`/`delete` traps, so a single `push` produces several ops:

```typescript
state.items.push("hello");
// → set ["items", "0"] = "hello"
//   set ["items", "length"] = 1
```

This is correct but not the most compact. A future version may add
explicit `arrayPush`/`arraySplice` ops to compress the wire.

### Don't keep references to children across mutations

```typescript
const userBefore = state.user;
state.user = { name: "Charlie" };
userBefore.name = "Dave";  // ❌ tracked under the OLD path
```

When you replace a subtree, any proxies you've already grabbed for
the old subtree still emit ops at their original path. The path is
fixed at the time of the first read, not at the time of the mutation.

### Receiver throws on missing parent

`applyOps` walks the path before mutating. If the parent doesn't
exist on the receiver, you get an error:

```
remjs: cannot walk path foo.bar — encountered nullish at bar
```

This usually means: a snapshot was missed, ops are out of order, or
the receiver is somehow ahead of the sender. Resync by sending a fresh
snapshot from the source.

### Symbols are not captured

Symbol-keyed properties bypass the JSON path encoding entirely.
remjs ignores symbol props in both encoding and proxy traps. If you
use symbols for app data (rare), wrap them in string-keyed properties.

## Integration patterns

### React + plain state

```typescript
import { createStateStream, createReceiver } from "remjs";
import { useSyncExternalStore } from "react";

// ── source side ────────────────────────────────────────
const { state, snapshot } = createStateStream(
  { count: 0, todos: [] },
  {
    onOps: (ops) => ws.send(JSON.stringify(ops)),
    batch: "microtask",
  },
);

// Subscribe React components to the proxied state.
const subscribers = new Set<() => void>();
const stateProxy = new Proxy(state, {
  get(t, p) { return Reflect.get(t, p); },
  set(t, p, v) {
    const r = Reflect.set(t, p, v);
    subscribers.forEach((fn) => fn());
    return r;
  },
});

function useRemState() {
  return useSyncExternalStore(
    (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); },
    () => stateProxy,
  );
}

// ── receiver side ─────────────────────────────────────
const receiver = createReceiver({ count: 0, todos: [] });
ws.onmessage = (ev) => {
  receiver.apply(JSON.parse(ev.data));
  // trigger re-render with the latest receiver.state
};
```

For Zustand or Redux: wrap the store's state in `createStateStream`,
let the store mutate via its normal API (which goes through the
proxy), and ship the resulting ops over your transport. The
Zustand/Redux subscriber pattern handles re-renders on the source
side; the receiver just mirrors the state object.

### Bidirectional sync over WebSocket

The full pattern is shown in `examples/_shared/session.js` and
`examples/_shared/client.js`. Key points:

- The server holds the authoritative state, wrapped in
  `createStateStream`.
- New clients receive a snapshot on connect.
- When a client sends ops, the server applies them **directly to
  the raw state** (not through the proxy) to avoid the proxy
  re-emitting them as new ops. Then it broadcasts the same ops to
  all other clients.
- Clients also wrap their local copy with `createStateStream` so
  user-driven mutations turn into ops to send back.
- Clients apply incoming server ops **directly to their raw state**
  (same reason — no echo).

### Peer-to-peer with `BroadcastChannel`

No server at all:

```typescript
const ch = new BroadcastChannel("my-app");
const { state } = createStateStream(
  { count: 0 },
  { onOps: (ops) => ch.postMessage(ops), batch: "microtask" },
);

const mirror = createReceiver({ count: 0 });
ch.onmessage = (ev) => {
  mirror.apply(ev.data);
  render(mirror.state);
};
```

Same pattern as the WebSocket case but the transport is just a channel
between tabs.

### Recording for replay

```typescript
const log: Op[] = [];
const { state, snapshot } = createStateStream(initial, {
  onOps: (ops) => log.push(...ops),
  batch: "microtask",
});

// Save when you want
fs.writeFileSync("session.json", JSON.stringify({
  initial: snapshot(),
  ops: log,
}));

// Replay later
const session = JSON.parse(fs.readFileSync("session.json", "utf8"));
const replayed = createReceiver();
replayed.apply([session.initial]);
replayed.apply(session.ops);
// replayed.state is now identical to where the source was when saved
```

This is the basis for time-travel debugging — record everything, then
step through the op log frame by frame.

## When remjs is the wrong tool

- You need to capture closure variables, locals, or function bytecode.
  Use a Babel/SWC transform.
- You need conflict resolution for multiple concurrent writers across
  unreliable links. Use a CRDT (Yjs, Automerge) or OT framework.
- You need cryptographic guarantees about the op stream. Add signing
  above remjs.
- You need to mirror the JS heap exactly, including hidden classes,
  GC roots, and compiled bytecode. Use `node --inspect` and the V8
  heap snapshot API.
- Your state is a single primitive. Just use a `MessageChannel` for
  one number — you don't need a proxy.

For everything else — Redux stores, React state trees, game state,
form state, in-memory caches, anything you'd put in a plain object —
remjs is exactly the right shape.
