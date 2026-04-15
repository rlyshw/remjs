# remjs topologies (v0.5)

remjs is a protocol and codec: it emits ops on one end, applies them
on the other, and takes no position on how peers find each other,
agree on ordering, or resolve conflicts. This document is a
descriptive tour of the topology shapes the framework supports, and
the patterns that fall out of the `peer` field on ops. For the API
reference see [`USAGE.md`](./USAGE.md). For internals see
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## The four common shapes

```
┌──────────────────────┐  ┌──────────────────────┐
│ single-leader        │  │ mesh P2P             │
│ broadcast            │  │                      │
│                      │  │    peer A ←→ peer B  │
│ leader ──► followers │  │      ↑    ╳    ↑     │
│                      │  │      └─ peer C ─┘    │
└──────────────────────┘  └──────────────────────┘

┌──────────────────────┐  ┌──────────────────────┐
│ server-authoritative │  │ pure spectator       │
│                      │  │                      │
│ clients ──► server   │  │ (source) ──► viewer  │
│          ──► clients │  │ viewer only receives │
└──────────────────────┘  └──────────────────────┘
```

Every shape uses the same `createRecorder` / `createPlayer` / `jsonCodec`
primitives. They differ only in who runs which side and how the
transport fans out.

## Single-leader broadcast

One leader runs a recorder. N followers run players. Ops flow one
direction. This is the shape the mirror demo uses.

```ts
// leader
const recorder = createRecorder({
  onOps: (ops) => ws.send(jsonCodec.encodeBatch(ops)),
});
recorder.start();

// follower (any number)
const player = createPlayer();
ws.onmessage = (e) => player.apply(jsonCodec.decodeBatch(e.data));
```

No `peer` field needed — there's only one producer. No echo filtering
— followers don't emit. Followers can run in strict mode
(`createPlayer({ strict: true })`) for provable consistency; the
leader does not need to.

**When to use.** One-to-many replication: live-view dashboards,
observer/coach modes, demo streaming, recording-for-replay. Any
scenario where N runtimes mirror a single source of truth.

## Mesh P2P

Every peer runs **both** a recorder and a player. The mesh broadcasts
every peer's ops to every other peer. This is what the
`multiwriter.html` demo shows.

```ts
const me = "alice";
const mesh = new BroadcastChannel("room");

const player = createPlayer();
mesh.onmessage = (e) => {
  const { from, ops } = jsonCodec.decodeBatchWithMeta(e.data);
  if (from === me) return;     // echo filter — see below
  player.apply(ops);
};

const recorder = createRecorder({
  peer: me,
  onOps: (ops) => mesh.postMessage(
    jsonCodec.encodeBatchWithMeta({ from: me, ops })
  ),
});
recorder.start();
```

The `peer` field on `RecorderOptions` stamps every emitted op. The
`BatchMeta` envelope surfaces it at the batch level too, which is
redundant but convenient — one `from` check drops the whole batch.

**When to use.** Small-N collaborative apps (games, whiteboards,
shared cursors) where every peer's inputs are equally authoritative
and the mesh can deliver to everyone. Scales poorly past ~10 peers;
use a server-authoritative shape past that.

### The echo problem

Most mesh transports deliver your own messages back to you.
BroadcastChannel does; most mesh-router topologies do; WebRTC data
channels typically don't (they're point-to-point), but any star
topology around a relay will. The pattern is: filter on ingress by
peer ID.

```ts
if (from === me) return;    // drop
```

Without this filter, every handler fires twice on the emitting peer —
once locally when the recorder captured the event, again when the
op comes back through the mesh. State diverges, counters double,
all the usual. When something in a mesh app misbehaves, this is
almost always where to look first.

### Input vs trigger symmetry

In a mesh the recorder emits **all** local inputs: clicks, timers,
Math.random reads, etc. Each remote peer applies them. This means:

- Peer A clicks a button. Recorder captures click → broadcasts.
- Peer B receives click op, applies it via dispatchEvent → its
  handler fires.
- Both peers' apps reached the same post-click state.

It also means Math.random, Date.now, and timer fires on peer A are
replicated to peer B. Peer B uses A's recorded values, not its own.
This is the RSM invariant — same inputs in the same order → same
state — holding across the mesh.

**Implication:** only one peer should be authoritative for
non-determinism at a time. If all peers roll Math.random on their
own, their queues fight. The pragmatic pattern is: designate one
peer as "oracle owner" for a given interaction (e.g. the peer
whose click triggered the random), and rely on handler ordering
to keep that deterministic. More principled options (vector clocks,
CRDT merge of oracle queues) are up to the consumer.

## Server-authoritative

Clients emit inputs. A server collects, orders, optionally validates,
and rebroadcasts an ordered stream. Clients apply the server's
stream — not their own locally — or apply optimistically and rollback
if the server's order disagrees.

```ts
// client
const me = clientId;
const player = createPlayer();
ws.onmessage = (e) => {
  const { from, ops } = jsonCodec.decodeBatchWithMeta(e.data);
  // Server echoes our own ops back when they land in the canonical
  // order. Apply them then; skip the optimistic local fire.
  player.apply(ops);
};

const recorder = createRecorder({
  peer: me,
  onOps: (ops) => ws.send(
    jsonCodec.encodeBatchWithMeta({ from: me, ops })
  ),
});
recorder.start();

// server (Node)
const ordered = [];
wss.on("connection", (client) => {
  client.on("message", (data) => {
    const batch = jsonCodec.decodeBatchWithMeta(data);
    // validation, ordering, anti-cheat, rate limiting here
    ordered.push(batch);
    for (const ws of wss.clients) ws.send(data);
  });
});
```

