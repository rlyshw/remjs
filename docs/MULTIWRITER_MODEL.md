# Multi-writer consistency model (v0.5.7 — research note)

This doc formalizes the invariant that multi-writer remjs deployments
must hold, describes the one place where the framework violated it
through 0.5.6, and sketches the proof that the 0.5.7 fix restores it.
Written as research notes, not prescriptive API docs — if you're
using remjs, the actionable summary is in
[`TOPOLOGY.md`](./TOPOLOGY.md).

## Setting

Let `P` be a finite set of **peers**. Each `p ∈ P` runs:

- `R_p` — a recorder. Observes events entering `p`'s event loop,
  emits ops, ships via a transport `T`.
- `L_p` — a player. Receives ops from `T`, applies them to `p`'s
  runtime.
- `A_p` — the application. Identical code on every peer;
  deterministic given the same input sequence.

`T` delivers every op emitted by any peer to every other peer.
Delivery is ordered per sender (FIFO from `R_p` to `L_q` for all
`p, q`) and eventually complete. Cross-sender ordering is the
transport's concern; for this model we assume a global total order
exists (the consumer enforces it via consensus / Lamport clock /
server-authoritative relay — see `TOPOLOGY.md`).

## Op classification

An event that crosses peer `p`'s `addEventListener` / `setTimeout`
callback / oracle read surface is one of:

1. **Environmental.** User input, OS timer fire, network response —
   something the environment produced that neither `R_p`, `L_p`, nor
   `A_p` caused synchronously.
2. **App-dispatched.** `A_p` called `element.dispatchEvent(new
   Event(...))` or similar. A deterministic consequence of `A_p`'s
   execution.
3. **Player-dispatched.** `L_p` called `target.dispatchEvent` as
   part of applying an op from some peer `q ≠ p`.
4. **Cascade.** The browser synthesized an event because a prior
   event (of any class) triggered it — `label` click → input click
   → change.

## The recorder's capture rule (desired)

For consistency, `R_p` must emit ops for class 1 only. Classes 2, 3,
4 must be suppressed.

### Why:

- **Class 3 (player-dispatched).** If `R_p` emits for player-
  dispatched events, each applied op produces a new emitted op
  attributed to `p`, which propagates to every other peer, which
  applies it, which re-emits. Divergent feedback explosion —
  observed experimentally in v0.5.5/0.5.6 as ~30k ops/second on
  tab-focus in the multiwriter demo.
- **Class 2 (app-dispatched).** `A_p` is deterministic and runs
  identically on every peer. If `A_p` on peer `p` dispatches event
  `e`, then `A_p` on every other peer `p'` also dispatches `e` (at
  the equivalent point in its trace). If `R_p` captures `e` and
  propagates it, `L_{p'}.apply` re-fires `e` on `p'` — but `A_{p'}`
  has already fired it. Double invocation.
- **Class 4 (cascade).** Same reasoning as class 2: on the
  replaying peer, the parent event replays and the browser cascades
  natively. Capturing the cascade separately causes a double-fire.

### Already handled pre-0.5.7:

- **Class 4** is handled by the recorder's `dispatchDepth` counter
  — events observed while `dispatchDepth > 0` are skipped.
- **Class 1** is the default (emit) path.

### Unhandled pre-0.5.7:

- **Class 2** is actually captured today. This is a latent bug even
  for single-leader broadcast: if app code uses `dispatchEvent`, the
  follower (which also runs the same app code) will fire the event
  twice. In practice most apps don't use `dispatchEvent` for
  internal work, so this hasn't caused visible problems. For mesh
  P2P where every peer runs `A_p`, it's a divergence hazard if any
  handler dispatches events. Out of scope for 0.5.7; see "Open
  problems" below.
- **Class 3** is the feedback loop the demo surfaced. 0.5.7 fixes
  this.

## The fix: shared synth flag

Both `R_p` and `L_p` run inside peer `p`'s single JavaScript runtime.
They can share module-scoped state.

**`synthFlag`**: a counter. `enterSynth()` increments;
`exitSynth()` decrements; `isSynthActive()` returns `depth > 0`.
The player increments it around every dispatch it performs (both
`dispatchEvent` and the `element.click()` activation path). The
recorder's event wrapper checks it at emit time:

```
if (dispatchDepth === 0 && !isSynthActive() && ...) emit(op);
```

Equivalently: events observed while any player dispatch is on the
stack are skipped by the recorder.

Since JavaScript is single-threaded, a player dispatch is always
synchronous — if the player is dispatching, we're inside its call
frame. Enter/exit bracketing preserves reentrancy correctness:
if `L_p.apply` somehow triggers another `L_p.apply` (e.g. a handler
calls `apply`), the counter reflects depth correctly.

## Proof sketch

**Claim.** For the multi-writer protocol as specified, if:

1. `T` delivers ops in-order per sender.
2. `R_p` emits only for class-1 events.
3. Every peer applies ops using `L_p` only.
4. Every peer runs identical `A_p`.
5. Non-determinism (oracles) is captured and replayed by the
   framework's existing subsystems.

Then for any total ordering of ops across all peers, every peer's
runtime state converges to the same value.

**Proof sketch.**

