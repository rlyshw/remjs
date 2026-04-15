# remjs

**v0.5.6** · [changelog](./CHANGELOG.md) · [live demo](https://rlyshw.github.io/remjs/mirror.html)

Event loop replication for JavaScript.

A running JavaScript program is a state machine: its state is a
function of the inputs that cross its event loop — clicks, timers,
network responses, reads of `Math.random` and `Date.now`. Give two
runtimes the same inputs in the same order, running the same code,
and they produce the same state. remjs captures those inputs on a
**leader** runtime and applies them on a **follower** so the follower
mirrors the leader without running a line of leader-specific code.

## Shape

```
┌──────────────────────┐                    ┌──────────────────────┐
│  leader runtime      │                    │  follower runtime    │
│                      │                    │                      │
│  patches/*  ──emit──►│        ops         │◄──apply── player.ts  │
│  recorder.ts         │═══════════════════►│                      │
│                      │       codec        │                      │
└──────────────────────┘                    └──────────────────────┘
```

On the leader, each file in `src/patches/` intercepts one environment
API — `addEventListener`, `setTimeout`, `fetch`, `Math.random`,
`Date.now`, `localStorage`. When an input crosses into the runtime,
the matching patch records it as an op. `src/recorder.ts` composes the
patches, batches ops, stamps each with a monotonic `ts`, and hands the
batch to the caller via an `onOps` callback. The op shapes live in
`src/ops.ts` (eight of them, plain JSON). `src/codec.ts` serializes
them — `jsonCodec` is the default; swap in msgpack or protobuf if you
need to.

On the follower, `src/player.ts` runs the batch back into the runtime.
For events it dispatches synthetic events onto the DOM. For
non-determinism — `Math.random`, `Date.now`, `fetch` — it patches
those globals on the follower so the application's reads return the
leader's recorded values rather than fresh ones. For storage it writes
directly. Same subsystems on both sides, mirrored behavior.

Transport is the caller's concern. remjs hands you an op array on one
end and accepts one on the other. WebSocket, `postMessage`,
`BroadcastChannel`, in-process callback — pick one.

## Install

```bash
npm install remjs
```

## Quick start

```ts
import { createRecorder, createPlayer, jsonCodec } from "remjs";

// ── Leader ─────────────────────────────────────────────────────
const recorder = createRecorder({
  onOps: (ops) => ws.send(jsonCodec.encodeBatch(ops)),
});
recorder.start();

// ── Follower ───────────────────────────────────────────────────
const player = createPlayer();
ws.onmessage = (e) => player.apply(jsonCodec.decodeBatch(e.data));
```

Same application code runs on both sides. The follower mirrors the
leader's execution as ops arrive.

## Docs

- [`docs/USAGE.md`](./docs/USAGE.md) — full API, transport recipes, late-joiner patterns, gotchas.
- [`docs/WIRE_FORMAT.md`](./docs/WIRE_FORMAT.md) — op envelope, the eight op types, ordering rules.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — internals, determinism details, non-goals.
- [`docs/TOPOLOGY.md`](./docs/TOPOLOGY.md) — single-leader, mesh P2P, server-auth, spectator patterns; echo filtering, strict-mode interactions, consensus pointers.
- [`CHANGELOG.md`](./CHANGELOG.md) — release notes.

## License

MIT
