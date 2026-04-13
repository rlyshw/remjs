# remjs

**v0.3.1** · [changelog](./CHANGELOG.md)

Event loop replication for JavaScript. Capture event loop inputs as structured ops, replay them on any runtime for identical execution.

```
same code + same inputs = same state
```

Where [remdom](https://github.com/nichochar/remdom) serializes the DOM (output surface), remjs serializes the JS program (input surface). Together: full round-trip replication.

## Demo

**[Live demo](https://rlyshw.github.io/remjs/mirror.html)** — shuffleboard with op inspector. Source canvas captures pointer events + `Math.random()`. Follower canvas replays them. Pause, step through ops one at a time.

## Install

```bash
npm install remjs
```

## Quick start

```typescript
import { createRecorder, createPlayer, jsonCodec } from 'remjs';

// ── Leader: record event loop inputs ──
const recorder = createRecorder({
  onOps: (ops) => ws.send(jsonCodec.encodeBatch(ops)),
});
recorder.start();
// every click, timer, fetch, Math.random() is now captured

// ── Follower: replay recorded inputs ──
const player = createPlayer();
ws.onmessage = (e) => {
  player.apply(jsonCodec.decodeBatch(e.data));
  // events dispatch, randoms seed, clocks align
};
```

## What gets captured

| Op type | Captures | Example |
|---------|----------|---------|
| `event` | DOM events | `{ type: "event", eventType: "click", targetPath: "button#submit", detail: { clientX: 100 } }` |
| `timer` | setTimeout / setInterval fires | `{ type: "timer", kind: "timeout", seq: 3, scheduledDelay: 1000 }` |
| `network` | fetch responses | `{ type: "network", kind: "fetch", url: "/api/data", status: 200, body: "..." }` |
| `random` | Math.random / crypto values | `{ type: "random", source: "math", values: [0.7291] }` |
| `clock` | Date.now / performance.now | `{ type: "clock", source: "dateNow", value: 1712345678000 }` |
| `storage` | localStorage / sessionStorage | `{ type: "storage", kind: "local", action: "set", key: "theme", value: "dark" }` |
| `navigation` | pushState / popstate | `{ type: "navigation", kind: "pushState", url: "/page/2" }` |
| `snapshot` | Full page state | `{ type: "snapshot", html: "...", url: "...", timestamp: ... }` |

All ops are plain JSON. No special encoding.

## API

### `createRecorder(options): Recorder`

Installs monkey-patches to capture event loop inputs.

```typescript
interface RecorderOptions {
  onOps: (ops: Op[]) => void;    // called with batched ops
  batchMode?: "raf" | "microtask" | "sync";
  events?: boolean;    // DOM events (default: true)
  timers?: boolean;    // setTimeout/setInterval (default: true)
  network?: boolean;   // fetch (default: true)
  random?: boolean;    // Math.random (default: true)
  clock?: boolean;     // Date.now (default: true)
  storage?: boolean;   // localStorage (default: true)
}

interface Recorder {
  start(): void;       // install patches, begin capturing
  stop(): void;        // restore originals, flush pending
  snapshot(): SnapshotOp;
  destroy(): void;
}
```

### `createPlayer(options?): Player`

Replays recorded ops into the event loop.

```typescript
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
  mode?: "temporal" | "instant";   // override the default for this call
}

interface Player {
  apply(ops: readonly Op[], options?: ApplyOptions): void;
  destroy(): void;                  // restore patched globals
}
```

**Temporal vs instant.** `temporal` (default) replays ops at their
original cadence using the `ts` field on each op. `instant` applies
immediately — useful for catching up a late-joining peer. The per-apply
override lets a single player do both: snap up to current state with
`apply(historyOps, { mode: "instant" })`, then take live ops at natural
tempo with the default.

### `jsonCodec: Codec`

JSON encode/decode for transport.

```typescript
interface Codec {
  encode(op: Op): string;
  decode(data: string): Op;
  encodeBatch(ops: readonly Op[]): string;
  decodeBatch(data: string): Op[];
}
```

## How it works

The recorder monkey-patches environment APIs (`addEventListener`, `setTimeout`, `fetch`, `Math.random`, `Date.now`, etc.) to capture every event loop input as a structured op. The player receives those ops and feeds them into the follower's event loop — dispatching events, seeding random values, aligning clocks, injecting network responses.

No Proxy wrapping. No heap inspection. No framework hooks. Works with React, Vue, Svelte, vanilla JS — anything that runs in a browser.

## Design principles

- **Transport-agnostic**: ops in, ops out. You pick the transport.
- **Scope-agnostic**: intercept everything or just specific subsystems.
- **Framework-agnostic**: operates below all frameworks at the environment API level.
- **Plain JSON ops**: no registry, no object IDs, no special encoding.

## License

MIT
