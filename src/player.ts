/**
 * Player — replays event loop ops on a follower runtime.
 *
 * Monkey-patches globals so Math.random(), Date.now(), fetch(), etc.
 * return recorded values instead of producing new non-determinism.
 */

import type { Op, EventOp, TimerOp, NetworkOp, RandomOp, ClockOp, StorageOp, SnapshotOp } from "./ops.js";
import { installIdlHandlerShim } from "./patches/events.js";
import { enterSynth, exitSynth, isSynthActive } from "./synth-flag.js";

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
   * Without strict, native timers, events, and oracle fallback continue
   * underneath the player, which is correct only for injection scenarios
   * that don't need full isolation.
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

export interface ResumeOptions {
  /**
   * `"instant"` (default) drains all buffered batches synchronously
   * in a burst — every handler fires, state converges immediately,
   * wall-clock compresses. `"temporal"` paces the drain by each
   * batch's `ts` delta via a single advancing timer loop — the
   * follower replays the backlog at its original cadence and
   * stays behind leader by the pause duration.
   */
  mode?: ReplayMode;
  coalesce?: boolean;
}

export interface PauseQueueOptions {
  /**
   * Refuse to buffer more than N ops while paused. When exceeded,
   * the player applies `onQueueFull`:
   * - `"drain"` (default): eagerly apply the oldest half of the queue
   *   under `instant` semantics and continue buffering new ops.
   * - `"instant"`: transition the player back to running in instant
   *   mode and replay everything immediately.
   *
   * Default: no cap.
   */
  maxQueue?: number;
  onQueueFull?: "drain" | "instant";
}

export interface Player {
  apply(ops: readonly Op[], options?: ApplyOptions): void;
  /**
   * Stop draining the apply queue. Incoming `apply()` calls buffer
   * the batch instead of executing. Requires `strict: true` —
   * non-strict pause would leak through native timers / events
   * / oracle fallback and produce divergence.
   */
  pause(options?: PauseQueueOptions): void;
  /**
   * Apply exactly one buffered batch while paused. Returns `true`
   * if a batch was applied, `false` if the queue was empty or the
   * player was not paused.
   */
  step(): boolean;
  /**
   * Drain the buffered queue and return the player to running state.
   * Mode defaults to `"instant"` — see ResumeOptions for the
   * tradeoff.
   */
  resume(options?: ResumeOptions): void;
  /** Whether the player is currently paused. */
  readonly paused: boolean;
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

  // Generic async-oracle protocol: a call on the follower that wants
  // the leader's recorded value, and an op-apply that delivers it.
  // Either can arrive first — the protocol parks whichever comes first
  // and resolves on arrival of the other.
  type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const pendingByKey: Map<string, Pending[]> = new Map();
  const queuedByKey: Map<string, unknown[]> = new Map();

  function asyncKey(kind: string, id: string): string {
    return `${kind}\u0000${id}`;
  }

  function awaitAsyncOracle(kind: string, id: string): Promise<unknown> {
    const key = asyncKey(kind, id);
    const queued = queuedByKey.get(key);
    if (queued && queued.length > 0) {
      const value = queued.shift()!;
      if (queued.length === 0) queuedByKey.delete(key);
      return Promise.resolve(value);
    }
    return new Promise<unknown>((resolve, reject) => {
      const arr = pendingByKey.get(key) ?? [];
      arr.push({ resolve, reject });
      pendingByKey.set(key, arr);
    });
  }

