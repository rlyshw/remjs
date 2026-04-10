# remjs architecture

This document is for people who want to understand or modify the
library's internals. For usage see [`USAGE.md`](./USAGE.md). For the
wire format see [`WIRE_FORMAT.md`](./WIRE_FORMAT.md).

## v0.2 redesign — what translated from remdom and what didn't

remjs v0.2 follows remdom's architectural conventions where they apply
to the streaming-mirror problem in general, and deliberately diverges
where remdom's shape is dictated by properties of the DOM specifically.

### What translates 1:1 from remdom

- **Registry pattern.** `NodeRegistry` (DOM nodes ↔ stable string ids,
  WeakMap + Map pair, idempotent assignment) maps directly onto
  `ObjectRegistry` (JS objects ↔ stable string ids).
- **Discriminated-union op envelope.** remdom's `MutationOp` and
  `InputOp` are tagged unions that the receiver dispatches on by
  `op.type`. remjs's `Op` is the same shape.
- **`onOps` callback contract** with `batchMode: "raf" | "microtask" |
  "sync"`. Lifted directly.
- **Snapshot-on-connect contract.** Every observer must implement
  `snapshot()`. New receivers always start by applying a snapshot, then
  live ops. This is the architectural payoff that eliminates a whole
  class of "send X on connect" protocol patches.
- **Lifecycle methods**: `snapshot()`, `destroy()`. Same names, same
  semantics.
- **Transport agnosticism.** The library hands you ops via `onOps`; the
  consumer ships them somewhere. No sockets, no auth, no framing.

### What does NOT translate (because it's DOM-specific)

- **`root: Node` parameter, defaulting to `document.documentElement`.**
  DOM has a single canonical entry point. JS state has none — modules'
  `let`/`const` declarations, closures, framework internals, and
  third-party private state are all unreachable from `globalThis`.
  remjs's `createObserver` therefore has **no `root` parameter**;
  state to observe is added explicitly via `track(obj)`. Future
  capture mechanisms (`observeGlobal()`, `hookFramework("react")`,
  etc.) will live as additional methods on the same observer.
- **Single observation mechanism (`MutationObserver`).** The browser
  hands DOM observation for free. JS has no equivalent — every capture
  mechanism (Proxy, framework hook, constructor patch, global proxy,
  build-time transform) is a separate piece of work. The remjs
  observer is therefore **plural** in its capture mechanisms by
  design, even though v0.2 only ships one (`track`).
- **Anchor-based insertion (`beforeId`).** DOM cares about sibling
  order at every level; JS arrays use indices, not sibling anchors.
  Forcing `beforeId` ops on JS state would be invented complexity.
- **`SerializedNode` with `type: 1|3|8` discriminator.** DOM has a
  small fixed set of node types. JS has Object/Array/Map/Set/Date/
  RegExp/BigInt — wider, and the codec already handles them via the
  `__remjs` tagged-value scheme.
- **`PropertyOp` distinction (.value, .checked, .selectedIndex).**
  DOM exposes some "live" properties that bypass MutationObserver. JS
  doesn't have this distinction.
- **`DomApplier` bound to a single container `HTMLElement`.** The
  remjs receiver is a graph holder, not an element mutator. Mutations
  apply directly to objects looked up via the registry, not to a
  fixed container.

### The new primitive

```ts
function createObserver(options?: {
  onOps?: (ops: Op[]) => void;
  registry?: ObjectRegistry;
  batchMode?: "sync" | "microtask" | "raf" | number;
  resyncInterval?: number;
}): {
  track<T extends object>(obj: T): T;
  snapshot(): SnapshotOp;
  flush(): void;
  destroy(): void;
  registry: ObjectRegistry;
}
```

`createStateStream` is now a thin shim around this:

```ts
function createStateStream(initial, options) {
  const observer = createObserver(options);
  const state = observer.track(initial);
  return { state, snapshot: observer.snapshot, flush: observer.flush, dispose: observer.destroy };
}
```

### Capture-scope roadmap

