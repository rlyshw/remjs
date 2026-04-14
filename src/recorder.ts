/**
 * Recorder — captures event loop inputs as ops.
 *
 * Installs monkey-patches on enabled subsystems (events, timers,
 * network, random, clock, storage), batches emitted ops, and
 * delivers them via the onOps callback.
 */

import type { Op, SnapshotOp } from "./ops.js";
import { installClockPatch } from "./patches/clock.js";
import { installRandomPatch } from "./patches/random.js";
import { installTimerPatch } from "./patches/timers.js";
import { installNetworkPatch } from "./patches/network.js";
import { installStoragePatch } from "./patches/storage.js";
import { installEventPatch } from "./patches/events.js";

/**
 * When to flush emitted ops to `onOps`.
 *
 * - `"task"` (default): flush at the next event loop task boundary via
 *   `setTimeout(fn, 0)`. All ops emitted within one task — including
 *   those emitted during its microtask drain (await resumptions,
 *   .then callbacks) — land in one batch. Required for deterministic
 *   async handler replay.
 * - `"microtask"`: flush at the next microtask. Lower latency, but
 *   splits async handlers across batches. Correct only for sync
 *   handlers.
 * - `"raf"`: flush on requestAnimationFrame. For UI-paced callers.
 * - `"sync"`: flush every emit immediately. For tests / debugging.
 */
export type BatchMode = "task" | "raf" | "microtask" | "sync";

export interface RecorderOptions {
  onOps: (ops: Op[]) => void;
  batchMode?: BatchMode;
  events?: boolean;
  timers?: boolean;
  network?: boolean;
  random?: boolean;
  clock?: boolean;
  storage?: boolean;
}

export interface Recorder {
  start(): void;
  stop(): void;
  snapshot(): SnapshotOp;
  destroy(): void;
}

export function createRecorder(options: RecorderOptions): Recorder {
  const {
    onOps,
    batchMode = "task",
    events: enableEvents = true,
    timers: enableTimers = true,
    network: enableNetwork = true,
    random: enableRandom = true,
    clock: enableClock = true,
    storage: enableStorage = true,
  } = options;

  let pending: Op[] = [];
  let scheduled = false;
  let running = false;
  const uninstallers: Array<() => void> = [];

  const flush = (): void => {
    scheduled = false;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    onOps(batch);
  };

  const schedule = (): void => {
    if (scheduled || !running) return;
    scheduled = true;
    if (batchMode === "sync") {
      flush();
    } else if (batchMode === "raf" && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else if (batchMode === "microtask") {
      queueMicrotask(flush);
    } else {
      // "task" — setTimeout(fn, 0) schedules a new task per HTML spec,
      // which runs after the current task's microtask checkpoint.
      setTimeout(flush, 0);
    }
  };

  // Capture the ORIGINAL time functions BEFORE patches are installed,
  // so timestamping ops doesn't recurse through the clock patch.
  const origPerfNow = typeof performance !== "undefined"
    ? performance.now.bind(performance) : null;
  const origDateNow = Date.now;
  const getTime = origPerfNow ?? (() => origDateNow.call(Date));

  const emit = (op: Op): void => {
    if (!running) return;
    (op as { ts?: number }).ts = getTime();
    pending.push(op);
    schedule();
  };

  function start(): void {
    if (running) return;
    running = true;

    if (enableClock) {
      uninstallers.push(installClockPatch(emit));
    }
    if (enableRandom) {
      uninstallers.push(installRandomPatch(emit));
    }
    if (enableTimers) {
      const { uninstall } = installTimerPatch(emit);
      uninstallers.push(uninstall);
    }
    if (enableNetwork) {
      uninstallers.push(installNetworkPatch(emit));
    }
    if (enableStorage) {
      uninstallers.push(installStoragePatch(emit));
    }
    if (enableEvents && typeof EventTarget !== "undefined") {
      uninstallers.push(installEventPatch(emit));
    }
  }

  function stop(): void {
    if (!running) return;
    running = false;
    flush();
    for (const fn of uninstallers) fn();
    uninstallers.length = 0;
  }

  function snapshot(): SnapshotOp {
    return {
      type: "snapshot",
      html: typeof document !== "undefined" ? document.documentElement.outerHTML : "",
      url: typeof location !== "undefined" ? location.href : "",
      timestamp: Date.now(),
      pendingTimers: [],
      pendingNetwork: [],
    };
  }

  function destroy(): void {
    stop();
    pending = [];
  }

  return { start, stop, snapshot, destroy };
}
