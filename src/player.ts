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

export interface Player {
  apply(ops: readonly Op[]): void;
  destroy(): void;
}

export function createPlayer(options: PlayerOptions = {}): Player {
  const {
    mode = "temporal",
    events: enableEvents = true,
    timers: enableTimers = true,
    network: enableNetwork = true,
    random: enableRandom = true,
    clock: enableClock = true,
    storage: enableStorage = true,
  } = options;

  // Queues for deterministic value replay
  const randomQueue: number[] = [];
  const clockQueue: number[] = [];
  const fetchQueue: Map<number, { resolve: (r: Response) => void; op: NetworkOp }> = new Map();

  // Temporal replay state
  const pendingTimers: ReturnType<typeof setTimeout>[] = [];
  let baseTs: number | null = null; // first op's ts in current batch
  let baseNow: number | null = null; // wall time when we started replaying

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
      globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        for (const [seq, entry] of fetchQueue) {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
          if (entry.op.url === url) {
            fetchQueue.delete(seq);
            return new Response(entry.op.body, {
              status: entry.op.status ?? 200,
              headers: entry.op.headers ?? {},
            });
          }
        }
        return origFetch.call(globalThis, input, init);
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
    } else if (op.eventType === "input" || op.eventType === "change") {
      if ("value" in d && "value" in target) {
        (target as HTMLInputElement).value = d.value as string;
      }
      event = new Event(op.eventType, { bubbles: true, cancelable: true });
    } else {
      event = new Event(op.eventType, { bubbles: true, cancelable: true });
    }

    target.dispatchEvent(event);
  }

  function applyNetwork(op: NetworkOp): void {
    if (!enableNetwork) return;
    fetchQueue.set(op.seq, { resolve: () => {}, op });
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

  function apply(ops: readonly Op[]): void {
    install();

    if (mode === "instant" || ops.length === 0) {
      for (const op of ops) applyOp(op);
      return;
    }

    // Temporal replay: schedule each op at its original relative time
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();

    // Find the earliest ts in this batch as the reference point
    let minTs = Infinity;
    for (const op of ops) {
      if (op.ts !== undefined && op.ts < minTs) minTs = op.ts;
    }

    // If no timestamps, fall back to instant
    if (minTs === Infinity) {
      for (const op of ops) applyOp(op);
      return;
    }

    for (const op of ops) {
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
    fetchQueue.clear();
  }

  return { apply, destroy };
}