**Local-first vs round-trip.** A strict no-echo server means every
client interaction waits a full round-trip before the handler fires
— latency-bound. The rollback-netcode pattern is: fire handler
locally on user action, record the local state, and if the server's
canonical order diverges, roll back and replay. Out of scope for
this doc; the framework supports both shapes by adjusting when you
call `recorder.start()` and how you filter your own echoes.

**When to use.** Competitive multiplayer (cheat resistance), large-N
(dozens of clients, server-paced broadcast), anything that needs
a trusted authority (moderation, persistence, billing).

## Pure spectator

A peer that only receives. Common for replay viewers, observer modes,
server-side record-keepers, or anyone who shouldn't be able to
interact.

```ts
const player = createPlayer({ strict: true });
ws.onmessage = (e) => player.apply(jsonCodec.decodeBatch(e.data));
```

No recorder. Strict mode is safe and recommended here — the follower
literally can't produce input (no recorder; native events dropped
by the strict filter), and any divergence signals a protocol bug
rather than a benign user-input leak.

## Strict mode interactions

Strict mode is designed for pure followers. It installs a filter
on the follower's `addEventListener` that drops trusted events —
which is exactly what the recorder needs to *see* to capture local
input. That creates a tension: **an emitting peer (recorder + player)
cannot use strict mode's event filter.**

Practical guidance:

| Role                  | Player mode       | Notes                                       |
| --------------------- | ----------------- | ------------------------------------------- |
| Single leader         | N/A (no player)   | Recorder-only.                              |
| Single follower       | strict            | Provable freeze; pause/step available.      |
| Mesh peer             | non-strict        | Recorder needs trusted events.              |
| Server-auth client    | non-strict        | Same reasoning.                             |
| Pure spectator        | strict            | Recommended.                                |

A peer that wants to emit **and** get strict-mode pause-for-debug is
currently unresolved. The cleanest future path is probably
per-subsystem strict flags (strict timers + strict oracles without
strict events) rather than strict-as-all-or-nothing. Tracked
indirectly under #22.

## Trust and authentication

The `peer` field is unauthenticated. Any peer can stamp any ID. That's
intentional — authentication, signing, and session management are
transport concerns, not protocol concerns. Patterns:

- **BroadcastChannel.** Same-origin; the browser enforces scope.
  `peer` is app-assigned; spoofing is possible within the tab but
  not cross-origin.
- **WebSocket.** Server assigns peer ID at connect time (from its
  session/auth layer) and stamps it onto every inbound batch
  before rebroadcasting. Clients can't spoof because the server
  overwrites.
- **WebRTC.** DTLS identity + fingerprint exchange during SDP
  negotiation. Each peer pins the ID to the certificate and
  verifies on every batch.
- **Signed envelopes.** Wrap `BatchMeta` in your own envelope with
  a signature over `(from, ops, nonce)` using the peer's key.
  Reject batches whose signature doesn't verify.

remjs ships none of these. Pick one that matches your transport.

## Snapshots and late joiners

A peer joining 60 seconds into an active session missed the first
60 seconds of ops. Three patterns:

- **Full replay.** Buffer all ops since session start; ship them to
  the joiner; joiner applies via `player.apply(ops, { mode:
  "instant" })` then takes live. Scales linearly with session
  length.
- **Snapshot + resume.** Designate a peer (the leader, or the
  longest-running mesh peer) to call `recorder.snapshot()` on
  demand. Ship snapshot to joiner; joiner applies it; joiner then
  takes live ops from that point. Much cheaper for long sessions.
- **Application-level sync.** Server holds authoritative state;
  on join, send current state via your own REST/WS protocol;
  start applying live ops after that point. remjs doesn't
  prescribe this; it's a system choice.

## Consensus pointers

remjs gives you ordered per-peer op streams. Turning N streams into
one global order is a consensus problem. Sample starting points:

- **Lamport / vector clocks.** Stamp each op with a logical clock;
  order on delivery by comparing clocks. Easy to layer on top of
  `peer`.
- **CRDTs** (Automerge, Yjs). If your state is a CRDT, order doesn't
  matter — merge functions are commutative. Use the op stream as a
  transport for CRDT updates rather than as the state mutation
  mechanism.
- **Total-order broadcast** (Raft, Paxos-lite). A dedicated
  coordinator peer orders everything and rebroadcasts. Becomes a
  server-authoritative shape in practice.
- **Rollback netcode.** Fire handlers optimistically; when a remote
  op arrives with an earlier timestamp, roll back state, apply the
  late op, then replay local ops in order. Used in fighting games.
  Requires deterministic app code — which strict mode helps prove.

These are above-framework concerns; remjs doesn't ship code for any
of them.

## Non-goals recap

- **No built-in consensus.** The framework orders ops within a peer
  (by emission order); global ordering is consumer turf.
- **No built-in persistence.** Snapshots are available; storage is
  your call.
- **No built-in authentication.** `peer` is app-assigned; transport
  layer enforces.
- **No built-in discovery.** Peers find each other through whatever
  mechanism your transport supports (signaling server, DNS,
  hardcoded URLs).

remjs tries to be the smallest thing that makes replicated JS
execution work. Topology lives on top.