Peer `p`'s state is a pure function of the input sequence its event
loop processes. By construction, every runtime input is either
environmental or a deterministic consequence of prior inputs.

Environmental inputs on peer `p` are captured by `R_p` as ops (by
condition 2, excluding classes 2/3/4 which are deterministic). These
ops reach every other peer via `T`. Each other peer `q`'s `L_q`
applies them, firing the same handlers with the same arguments as
`R_p` observed.

Handlers on `p` and `q` run identical `A_p`, `A_q` code (condition
4). Oracle reads inside handlers pop from framework-managed queues
populated by earlier oracle ops (condition 5). Therefore each
handler invocation on `p` and on `q` produces identical effects on
their respective runtime states.

Class-2 events (app-dispatched) are fired by `A_p` on `p` AND by
`A_q` on `q` independently (condition 4 — same code, same prior
inputs, same dispatch). They're not captured (class-2 exclusion —
see open problems). Both peers' state transitions from those
dispatches are identical.

Class-3 events on `p` exist only because `L_p` applied an op from
some other peer `q`. That op was emitted by `R_q` for an
environmental event on `q`. So class-3 dispatch on `p` is the
replay of class-1 capture on `q`. Not re-captured (by (3) via the
synth flag), so no feedback.

Class-4 events (cascade) are browser-synthesized from class-1 or
class-3 events. They re-fire natively on the replaying peer when
the parent event is dispatched. Not captured (dispatchDepth guard).

Therefore, for any peer `p`, the sequence of handler invocations
and oracle reads observed by `A_p` is identical to the sequence
observed by every other peer. `A_p` is deterministic. So `S_p =
S_q` for all `p, q`. ∎

### Where this proof is informal

- **Cross-sender ordering** is hand-waved as "consumer enforces via
  consensus." In practice, the consumer picks a total-order discipline
  (Lamport clocks, server-authoritative relay, CRDT merge). The proof
  assumes one exists; the framework doesn't ship one.
- **Non-determinism on the emitting peer.** Peer `p` reads `Math.random`
  during an environmental event handler. The read is captured as a
  `RandomOp` and replicated. But *on peer p itself*, the value
  returned is the native one (non-strict mode) or from its own
  emitted queue. Other peers get `p`'s value. Convergence holds
  because the emitted value is what both peers use. Strict mode
  on non-emitting peers makes this guaranteed; non-strict emitting
  peers rely on "same native call returns same value," which is
  true per-call but couples peers to the emitter's environment.
  Documented tension.
- **Timing of transport delivery.** Handlers on different peers fire
  at different wall-clock times. State converges but the
  trajectories differ. Temporal consistency (all peers see the same
  state at the same wall-clock moment) is a stronger property that
  remjs doesn't offer.

## Open problems

### Class-2 capture (app-dispatched events)

In mesh topology, app code that calls `dispatchEvent` creates a
correctness risk: the event fires on every peer (deterministic
replay of app code) AND is captured+broadcast by `R_p` (which re-
dispatches on every other peer via `L_q`). Double-fire.

Fix options:
1. **Ban `dispatchEvent` in app code** on mesh peers. Hostile; apps
   that happen to use it for internal signaling break.
2. **Filter class-2 in the recorder.** Check `event.isTrusted`.
   Trusted events are environmental (class 1) or browser-cascaded
   (class 4, already handled). Synthetic events from app code have
   `isTrusted === false`. Would also catch class 3 (player's
   dispatches are synthetic), so the synth flag becomes redundant
   — but strict mode already uses `isTrusted` as its filter, so
   this is consistent with the existing mechanism. Tradeoff: loses
   app-code-dispatched events in single-leader mode (where leader
   capture of app dispatches was a feature).
3. **Mode-per-recorder.** `createRecorder({ captureSynthetic:
   true | false })`. Explicit opt-in per topology. Single-leader
   defaults to `true` (current behavior); multi-writer peers set
   `false`.

Option 3 is probably the clean answer, with the synth flag as the
class-3 mechanism regardless. Out of scope for 0.5.7 — filing
separately.

### Cross-peer oracle attribution

When peer `p`'s handler reads `Math.random`, the value is captured
and replicated. Other peers use `p`'s value. Fine if `p` emitted the
triggering event. But what if two peers simultaneously handle events
that read oracles? Their oracle queues interleave. Total ordering by
transport fixes it in theory (consumer picks an order), but in
practice a peer might apply its own handler optimistically before
the consensus order is known.

Relates to rollback netcode. Out of scope; noted for future
research.

### Strict mode + recorder composition

Strict mode filters trusted events; recorder needs them. An
emitting peer can't use the strict event filter, which means it
can't use the pause primitive built on strict mode either. The
clean path forward is **per-subsystem strict** — a peer with strict
timers + strict oracles + non-strict events (capture leaks the
needed trusted events; player handles remote ops; no pause for
events specifically). Future research.

## Version rationale

**0.5.7.** Framework-internal fix, no API surface change, no breaking
behavior. Multi-writer consumers get a correctness bugfix; single-
leader consumers see no change (player never was emitting for
itself in that shape because there was no recorder co-installed).

Labeled a research release: the fix is small (~30 LOC) but the
formal framing is the deliverable. Future multi-writer work should
reference this model.
