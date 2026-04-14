/**
 * Player — replays event loop ops on a follower runtime.
 *
 * Two replay modes:
 *   - "temporal" (default): ops are replayed at their original cadence
 *     using the `ts` field on each op. Preserves the timing of the
 *     original execution.
 *   - "instant": ops are applied immediately. Useful for fast-forward
 *     or catching up a late joiner.
 *
 * Monkey-patches globals on the follower so that Math.random(),
 * Date.now(), fetch(), etc. return recorded values.
 */

import type { Op, EventOp, TimerOp, NetworkOp, RandomOp, ClockOp, StorageOp, SnapshotOp } from "./ops.js";
import { installIdlHandlerShim } from "./patches/events.js";

export type ReplayMode = "temporal" | "instant";

/**
 * Thrown by strict-mode oracle reads (Math.random, Date.now,
 * localStorage.getItem, etc.) when no matching op has been queued.
 * Under non-strict mode the oracle falls through to native; strict
 * mode refuses, because silent fallback is exactly the divergence
 * channel the tier is designed to close.
 */
export class RemjsStrictEmptyQueueError extends Error {
  readonly oracle: string;
  readonly key?: string;
  constructor(oracle: string, key?: string) {
    super(
      `[remjs strict] ${oracle}${key !== undefined ? "(" + JSON.stringify(key) + ")" : "()"} read with no queued value. ` +
      `Expected a matching op before this call. Recorder must have the corresponding subsystem enabled.`
    );
    this.name = "RemjsStrictEmptyQueueError";
    this.oracle = oracle;
    this.key = key;
  }
}

export interface PlayerOptions {
  mode?: ReplayMode;
  /**
   * Strict mode gates every event-loop entry on the follower. Enabled
   * subsystems stop falling through to native — timers only fire on
   * matching TimerOps, fetch/oracle reads must be satisfied by ops.
   * Default false (0.4.x injection semantics). See epic #22.
   *
   * 0.5.1: strict timers. 0.5.2: strict events — native DOM events
   * filtered unless dispatching from the player. 0.5.3: strict oracles
   * — Math.random, Date.now, localStorage.getItem throw on empty queue
   * instead of falling through to native.
   */
  strict?: boolean;
  events?: boolean;
  timers?: boolean;
  network?: boolean;
  random?: boolean;
  clock?: boolean;
  storage?: boolean;
}

export interface ApplyOptions {
  /** Override the player's default mode for this apply() call. */
  mode?: ReplayMode;
}

export interface Player {
  apply(ops: readonly Op[], options?: ApplyOptions): void;
  destroy(): void;
}

