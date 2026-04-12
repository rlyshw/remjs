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

export type BatchMode = "raf" | "microtask" | "sync";

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
    batchMode = "microtask",
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
    } else {
      queueMicrotask(flush);
    }
  };

  const emit = (op: Op): void => {
    if (!running) return;
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
    // Event patch requires DOM — install only if EventTarget exists
    if (enableEvents && typeof EventTarget !== "undefined") {
      import("./patches/events.js").then(({ installEventPatch }) => {
        if (running) {
          uninstallers.push(installEventPatch(emit));
        }
      });
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
