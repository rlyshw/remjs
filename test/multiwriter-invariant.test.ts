/**
 * Multi-writer invariant tests.
 *
 * Directly verifies the core claim from docs/MULTIWRITER_MODEL.md:
 * when a recorder and a player coexist on the same runtime, player-
 * dispatched events must not be re-captured by the recorder. If this
 * fails, peers feedback-loop: every applied op re-emits as a new op
 * attributed to the applying peer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRecorder } from "../src/recorder.js";
import { createPlayer } from "../src/player.js";
import { _resetSynthFlag } from "../src/synth-flag.js";
import type { Op, EventOp } from "../src/ops.js";

describe("multi-writer invariant (0.5.7)", () => {
  beforeEach(() => {
    _resetSynthFlag();
  });
  afterEach(() => {
    _resetSynthFlag();
  });

  // Node has no DOM Element class. Make one that extends EventTarget
  // and carries the minimum shape getTargetPath + the recorder guard
  // need: tagName, id, parentElement.
  class FakeElement extends EventTarget {
    id: string;
    tagName = "DIV";
    parentElement: Element | null = null;
    constructor(id: string) { super(); this.id = id; }
  }

  function setupDom() {
    (globalThis as any).Element = FakeElement;
    // Stub the DOM event classes. The recorder's extractDetail and the
    // player's dispatchEventFromOp do unguarded `instanceof MouseEvent`
    // / `new PointerEvent(...)` etc. In Node these are undefined, so
    // tests need stubs. Event is native.
    (globalThis as any).MouseEvent = Event;
    (globalThis as any).InputEvent = Event;
    (globalThis as any).KeyboardEvent = Event;
    (globalThis as any).PointerEvent = Event;
    (globalThis as any).HTMLElement = FakeElement;
    (globalThis as any).HTMLAnchorElement = FakeElement;
    (globalThis as any).HTMLInputElement = FakeElement;
    const target = new FakeElement("test-target");
    const root = new FakeElement("root");
    (globalThis as any).document = {
      documentElement: root,
      body: root,
      querySelector: (sel: string) => sel === "#test-target" ? target : null,
    };
    return target;
  }

  function teardownDom() {
    delete (globalThis as any).document;
    delete (globalThis as any).Element;
    delete (globalThis as any).MouseEvent;
    delete (globalThis as any).InputEvent;
    delete (globalThis as any).KeyboardEvent;
    delete (globalThis as any).PointerEvent;
    delete (globalThis as any).HTMLElement;
    delete (globalThis as any).HTMLAnchorElement;
    delete (globalThis as any).HTMLInputElement;
  }

  it("recorder does NOT re-emit events dispatched by the player", () => {
    const target = setupDom();
    const emitted: Op[] = [];

    // Recorder first, then player. Order matches what a real peer would do.
    const recorder = createRecorder({
      onOps: (ops) => emitted.push(...ops),
      batchMode: "sync",
      peer: "alice",
      timers: false, network: false, random: false, clock: false, storage: false,
    });
    recorder.start();

    const player = createPlayer({
      timers: false, network: false, random: false, clock: false, storage: false,
    });
    player.apply([]); // force install

    // App code registers a click listener — the thing the recorder
    // wraps and the thing the player would fire via dispatchEvent.
    target.addEventListener("click", () => {});

    // Simulate an op arriving from another peer.
    const remoteOp: EventOp = {
      type: "event",
      eventType: "click",
      targetPath: "#test-target",
      timestamp: 0,
      detail: { clientX: 0, clientY: 0, button: 0, buttons: 0 },
      peer: "bob",
    };
    player.apply([remoteOp]);

    // Invariant: the recorder MUST NOT have emitted anything in
    // response to the player's dispatch. If it did, feedback loop.
    const eventEmissions = emitted.filter((o) => o.type === "event");
    expect(eventEmissions).toEqual([]);

    recorder.stop();
    player.destroy();
    teardownDom();
  });

  it("recorder DOES emit for environmental events when player is idle", () => {
    const target = setupDom();
    const emitted: Op[] = [];

    const recorder = createRecorder({
      onOps: (ops) => emitted.push(...ops),
      batchMode: "sync",
      peer: "alice",
      timers: false, network: false, random: false, clock: false, storage: false,
    });
    recorder.start();

    const player = createPlayer({
      timers: false, network: false, random: false, clock: false, storage: false,
    });
    player.apply([]);

    target.addEventListener("click", () => {});

    // Simulate a trusted environmental event — synth flag is NOT set.
    // We override isTrusted to true to simulate what the browser would
    // deliver for a real user click.
    class TrustedEvent extends Event {
      get isTrusted() { return true; }
    }
    target.dispatchEvent(new TrustedEvent("click"));

    const eventEmissions = emitted.filter((o) => o.type === "event");
    expect(eventEmissions).toHaveLength(1);
    expect(eventEmissions[0]!.peer).toBe("alice");

    recorder.stop();
    player.destroy();
    teardownDom();
  });

  it("two-peer round-trip does not produce cascading re-emissions", () => {
    const targetA = setupDom();
    const emittedA: Op[] = [];
    const emittedB: Op[] = [];

    const recorderA = createRecorder({
      onOps: (ops) => emittedA.push(...ops),
      batchMode: "sync",
      peer: "alice",
      timers: false, network: false, random: false, clock: false, storage: false,
    });
    recorderA.start();
    const playerA = createPlayer({
      timers: false, network: false, random: false, clock: false, storage: false,
    });
    playerA.apply([]);

    // In a single-process test we can't have two independent runtimes.
    // Simulate peer B by reapplying B's emitted ops back to A's player
    // (imagine peer B's recorder produced these, mesh relayed, A's
    // player applies). The invariant: A's player applying these should
    // not cause A's recorder to emit new ops.
    const preEmittedCountA = emittedA.length;

    targetA.addEventListener("click", () => {});

    // An op "from Bob"
    const fromBob: EventOp = {
      type: "event",
      eventType: "click",
      targetPath: "#anything",
      timestamp: 0,
      detail: { clientX: 0, clientY: 0, button: 0, buttons: 0 },
      peer: "bob",
    };

    playerA.apply([fromBob]);

    // After applying Bob's op, Alice's recorder should not have
    // emitted anything new.
    expect(emittedA.filter((o) => o.type === "event")).toHaveLength(0);
    expect(emittedA.length).toBe(preEmittedCountA);

    // And the recorder is still alive — a subsequent environmental
    // event still emits.
    class TrustedEvent extends Event {
      get isTrusted() { return true; }
    }
    targetA.dispatchEvent(new TrustedEvent("click"));
    expect(emittedA.filter((o) => o.type === "event")).toHaveLength(1);

    recorderA.stop();
    playerA.destroy();
    teardownDom();
  });

  it("synth flag is correctly bracketed (reentrant apply during dispatch)", () => {
    const target = setupDom();
    const emitted: Op[] = [];

    const recorder = createRecorder({
      onOps: (ops) => emitted.push(...ops),
      batchMode: "sync",
      peer: "alice",
      timers: false, network: false, random: false, clock: false, storage: false,
    });
    recorder.start();

    const player = createPlayer({
      timers: false, network: false, random: false, clock: false, storage: false,
    });
    player.apply([]);

    // Handler that triggers another player.apply during its execution
    // — but only once, to avoid infinite recursion. Tests that nested
    // dispatches keep the synth flag active.
    let handlerReentrantFired = 0;
    let reentered = false;
    target.addEventListener("click", () => {
      handlerReentrantFired++;
      if (!reentered) {
        reentered = true;
        player.apply([{
          type: "event",
          eventType: "click",
          targetPath: "#test-target",
          timestamp: 0,
          detail: { clientX: 0, clientY: 0, button: 0, buttons: 0 },
          peer: "carol",
        }]);
      }
    });

    player.apply([{
      type: "event",
      eventType: "click",
      targetPath: "#test-target",
      timestamp: 0,
      detail: { clientX: 0, clientY: 0, button: 0, buttons: 0 },
      peer: "bob",
    }]);

    // Both applies should have fired their handlers; neither should
    // have caused a recorder emit.
    expect(handlerReentrantFired).toBeGreaterThanOrEqual(1);
    expect(emitted.filter((o) => o.type === "event")).toHaveLength(0);

    recorder.stop();
    player.destroy();
    teardownDom();
  });
});