export function createPlayer(options: PlayerOptions = {}): Player {
  const {
    mode: defaultMode = "temporal",
    strict = false,
    events: enableEvents = true,
    timers: enableTimers = true,
    network: enableNetwork = true,
    random: enableRandom = true,
    clock: enableClock = true,
    storage: enableStorage = true,
  } = options;

  // Sync-oracle queues — populated by applying ops; drained by the
  // follower's patched accessors.
  const randomQueue: number[] = [];
  const clockQueue: number[] = [];
  // Storage-get queue, keyed by "kind|key". FIFO per key: multiple
  // reads of the same key on the leader replay in order on the
  // follower.
  const storageGetQueue: Map<string, Array<string | null>> = new Map();
  function storageKey(kind: "local" | "session", key: string): string {
    return `${kind}\u0000${key}`;
  }

  // Generic async-oracle protocol. An async oracle (fetch, XHR,
  // WebSocket, future framework-specific sources) is a pair of ops:
  // a call on the follower that wants the leader's recorded value,
  // and an op-apply that delivers that value. Either can arrive
  // first. The protocol parks whichever comes first and resolves
  // on arrival of the other.
  type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const pendingByKey: Map<string, Pending[]> = new Map();
  const queuedByKey: Map<string, unknown[]> = new Map();

  function asyncKey(kind: string, id: string): string {
    return `${kind}\u0000${id}`;
  }

  function awaitAsyncOracle(kind: string, id: string): Promise<unknown> {
    const key = asyncKey(kind, id);
    // Op already queued? Resolve immediately.
    const queued = queuedByKey.get(key);
    if (queued && queued.length > 0) {
      const value = queued.shift()!;
      if (queued.length === 0) queuedByKey.delete(key);
      return Promise.resolve(value);
    }
    // Not yet — park.
    return new Promise<unknown>((resolve, reject) => {
      const arr = pendingByKey.get(key) ?? [];
      arr.push({ resolve, reject });
      pendingByKey.set(key, arr);
    });
  }

  function signalAsyncOracle(kind: string, id: string, value: unknown): void {
    const key = asyncKey(kind, id);
    // Pending waiter? Resolve the oldest.
    const pending = pendingByKey.get(key);
    if (pending && pending.length > 0) {
      const p = pending.shift()!;
      if (pending.length === 0) pendingByKey.delete(key);
      p.resolve(value);
      return;
    }
    // No waiter — queue for a future await.
    const arr = queuedByKey.get(key) ?? [];
    arr.push(value);
    queuedByKey.set(key, arr);
  }

  function buildResponseFrom(op: NetworkOp): Response {
    return new Response(op.body, {
      status: op.status ?? 200,
      headers: op.headers ?? {},
    });
  }

  function fetchKey(url: string, method: string): string {
    return `${method.toUpperCase()} ${url}`;
  }

  // Temporal replay state — tracks setTimeout handles so destroy() can cancel.
  const pendingTimers: ReturnType<typeof setTimeout>[] = [];

  // Save originals for cleanup
  const origRandom = Math.random;
  const origDateNow = Date.now;
  const origFetch = globalThis.fetch;
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  const origClearTimeout = globalThis.clearTimeout;
  const origClearInterval = globalThis.clearInterval;
  const origLocalGetItem = typeof localStorage !== "undefined" ? localStorage.getItem.bind(localStorage) : null;
  const origSessionGetItem = typeof sessionStorage !== "undefined" ? sessionStorage.getItem.bind(sessionStorage) : null;
  let restoreLocalGetItem: (() => void) | null = null;
  let restoreSessionGetItem: (() => void) | null = null;
  const origRAF = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  const origCAF = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null;
  const origRIC = typeof (globalThis as any).requestIdleCallback === "function" ? (globalThis as any).requestIdleCallback : null;
  const origCIC = typeof (globalThis as any).cancelIdleCallback === "function" ? (globalThis as any).cancelIdleCallback : null;

  // Strict-timers state. When `strict && enableTimers`, follower
  // setTimeout/setInterval/rAF/rIC don't schedule native callbacks.
  // They record the callback against a monotonic seq (matching the
  // recorder's assignment order on the leader) and wait for the
  // matching TimerOp to arrive. clearTimeout removes the entry so
  // stragglers no-op.
  interface StrictTimer { kind: "timeout" | "interval" | "raf" | "idle"; cb: Function }
  const strictTimers: Map<number, StrictTimer> = new Map();
  let strictNextSeq = 0;

  // Strict-events state. `strictDispatching` is true while the player is
  // synchronously dispatching an event (and its cascade). Under strict
  // mode, trusted events only reach user handlers inside this window —
  // which covers player-driven dispatches and any native cascade they
  // trigger. Native events outside the window (user clicks on follower
  // DOM, browser-synthesized events not originating from the player)
  // get dropped.
  let strictDispatching = false;
  const origAddEventListener = typeof EventTarget !== "undefined" ? EventTarget.prototype.addEventListener : null;
  const origRemoveEventListener = typeof EventTarget !== "undefined" ? EventTarget.prototype.removeEventListener : null;
  let uninstallStrictEvents: (() => void) | null = null;

  let installed = false;

  function install(): void {
    if (installed) return;
    installed = true;

    if (enableRandom) {
      Math.random = function (): number {
        if (randomQueue.length > 0) return randomQueue.shift()!;
        if (strict) throw new RemjsStrictEmptyQueueError("Math.random");
        return origRandom();
      };
    }

    if (enableClock) {
      Date.now = function (): number {
        if (clockQueue.length > 0) return clockQueue.shift()!;
        if (strict) throw new RemjsStrictEmptyQueueError("Date.now");
        return origDateNow.call(Date);
      };
    }

    if (enableNetwork) {
      // The follower's fetch waits for the leader's matching NetworkOp
      // via the generic async-oracle protocol. No native fallback —
      // hanging is safer than silently diverging.
      globalThis.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === "string"
          ? input
          : input instanceof URL ? input.href : (input as Request).url;
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        return awaitAsyncOracle("fetch", fetchKey(url, method)) as Promise<Response>;
      } as typeof globalThis.fetch;
    }

    if (strict && enableTimers) installStrictTimers();
    if (strict && enableEvents) installStrictEvents();
    if (strict && enableStorage) installStrictStorage();
  }

  function installStrictStorage(): void {
    if (typeof localStorage !== "undefined" && origLocalGetItem) {
      const patched = function (key: string): string | null {
        const k = storageKey("local", key);
        const queue = storageGetQueue.get(k);
        if (queue && queue.length > 0) {
          const value = queue.shift()!;
          if (queue.length === 0) storageGetQueue.delete(k);
          return value;
        }
        throw new RemjsStrictEmptyQueueError("localStorage.getItem", key);
      };
      localStorage.getItem = patched;
      restoreLocalGetItem = () => { localStorage.getItem = origLocalGetItem; };
    }
    if (typeof sessionStorage !== "undefined" && origSessionGetItem) {
      const patched = function (key: string): string | null {
        const k = storageKey("session", key);
        const queue = storageGetQueue.get(k);
        if (queue && queue.length > 0) {
          const value = queue.shift()!;
          if (queue.length === 0) storageGetQueue.delete(k);
          return value;
        }
        throw new RemjsStrictEmptyQueueError("sessionStorage.getItem", key);
      };
      sessionStorage.getItem = patched;
      restoreSessionGetItem = () => { sessionStorage.getItem = origSessionGetItem; };
    }
  }

  function installStrictEvents(): void {
    if (!origAddEventListener || !origRemoveEventListener) return;
    const aEL = origAddEventListener;
    const rEL = origRemoveEventListener;

    // Orig-handler → wrapper map so removeEventListener finds the right
    // wrapper. Listener identity is preserved from the caller's view.
    const wrapperMap = new WeakMap<Function, EventListener>();

    EventTarget.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (!listener) return aEL.call(this, type, listener, options);
      const handler = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
      let wrapper = wrapperMap.get(handler);
      if (!wrapper) {
        wrapper = function (this: EventTarget, event: Event) {
          // Strict filter: drop trusted events that aren't inside a
          // player-driven dispatch. Synthetic events (isTrusted=false)
          // — including app-code dispatchEvent calls — always pass.
          if (event.isTrusted && !strictDispatching) return;
          return handler.call(this, event);
        };
        wrapperMap.set(handler, wrapper);
      }
      return aEL.call(this, type, wrapper, options);
    };

    EventTarget.prototype.removeEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      if (!listener) return rEL.call(this, type, listener, options);
      const handler = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
      const wrapper = wrapperMap.get(handler);
      return rEL.call(this, type, (wrapper as EventListener) ?? listener, options);
    };

    // Route `el.onclick = fn` through our wrapped addEventListener so
    // IDL handlers get the same filter.
    const uninstallIdl = installIdlHandlerShim();

    uninstallStrictEvents = () => {
      uninstallIdl();
      EventTarget.prototype.addEventListener = aEL;
      EventTarget.prototype.removeEventListener = rEL;
    };
  }

  function installStrictTimers(): void {
    globalThis.setTimeout = function (cb: Function | string, _delay?: number, ..._args: unknown[]): number {
      const seq = strictNextSeq++;
      const fn = typeof cb === "string" ? () => eval(cb as string) : cb;
      strictTimers.set(seq, { kind: "timeout", cb: fn });
      return seq as unknown as number;
    } as typeof globalThis.setTimeout;

    globalThis.setInterval = function (cb: Function | string, _delay?: number, ..._args: unknown[]): number {
      const seq = strictNextSeq++;
      const fn = typeof cb === "string" ? () => eval(cb as string) : cb;
      strictTimers.set(seq, { kind: "interval", cb: fn });
      return seq as unknown as number;
    } as typeof globalThis.setInterval;

    globalThis.clearTimeout = function (id?: number): void {
      if (id !== undefined) strictTimers.delete(id);
    } as typeof globalThis.clearTimeout;

    globalThis.clearInterval = function (id?: number): void {
      if (id !== undefined) strictTimers.delete(id);
    } as typeof globalThis.clearInterval;

    if (origRAF) {
      (globalThis as any).requestAnimationFrame = function (cb: FrameRequestCallback): number {
        const seq = strictNextSeq++;
        strictTimers.set(seq, { kind: "raf", cb });
        return seq;
      };
      (globalThis as any).cancelAnimationFrame = function (id: number): void {
        strictTimers.delete(id);
      };
    }

    if (origRIC) {
      (globalThis as any).requestIdleCallback = function (cb: IdleRequestCallback): number {
        const seq = strictNextSeq++;
        strictTimers.set(seq, { kind: "idle", cb });
        return seq;
      };
      (globalThis as any).cancelIdleCallback = function (id: number): void {
        strictTimers.delete(id);
      };
    }
  }

  function applyTimer(op: TimerOp): void {
    if (!strict || !enableTimers) return;
    const entry = strictTimers.get(op.seq);
    if (!entry) return;
    if (entry.kind !== "interval") strictTimers.delete(op.seq);
    // rAF callbacks expect a DOMHighResTimeStamp; idle expects a
    // deadline. Pass the leader's actualTime for rAF; synthesize a
    // minimal deadline for idle. Timeout/interval callbacks ignore
    // their argument.
    if (entry.kind === "raf") {
      entry.cb(op.actualTime);
    } else if (entry.kind === "idle") {
      const deadline = { didTimeout: false, timeRemaining: () => 50 };
      entry.cb(deadline);
    } else {
      entry.cb();
    }
  }

  function applyOp(op: Op): void {
    switch (op.type) {
      case "event": applyEvent(op); break;
      case "timer": applyTimer(op); break;
      case "network": applyNetwork(op); break;
      case "random": applyRandom(op); break;
      case "clock": applyClock(op); break;
      case "storage": applyStorage(op); break;
      case "snapshot": applySnapshot(op); break;
      case "navigation": break;
    }
  }

  function applyEvent(op: EventOp): void {
    if (!enableEvents) return;
    if (typeof document === "undefined") return;

    const target = document.querySelector(op.targetPath);
    if (!target) return;

    // Mark this whole dispatch (and any synchronous cascade) as player-
    // originated so the strict-events filter lets it through. Save and
    // restore in case of reentrant apply.
    const prevDispatching = strictDispatching;
    strictDispatching = true;
    try {
      dispatchEventFromOp(op, target);
    } finally {
      strictDispatching = prevDispatching;
    }
  }

  function dispatchEventFromOp(op: EventOp, target: Element): void {
    let event: Event;
    const d = op.detail;

    if (op.eventType.startsWith("pointer")) {
      event = new PointerEvent(op.eventType, {
        bubbles: true, cancelable: true,
        clientX: d.clientX as number, clientY: d.clientY as number,
        button: d.button as number, buttons: d.buttons as number,
        pointerId: (d.pointerId as number) ?? 1,
      });
    } else if (op.eventType.startsWith("mouse") || op.eventType === "click" || op.eventType === "dblclick") {
      event = new MouseEvent(op.eventType, {
        bubbles: true, cancelable: true,
        clientX: d.clientX as number, clientY: d.clientY as number,
        button: d.button as number,
      });
    } else if (op.eventType.startsWith("key")) {
      event = new KeyboardEvent(op.eventType, {
        bubbles: true, cancelable: true,
        key: d.key as string, code: d.code as string,
        altKey: d.altKey as boolean, ctrlKey: d.ctrlKey as boolean,
        shiftKey: d.shiftKey as boolean, metaKey: d.metaKey as boolean,
      });
    } else if (op.eventType === "scroll") {
      // Synthetic scroll events don't move the viewport — set position first,
      // then dispatch so listeners see the new values.
      const el = target as Element;
      const maxTop = el.scrollHeight - el.clientHeight;
      const maxLeft = el.scrollWidth - el.clientWidth;
      if (typeof d.scrollTopPct === "number") {
        el.scrollTop = d.scrollTopPct * Math.max(0, maxTop);
      } else if (typeof d.scrollTop === "number") {
        el.scrollTop = d.scrollTop;
      }
      if (typeof d.scrollLeftPct === "number") {
        el.scrollLeft = d.scrollLeftPct * Math.max(0, maxLeft);
      } else if (typeof d.scrollLeft === "number") {
        el.scrollLeft = d.scrollLeft;
      }
      event = new Event(op.eventType, { bubbles: true, cancelable: true });
    } else if (op.eventType === "input" || op.eventType === "change") {
      if ("value" in d && "value" in target) {
        (target as HTMLInputElement).value = d.value as string;
      }
      event = new Event(op.eventType, { bubbles: true, cancelable: true });
    } else {
      event = new Event(op.eventType, { bubbles: true, cancelable: true });
    }

    // Anchors and buttons require the activation algorithm (navigation,
    // form submit) which dispatchEvent does not run — only trusted clicks
    // or element.click() do. Route clicks on these through .click().
    if (op.eventType === "click" && target instanceof HTMLElement) {
      const tag = target.tagName;
      const isActivatable =
        (tag === "A" && (target as HTMLAnchorElement).href) ||
        tag === "BUTTON" ||
        (tag === "INPUT" && ["submit", "reset", "button", "image"].includes((target as HTMLInputElement).type));
      if (isActivatable) {
        target.click();
        return;
      }
    }

    target.dispatchEvent(event);
  }

  function applyNetwork(op: NetworkOp): void {
    if (!enableNetwork) return;
    const method = op.method ?? "GET";
    signalAsyncOracle("fetch", fetchKey(op.url, method), buildResponseFrom(op));
  }

  function applyRandom(op: RandomOp): void {
    if (!enableRandom) return;
    randomQueue.push(...op.values);
  }

  function applyClock(op: ClockOp): void {
    if (!enableClock) return;
    clockQueue.push(op.value);
  }

  function applyStorage(op: StorageOp): void {
    if (!enableStorage) return;
    if (op.action === "get") {
      // Queue the recorded read value so the follower's patched
      // getItem returns it. FIFO per (kind, key).
      const k = storageKey(op.kind, op.key);
      const q = storageGetQueue.get(k) ?? [];
      q.push(op.value);
      storageGetQueue.set(k, q);
      return;
    }
    const storage = op.kind === "local"
      ? (typeof localStorage !== "undefined" ? localStorage : null)
      : (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!storage) return;
    if (op.action === "set" && op.value !== null) storage.setItem(op.key, op.value);
    else if (op.action === "remove") storage.removeItem(op.key);
  }

  function applySnapshot(op: SnapshotOp): void {
    if (typeof document === "undefined") return;
    document.documentElement.innerHTML = op.html;
  }

  /**
   * The replication invariant: every oracle value a handler reads must
   * be available on the follower before the trigger that runs the
   * handler. The recorder emits in observation order (trigger first,
   * oracles second); we reorder on apply so oracles land before the
   * trigger that consumes them. See epic #19 for why this only covers
   * the sync-handler case.
   */
  function isOracle(op: Op): boolean {
    switch (op.type) {
      case "random":
      case "clock":
      case "network":
        return true;
      case "storage":
        return op.action === "get";
      default:
        return false;
    }
  }

  function partitionOps(ops: readonly Op[]): { oracles: Op[]; triggers: Op[] } {
    const oracles: Op[] = [];
    const triggers: Op[] = [];
    for (const op of ops) {
      if (isOracle(op)) oracles.push(op);
      else triggers.push(op);
    }
    return { oracles, triggers };
  }

  function apply(ops: readonly Op[], options?: ApplyOptions): void {
    install();
    if (ops.length === 0) return;
    const mode = options?.mode ?? defaultMode;

    const { oracles, triggers } = partitionOps(ops);

    // Oracles populate the follower's queues. They're not user-visible,
    // so we apply them synchronously regardless of mode — their ts is
    // only used to order them among themselves (already preserved by
    // partition's stable order).
    for (const op of oracles) applyOp(op);

    if (mode === "instant") {
      for (const op of triggers) applyOp(op);
      return;
    }

    // Temporal mode for triggers: schedule at original relative times.
    let minTs = Infinity;
    for (const op of triggers) {
      if (op.ts !== undefined && op.ts < minTs) minTs = op.ts;
    }
    if (minTs === Infinity) {
      for (const op of triggers) applyOp(op);
      return;
    }

    for (const op of triggers) {
      const delay = op.ts !== undefined ? op.ts - minTs : 0;
      if (delay <= 0) {
        applyOp(op);
      } else {
        // Use origSetTimeout so strict-mode timer gating doesn't
        // swallow the player's own scheduling.
        const timer = origSetTimeout.call(globalThis, () => applyOp(op), delay) as ReturnType<typeof setTimeout>;
        pendingTimers.push(timer);
      }
    }
  }

  function destroy(): void {
    for (const t of pendingTimers) origClearTimeout.call(globalThis, t);
    pendingTimers.length = 0;
    if (!installed) return;
    installed = false;
    Math.random = origRandom;
    Date.now = origDateNow;
    globalThis.fetch = origFetch;
    if (strict && enableTimers) {
      globalThis.setTimeout = origSetTimeout;
      globalThis.setInterval = origSetInterval;
      globalThis.clearTimeout = origClearTimeout;
      globalThis.clearInterval = origClearInterval;
      if (origRAF) (globalThis as any).requestAnimationFrame = origRAF;
      if (origCAF) (globalThis as any).cancelAnimationFrame = origCAF;
      if (origRIC) (globalThis as any).requestIdleCallback = origRIC;
      if (origCIC) (globalThis as any).cancelIdleCallback = origCIC;
      strictTimers.clear();
    }
    if (uninstallStrictEvents) {
      uninstallStrictEvents();
      uninstallStrictEvents = null;
    }
    if (restoreLocalGetItem) { restoreLocalGetItem(); restoreLocalGetItem = null; }
    if (restoreSessionGetItem) { restoreSessionGetItem(); restoreSessionGetItem = null; }
    storageGetQueue.clear();
    randomQueue.length = 0;
    clockQueue.length = 0;
    // Reject any still-pending async-oracle waiters so their promises
    // don't hang past teardown.
    for (const arr of pendingByKey.values()) {
      for (const p of arr) p.reject(new Error("remjs player destroyed"));
    }
    pendingByKey.clear();
    queuedByKey.clear();
  }

  return { apply, destroy };
}