| Level | Mechanism | Captures | When |
| --- | --- | --- | --- |
| L0 | v0.1 `createStateStream(obj)` | the wrapped object | shipped |
| L0.5 | v0.2 `createObserver().track(obj)` | one or more explicitly tracked objects, with refs | shipped |
| L1 | Framework hooks (React, Zustand, Redux, Vue, Pinia) | framework store state, no app opt-in | v0.3+ |
| L2 | Constructor patches + global proxy | every reachable object created after install | v0.4+ |
| L3 | Build/load-time script transform | locals, closures, primitives — anything | future, via rembrowser |

The eventual ambition is L3 — wide enough that the receiver, running
the same JS code, naturally produces the same DOM, making remdom
unnecessary. v0.2 establishes the protocol shape and primitive that
L1/L2/L3 will extend without breaking the wire format.

### Why ref-based addressing

v0.1 used path-based addressing (`["user", "name"]`). It worked for
trees with stable structure but broke for:
- **Graphs** where the same object lives at multiple paths
- **Cycles** where the encoder would recurse infinitely
- **Moves** where a reparented object would no longer be at its
  original path
- **Multi-root tracking** where there's no single canonical root path

The v0.2 fix: each tracked object gets a stable id from a registry.
Ops carry `target: { kind: "ref", id, prop }` instead of (or in
addition to) paths. The receiver maintains its own registry that
mirrors the source's id space — populated by snapshot-on-connect
and by `__remjs: "newobj"` tags that introduce new objects mid-stream.

Path addressing is still in the protocol (`{ kind: "path", path }`)
because some sources may want it for tree-shaped state, and the v0.1
receiver normalizes legacy ops by wrapping their `path` field into
this form.

---

## Source layout

```
src/
├── ops.ts            # Op type definitions and the TAG constant
├── codec.ts          # encode / decode for JSON-unsafe values
├── proxy-symbol.ts   # The internal RAW symbol (in its own file to break a cycle)
├── proxy.ts          # Deep Proxy wrap — object, array, Map, Set
├── apply.ts          # applyOp / applyOps / createReceiver
├── stream.ts         # createStateStream — batching + lifecycle
└── index.ts          # Public API surface
```

Each file is short — the whole library is about 500 lines of
TypeScript. There are no runtime dependencies. The compiled output
lives in `dist/` and is plain ES modules.

## Data flow

```
                        sender                                receiver
              ┌──────────────────────────┐         ┌──────────────────────────┐
   user code  │ state.foo = 'bar'        │         │                          │
              │           │              │         │                          │
              │           ▼              │         │                          │
              │ Proxy `set` trap         │         │                          │
              │           │              │         │                          │
              │           ▼              │         │                          │
              │ encode(value) → tagged   │         │                          │
              │           │              │         │                          │
              │           ▼              │         │                          │
              │ pending.push(op)         │         │                          │
              │           │              │         │                          │
              │           ▼              │         │                          │
              │ schedule (microtask)     │         │                          │
              │           │              │         │                          │
              │           ▼              │         │                          │
              │ flush → onOps(ops[])     │ ───────►│ applyOps(state, ops[])   │
              │                          │transport│       │                  │
              │                          │         │       ▼                  │
              │                          │         │ walkTo(path)             │
              │                          │         │       │                  │
              │                          │         │       ▼                  │
              │                          │         │ decode(value) → JS value │
              │                          │         │       │                  │
              │                          │         │       ▼                  │
              │                          │         │ parent[key] = value      │
              └──────────────────────────┘         └──────────────────────────┘
```

The arrow labelled "transport" is whatever you wire up. WebSocket,
postMessage, BroadcastChannel, an in-process function call, a file —
remjs neither knows nor cares. The library hands you ops on the source
side and accepts ops on the receiver side. Bytes in between are your
problem.

## Why Proxy

There are four broad approaches to capturing state mutations in JS.
remjs picks the first; the others are deferred for now.

### A. `Proxy` (chosen)

Wrap each tracked object in a `Proxy` that intercepts get/set/delete.
Pros:

- Zero source rewrite. Existing code that mutates plain objects "just
  works" the moment you wrap the root.
- Runtime-only, no build step.
- Captures every mutation that goes through the proxy, including
  array index writes, length changes, Map/Set methods.

Cons:

- Doesn't see closure-local variables (`let`, `const`, function args).
- Doesn't see primitive variables outside an object.
- Can't intercept Map/Set with the generic trap (internal slots) —
  needs per-method wrapping (details below).
