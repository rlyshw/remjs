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

export type ReplayMode = "temporal" | "instant";

export interface PlayerOptions {
  mode?: ReplayMode;
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

  let installed = false;

  function install(): void {
    if (installed) return;
    installed = true;

    if (enableRandom) {
      Math.random = function (): number {
        if (randomQueue.length > 0) return randomQueue.shift()!;
        return origRandom();
      };
    }

    if (enableClock) {
      Date.now = function (): number {
        if (clockQueue.length > 0) return clockQueue.shift()!;
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
  }

  function applyOp(op: Op): void {
    switch (op.type) {
      case "event": applyEvent(op); break;
      case "timer": break; // let native timers fire
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
        const timer = setTimeout(() => applyOp(op), delay);
        pendingTimers.push(timer);
      }
    }
  }

  function destroy(): void {
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.length = 0;
    if (!installed) return;
    installed = false;
    Math.random = origRandom;
    Date.now = origDateNow;
    globalThis.fetch = origFetch;
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
