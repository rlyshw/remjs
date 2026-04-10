# remjs examples

Each demo is a tiny Node HTTP + WebSocket server that owns authoritative
state, plus a zero-bundler browser client. State mutations on either side
turn into op batches that stream over the socket.

Before running the demos, build the library once:

```
npm install
npm run build
```

Then pick a demo:

| Demo        | Command                      | URL                    |
| ----------- | ---------------------------- | ---------------------- |
| Todo        | `npm run example:todo`       | http://localhost:7402  |
| Dashboard   | `npm run example:dashboard`  | http://localhost:7403  |

Open each URL in **two or more browser tabs** to watch state sync in real
time.

## What each one demonstrates

- **counter** — minimal bidirectional sync. Two clients share a single
  number plus a rolling event history array. Exercises numeric sets and
  array push/shift.
- **todo** — multi-writer collaboration on a list. Exercises array
  splice, nested property toggles (`todo.done`), and filter state
  shared across tabs.
- **dashboard** — server-driven streaming. The server owns the state and
  mutates it on a 500ms interval; clients are read-only. Exercises
  deep path writes (`metrics.cpu`, `services.api.status`), a rolling
  sparkline buffer, and an event log.

## Architecture

All three demos share two helper modules:

- `_shared/session.js` — server-side. Wraps the state in
  `createStateStream`, manages the WebSocket subscribers, sends a
  snapshot on connect, and rebroadcasts incoming client ops to other
  clients (applied directly to the raw state to avoid echoes).
- `_shared/client.js` — browser-side. Connects, receives the initial
  snapshot, wraps the decoded state with its own `createStateStream`, and
  routes local mutations to the server while applying incoming remote
  ops to the raw state.
- `_shared/static-server.js` — serves the demo HTML, the compiled
  library from `dist/` at `/lib/*`, and the shared client at `/_shared/*`.