  function signalAsyncOracle(kind: string, id: string, value: unknown): void {
    const key = asyncKey(kind, id);
    const pending = pendingByKey.get(key);
    if (pending && pending.length > 0) {
      const p = pending.shift()!;
      if (pending.length === 0) pendingByKey.delete(key);
      p.resolve(value);
      return;
    }
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
  /** Union of all timer callback shapes stored in the strict-timer map. */
  type StrictTimerCallback = ((...args: unknown[]) => void) | FrameRequestCallback | IdleRequestCallback;
  interface StrictTimer { kind: "timeout" | "interval" | "raf" | "idle"; cb: StrictTimerCallback }
  const strictTimers: Map<number, StrictTimer> = new Map();
  let strictNextSeq = 0;

  // Strict-events filter uses the shared synth flag (synth-flag.ts),
  // which the recorder also checks to suppress emit during player
  // dispatch — preventing feedback on co-installed recorder+player.
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

  function patchStrictStorageGetItem(
    storage: Storage,
    kind: "local" | "session",
    origGetItem: (key: string) => string | null,
    assignRestore: (fn: () => void) => void,
  ): void {
    storage.getItem = function (key: string): string | null {
      const k = storageKey(kind, key);
      const queue = storageGetQueue.get(k);
      if (queue && queue.length > 0) {
        const value = queue.shift()!;
        if (queue.length === 0) storageGetQueue.delete(k);
        return value;
      }
      throw new RemjsStrictEmptyQueueError(`${kind === "local" ? "localStorage" : "sessionStorage"}.getItem`, key);
    };
    assignRestore(() => { storage.getItem = origGetItem; });
  }

  function installStrictStorage(): void {
    if (typeof localStorage !== "undefined" && origLocalGetItem) {
      patchStrictStorageGetItem(localStorage, "local", origLocalGetItem, (fn) => { restoreLocalGetItem = fn; });
    }
    if (typeof sessionStorage !== "undefined" && origSessionGetItem) {
      patchStrictStorageGetItem(sessionStorage, "session", origSessionGetItem, (fn) => { restoreSessionGetItem = fn; });
    }
  }

  function installStrictEvents(): void {
    if (!origAddEventListener || !origRemoveEventListener) return;
    const aEL = origAddEventListener;
    const rEL = origRemoveEventListener;

    // Orig-handler → wrapper map so removeEventListener finds the right
    // wrapper. Listener identity is preserved from the caller's view.
    const wrapperMap = new WeakMap<EventListener, EventListener>();

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
          if (event.isTrusted && !isSynthActive()) return;
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
    function makeStrictScheduler(kind: "timeout" | "interval"): (cb: TimerHandler, _delay?: number, ..._args: unknown[]) => number {
      return function (cb, _delay?, ..._args) {
        const seq = strictNextSeq++;
        const fn: StrictTimerCallback = typeof cb === "string" ? () => eval(cb as string) : (cb as StrictTimerCallback);
        strictTimers.set(seq, { kind, cb: fn });
        return seq as unknown as number;
      };
    }

    globalThis.setTimeout = makeStrictScheduler("timeout") as typeof globalThis.setTimeout;
    globalThis.setInterval = makeStrictScheduler("interval") as typeof globalThis.setInterval;

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
      (entry.cb as FrameRequestCallback)(op.actualTime);
    } else if (entry.kind === "idle") {
      const deadline: IdleDeadline = { didTimeout: false, timeRemaining: () => 50 };
      (entry.cb as IdleRequestCallback)(deadline);
    } else {
      (entry.cb as (...args: unknown[]) => void)();
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

    // Mark this whole dispatch (and any synchronous cascade) as
    // player-originated. The strict-events filter lets trusted events
    // through while this flag is active, AND the recorder's capture
    // wrapper skips emit while it's active — preventing feedback on
    // co-installed recorder+player runtimes.
    enterSynth();
    try {
      dispatchEventFromOp(op, target);
    } finally {
      exitSynth();
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

  // Replication invariant: every oracle value a handler reads must be
  // available before the trigger that runs the handler. The recorder
  // emits in observation order (trigger first, oracle second); we
  // reorder on apply so oracles land first. This covers sync handlers
  // only — async handlers receive values via the async-oracle protocol.
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

  // ── Pause / resume / step state ────────────────────────────────
  let paused = false;
  const pendingBatches: Op[][] = [];
  let pauseOpts: PauseQueueOptions = {};
  let temporalDrainTimer: ReturnType<typeof setTimeout> | null = null;

  function queueSize(): number {
    let n = 0;
    for (const b of pendingBatches) n += b.length;
    return n;
  }

  function drainBatchesInstant(batches: Op[][]): void {
    for (const batch of batches) applyInternal(batch, { mode: "instant" });
  }

  function drainBatchesTemporal(batches: Op[][]): void {
    if (temporalDrainTimer) {
      origClearTimeout.call(globalThis, temporalDrainTimer);
      temporalDrainTimer = null;
    }
    const firstBatchTs = minBatchTs(batches[0]);
    const drainStart = performance.now();
    let cursor = 0;

    const pump = () => {
      temporalDrainTimer = null;
      if (cursor >= batches.length) return;
      applyInternal(batches[cursor], { mode: "instant" });
      cursor++;
      if (cursor >= batches.length) return;
      const nextTs = minBatchTs(batches[cursor]);
      const targetDelta = (nextTs !== undefined && firstBatchTs !== undefined)
        ? nextTs - firstBatchTs
        : 0;
      const elapsed = performance.now() - drainStart;
      const delay = Math.max(0, targetDelta - elapsed);
      temporalDrainTimer = origSetTimeout.call(globalThis, pump, delay) as ReturnType<typeof setTimeout>;
    };
    pump();
  }

  function minBatchTs(batch: Op[]): number | undefined {
    let min: number | undefined;
    for (const op of batch) {
      if (op.ts !== undefined && (min === undefined || op.ts < min)) min = op.ts;
    }
    return min;
  }

  function enqueueBatch(ops: readonly Op[]): void {
    pendingBatches.push([...ops]);
    const cap = pauseOpts.maxQueue;
    if (cap !== undefined && queueSize() > cap) {
      const policy = pauseOpts.onQueueFull ?? "drain";
      if (policy === "instant") {
        paused = false;
        const batches = pendingBatches.splice(0, pendingBatches.length);
        pauseOpts = {};
        drainBatchesInstant(batches);
      } else {
        // "drain": apply oldest half, keep paused.
        const half = Math.max(1, Math.floor(pendingBatches.length / 2));
        const chunk = pendingBatches.splice(0, half);
        drainBatchesInstant(chunk);
      }
    }
  }

  function apply(ops: readonly Op[], options?: ApplyOptions): void {
    install();
    if (ops.length === 0) return;
    if (paused) {
      enqueueBatch(ops);
      return;
    }
    applyInternal(ops, options);
  }

  function pause(options?: PauseQueueOptions): void {
    if (!strict) {
      throw new Error(
        "[remjs] player.pause() requires createPlayer({ strict: true }). " +
        "Non-strict pause is not a true freeze — native timers, events, " +
        "and oracle fallback continue underneath the player."
      );
    }
    paused = true;
    pauseOpts = options ?? {};
  }

  function step(): boolean {
    if (!paused) return false;
    const batch = pendingBatches.shift();
    if (!batch) return false;
    applyInternal(batch, { mode: "instant" });
    return true;
  }

  function resume(options?: ResumeOptions): void {
    paused = false;
    const mode = options?.mode ?? "instant";
    const batches = pendingBatches.splice(0, pendingBatches.length);
    pauseOpts = {};
    if (batches.length === 0) return;
    if (mode === "temporal") drainBatchesTemporal(batches);
    else drainBatchesInstant(batches);
  }

  function applyInternal(ops: readonly Op[], options?: ApplyOptions): void {
    if (ops.length === 0) return;
    const mode = options?.mode ?? defaultMode;

    const { oracles, triggers } = partitionOps(ops);

    // Oracles populate queues synchronously regardless of mode.
    // Their ts is irrelevant — order among oracles is preserved by
    // partition's stable sort, and they must precede their triggers.
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
    if (temporalDrainTimer) {
      origClearTimeout.call(globalThis, temporalDrainTimer);
      temporalDrainTimer = null;
    }
    pendingBatches.length = 0;
    paused = false;
    pauseOpts = {};
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

  return {
    apply,
    pause,
    step,
    resume,
    get paused() { return paused; },
    destroy,
  };
}
