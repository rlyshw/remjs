/**
 * Player — replays event loop ops on a follower runtime.
 *
 * Monkey-patches globals on the follower so that Math.random(),
 * Date.now(), fetch(), etc. return recorded values. DOM events
 * are dispatched to the correct elements via CSS selector paths.
 */

import type { Op, EventOp, TimerOp, NetworkOp, RandomOp, ClockOp, StorageOp, SnapshotOp } from "./ops.js";

export interface PlayerOptions {
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
        // Check if we have a queued response for this request
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
        // No recorded response — fall through to real fetch
        return origFetch.call(globalThis, input, init);
      } as typeof globalThis.fetch;
    }
  }

  function applyEvent(op: EventOp): void {
    if (!enableEvents) return;
    if (typeof document === "undefined") return;

    const target = document.querySelector(op.targetPath);
    if (!target) return;

    let event: Event;
    const d = op.detail;

    if (op.eventType.startsWith("mouse") || op.eventType === "click" || op.eventType === "dblclick") {
      event = new MouseEvent(op.eventType, {
        bubbles: true,
        cancelable: true,
        clientX: d.clientX as number,
        clientY: d.clientY as number,
        button: d.button as number,
      });
    } else if (op.eventType.startsWith("key")) {
      event = new KeyboardEvent(op.eventType, {
        bubbles: true,
        cancelable: true,
        key: d.key as string,
        code: d.code as string,
        altKey: d.altKey as boolean,
        ctrlKey: d.ctrlKey as boolean,
        shiftKey: d.shiftKey as boolean,
        metaKey: d.metaKey as boolean,
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

  function applyTimer(_op: TimerOp): void {
    // Timer replay: the follower's code registered the same timers
    // in the same order. When a TimerOp arrives, we just let the
    // follower's native timer fire naturally — the seq numbers
    // ensure ordering consistency. For more precise control, the
    // timer patch on the follower side would intercept and fire
    // callbacks by seq. This is deferred to a future refinement.
  }

  function applyNetwork(op: NetworkOp): void {
    if (!enableNetwork) return;
    fetchQueue.set(op.seq, {
      resolve: () => {},
      op,
    });
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

    if (op.action === "set" && op.value !== null) {
      storage.setItem(op.key, op.value);
    } else if (op.action === "remove") {
      storage.removeItem(op.key);
    }
    // "get" ops are informational — no action needed on replay
  }

  function applySnapshot(op: SnapshotOp): void {
    if (typeof document === "undefined") return;
    document.documentElement.innerHTML = op.html;
  }

  function apply(ops: readonly Op[]): void {
    install();
    for (const op of ops) {
      switch (op.type) {
        case "event": applyEvent(op); break;
        case "timer": applyTimer(op); break;
        case "network": applyNetwork(op); break;
        case "random": applyRandom(op); break;
        case "clock": applyClock(op); break;
        case "storage": applyStorage(op); break;
        case "snapshot": applySnapshot(op); break;
        case "navigation": break; // deferred
      }
    }
  }

  function destroy(): void {
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