- Slightly slower than direct assignment because each property write
  goes through `Reflect.set` and the `set` trap.

### B. Source transform

A Babel/SWC plugin rewrites every assignment in your code to call a
remjs hook: `x = 5` becomes `x = __remjs_set('x', 5)`. Pros: captures
*everything* including closures and primitives. Cons: needs a build
step, the transform has to know your scope structure, and "everything"
includes a lot of stuff you don't actually want streamed.

### C. Record/replay

Don't try to serialize state. Instead, record every input to the JS
runtime (events, network responses, timer fires, `Date.now()`,
`Math.random()`) and replay them deterministically. The receiver
re-runs the program with identical inputs, producing identical state
as a side effect. Used by Replay.io and `rr`.

Pros: full fidelity, captures everything. Cons: needs a fully
instrumented runtime, can't be a library.

### D. V8 heap snapshots

Use V8's heap snapshot API and stream diffs between snapshots.
Captures every reachable JS object. Cons: requires V8 internals
access (Node `--inspect`), full snapshots are expensive (stop the
world), and most of the captured data is GC bookkeeping the receiver
doesn't need.

### Why A first

The Proxy approach is the only one that works as a plain `npm install`,
zero build step, runtime library. For 90% of "mirror this state tree"
use cases (Redux/Zustand stores, React state, game state, form state,
in-memory caches) it's exactly the right shape. The other approaches
are options for the future, especially if we want to push toward "the
entire JS heap".

## The wrap function

`src/proxy.ts` exports `wrap(target, path, emit)`. It returns a Proxy
of `target` whose mutations emit ops at `[...path, key]`.

```typescript
function wrap<T extends object>(target: T, path: Path, emit: Emit): T {
  if (!isWrappable(target)) return target;
  const cached = proxyCache.get(target);
  if (cached) return cached as T;

  let proxy: T;
  if (target instanceof Map)      proxy = wrapMap(target, path, emit);
  else if (target instanceof Set) proxy = wrapSet(target, path, emit);
  else                             proxy = wrapObject(target, path, emit);

  proxyCache.set(target, proxy);
  return proxy;
}
```

Three flavours of wrapper. Map and Set need special handling because
their methods access internal slots; the generic Proxy `get`/`set`
traps don't intercept those. Plain objects and arrays use one shared
generic wrapper.

### Lazy child wrapping

Children of the root aren't wrapped at construction time. They get
wrapped on first read, by the parent's `get` trap:

```typescript
get(t, prop, receiver) {
  if (prop === RAW) return t;
  const value = Reflect.get(t, prop, receiver);
  if (typeof prop === "symbol") return value;
  if (isWrappable(value)) {
    return wrap(value, [...path, prop as string], emit);
  }
  return value;
}
```

This means a `state.user.name` access produces:

1. `state.user` → wraps the user object on the fly (cached after this)
2. `.name` on the wrapped user → returns the primitive directly

Lazy wrapping has two benefits: deep trees don't pay an upfront cost,
and objects you never touch never get a Proxy. The downside is the
slight cost on every read. Profiling on the bouncing-balls demo
suggests it's well under the 1µs/op budget the original research
notes set.

### The proxy cache

```typescript
const proxyCache = new WeakMap<object, unknown>();
```

After `wrap` creates a proxy for an object, it stores
`target → proxy` in a WeakMap. The next call to `wrap(target, ...)`
returns the cached proxy. This preserves identity:

```typescript
state.user === state.user;  // → true
```

…which matches React's expectation that reference equality means
"same object". Without this cache, every read would return a fresh
proxy and React would treat every access as a re-render trigger.

**The known caveat**: the cache key is the target, not the
(target, path) pair. If the same object is moved to a new location in
the tree, the cached proxy still emits at the **original** path. This
is documented in `proxy.ts` and in `USAGE.md`. The fix would be to
key the cache by `(target, path)`, but that introduces its own
problems: identity equality breaks, the WeakMap needs a different
structure, and there's no good way to garbage-collect stale (target,
path) entries.

In practice almost no one moves the same object to two paths in their
state tree, so the simpler cache wins.

### Why Map and Set need separate wrappers

JS Map and Set methods access "internal slots" (the actual storage
behind `Map.prototype.get`, `set`, etc). When the receiver of a method
call is a Proxy, those internal slot accesses fail with "incompatible
receiver" errors. Concretely:

```typescript
const m = new Map();
const p = new Proxy(m, { get(t, prop) { return Reflect.get(t, prop); } });
p.set("k", 1);  // ❌ TypeError: Method Map.prototype.set called on incompatible receiver
```

The fix: in the Proxy's `get` trap, intercept the method call before
it reaches the receiver. Return a wrapper function bound to the **raw
target**:

```typescript
get(t, prop) {
  if (prop === "set") {
    return (k, v) => {
      t.set(k, v);                     // run on the raw target
      emit({ type: "mapSet", path, key: encode(k), value: encode(v) });
      return proxy;                    // chainable
    };
  }
  // ...other intercepted methods...
  const val = Reflect.get(t, prop, t); // bind to raw target, not proxy
  return typeof val === "function" ? val.bind(t) : val;
}
```

The result is that `mapProxy.set("k", 1)` runs the real `Map.set` on
the raw Map, then emits a `mapSet` op. Same pattern for `delete`,
`clear`, `add`. Reads (`get`, `has`, `size`, iteration) bypass remjs
entirely and read directly from the raw target.

### The RAW symbol

```typescript
export const RAW = Symbol.for("remjs.raw");
```

Internal symbol that lets the encoder unwrap proxies before
serializing. When `encode()` walks a value tree and encounters a
remjs proxy, reading `value[RAW]` returns the raw target. Without
this, encoding a proxy would recursively encode through the proxy's
get traps, which works but is slower than walking the raw target
directly.

This symbol is intentionally not exported from `index.ts`. It's an
internal hook only.

`proxy-symbol.ts` exists as its own file because both `proxy.ts` and
`codec.ts` need to refer to `RAW`, but `proxy.ts` also imports from
`codec.ts` (for `encode`). A two-file circular import would work for
ES modules but is fragile. Splitting `RAW` out into a third leaf
module breaks the cycle cleanly.

## The codec

`src/codec.ts` exports `encode(value)` and `decode(value)`.

`encode` recursively walks a JS value, returning a JSON-safe
`EncodedValue`:

- Primitives pass through unchanged.
- `null` is preserved.
- Special types (`undefined`, `NaN`, `Infinity`, `Date`, `RegExp`,
  `BigInt`, `Map`, `Set`) become tagged objects with the reserved
  `__remjs` key.
- Arrays and plain objects recurse.
- Proxies are unwrapped via the `RAW` symbol before encoding.

`decode` is the inverse. The encoded form is documented in
[`WIRE_FORMAT.md`](./WIRE_FORMAT.md).

The codec has no dependency on the proxy or stream code (other than
importing the `RAW` symbol). It can be used standalone for any
"serialize JS value to JSON" task, even outside remjs.

## The receiver

`src/apply.ts` is the simplest file in the library. It defines
`applyOp(root, op)` which dispatches on `op.type`, walks the path,
mutates the parent, and returns the new root. `applyOps(root, ops)`
calls it in a loop.

The receiver works on **plain objects, not proxies**. There is no
Proxy overhead on the receiving side at all. This matters if your
mirror is also driving a UI render loop — every read of `mirror.foo`
is a direct property access, no trap.

`createReceiver(initial?)` is a thin convenience wrapper that holds
the current root in a closure and exposes a `state` getter. Useful
for the typical case where you want to apply ops in one place and
read state in another.

## The stream lifecycle

`createStateStream` does just three things:

1. Wraps `initial` with `wrap()` to produce the proxy.
2. Maintains a pending op array and a schedule flag.
3. Flushes the array to `onOps` per the configured batch mode.

```typescript
let pending: Op[] = [];
let scheduled = false;
let disposed = false;

const flush = () => {
  scheduled = false;
  if (pending.length === 0) return;
  const toSend = pending;
  pending = [];
  if (!disposed) onOps?.(toSend);
};

const schedule = () => {
  if (scheduled || disposed) return;
  scheduled = true;
  if (batch === "sync")          flush();
  else if (batch === "microtask") queueMicrotask(flush);
  else if (batch === "raf")       requestAnimationFrame(flush);
  else if (typeof batch === "number") setTimeout(flush, batch);
};

const emit = (op: Op) => {
  if (disposed) return;
  pending.push(op);
  schedule();
};
```

Every proxy trap calls `emit(op)`. The first call schedules a flush;
subsequent calls within the same tick coalesce into the same pending
array. When the flush fires, the whole array is handed to `onOps` as
one batch.

`dispose()` flips a flag that suppresses further `onOps` calls.
Mutations still happen on the underlying state — there's no way to
"unwrap" a proxy — but they're silently ignored.

`flush()` drains the pending array immediately, regardless of batch
mode. Useful when you need to ship ops on a fixed schedule (e.g., end
of frame) regardless of when the underlying mutations happened.

## Trade-offs

| Decision                              | Cost                                       | Why                                                                                          |
| ------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Proxy over source transform           | Can't capture closures or primitive locals | Library, not toolchain. `npm install` should be enough.                                      |
| Tagged JSON vs binary                 | Bigger wire bytes                          | Debuggable, language-agnostic, no msgpack/protobuf dep.                                      |
| Cache by target                       | Identity bug if same object at two paths   | `state.foo === state.foo` works for React; the bug is rare in real apps.                     |
| Lazy child wrap                       | Slight per-read overhead                   | Don't wrap subtrees that are never touched.                                                  |
| Per-field array ops, no `arrayPush`   | Noisier wire for splice/push/pop           | Simpler library; receiver doesn't need a separate code path; future optimization possible.   |
| No circular ref support               | Throws on cycles                           | Common state trees are trees, not graphs. Cycles need ref IDs which complicates the codec.   |
| Reserved `__remjs` key                | Conflict if your state happens to use it   | Simplest disambiguation. Future codec version may add escape handling.                       |
| Receiver mutates in place             | Can't easily snapshot the receiver         | Performance — no allocation per op. Use `structuredClone` if you need a frozen copy.         |
| No conflict resolution                | Multi-writer needs CRDT/OT above remjs     | remjs is sync, not consensus. Layer the right tool on top if needed.                         |

## Performance characteristics

Headless benchmark on Node 24, 250 rigid-body physics updates per
frame, 4 field writes per body, full JSON serialize/parse round-trip:

- ~990,000 ops/sec sustained
- ~67 MB/s of wire bytes
- ~70 bytes/op average
- ~989 frame-equivalents/sec (so the library has ~16x headroom over
  60 fps at this body count)

The hot path is:

1. Proxy `set` trap fires (≈100 ns overhead)
2. `Reflect.set` mutates the raw target (≈50 ns)
3. `encode(value)` for the new value (≈100 ns for a primitive,
   more for a deep object)
4. `pending.push(op)` (≈20 ns)
5. Flush at end of microtask: one `JSON.stringify` over the whole
   pending array, then one network/transport call

The 67 MB/s figure is the JSON-encoded bytes that hit the wire. If
your transport is in-process (function call, Worker postMessage with
structured clone, BroadcastChannel) you can skip the JSON step
entirely and pass the op array as JS — that's ~3x faster.

## What we'd reconsider for "the entire JS heap"

The CLAUDE.md scratchpad mentions that Proxy-based scoping to
application state is "tractable now and immediately useful", but the
longer-term ambition is to capture more of the JS heap. The natural
paths forward, in order of how much they break:

1. **Wider proxy roots.** Wrap the global object, the `window`, or
   each module's exports. Cheap to try; reveals which approaches
   break in real apps.
2. **Source transform for closures.** Add a Babel plugin that rewrites
   `let`/`const` declarations to proxy-backed storage. Captures locals
   without changing the receiver-side protocol — same op stream.
3. **Heap snapshot streaming.** Take periodic V8 heap snapshots and
   diff them, emitting ops for the changes. Captures literally
   everything reachable. Stop-the-world cost; only practical at low
   frequencies (debugger / time-travel use case, not 60fps live sync).
4. **Record/replay.** Skip state serialization entirely. Capture all
   inputs and replay deterministically. Highest fidelity, fundamentally
   different shape — would be a separate library, not a remjs feature.

For now the Proxy-based MVP solves the "mirror a JS state tree
between two runtimes" problem cleanly, which is enough to be useful
on its own and to feed into the bigger questions later.
