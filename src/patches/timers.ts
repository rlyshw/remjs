/**
 * Timer patch — intercepts setTimeout, setInterval, rAF, rIC.
 *
 * Assigns monotonic sequence numbers so leader and follower can match
 * timer callbacks without sharing raw browser timer IDs (which differ
 * across runtimes). Records a TimerOp when the callback fires.
 */

import type { TimerOp } from "../ops.js";

export type Emit = (op: TimerOp) => void;

/** Union of all callback shapes that can be stored in the timer map. */
type TimerCallback = ((...args: unknown[]) => void) | FrameRequestCallback | IdleRequestCallback;

export interface TimerPatchState {
  seqMap: Map<number, number>;               // rawId → seq
  callbackMap: Map<number, TimerCallback>;   // seq → original callback
  nextSeq: number;
}

export function installTimerPatch(emit: Emit): { uninstall: () => void; state: TimerPatchState } {
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  const origClearTimeout = globalThis.clearTimeout;
  const origClearInterval = globalThis.clearInterval;
  const origRAF = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  const origCAF = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null;
  const origRIC = typeof (globalThis as any).requestIdleCallback === "function" ? (globalThis as any).requestIdleCallback : null;
  const origCIC = typeof (globalThis as any).cancelIdleCallback === "function" ? (globalThis as any).cancelIdleCallback : null;

  const patchState: TimerPatchState = {
    seqMap: new Map(),
    callbackMap: new Map(),
    nextSeq: 0,
  };

  function clearEntry(rawId: number, seq: number): void {
    patchState.seqMap.delete(rawId);
    patchState.callbackMap.delete(seq);
  }

  function makeClearFn(orig: (id?: number) => void): (id?: number) => void {
    return function (id?: number): void {
      if (id !== undefined) {
        const seq = patchState.seqMap.get(id);
        if (seq !== undefined) clearEntry(id, seq);
      }
      orig.call(globalThis, id);
    };
  }

  globalThis.setTimeout = function (callback: TimerHandler, delay?: number, ...args: unknown[]): number {
    const seq = patchState.nextSeq++;
    const fn: TimerCallback = typeof callback === "string" ? () => eval(callback) : (callback as TimerCallback);

    const rawId = origSetTimeout.call(globalThis, (...cbArgs: unknown[]) => {
      clearEntry(rawId, seq);
      emit({
        type: "timer",
        kind: "timeout",
        seq,
        scheduledDelay: delay ?? 0,
        actualTime: Date.now(),
      });
      (fn as (...cbArgs: unknown[]) => void)(...cbArgs);
    }, delay, ...args) as unknown as number;

    patchState.seqMap.set(rawId, seq);
    patchState.callbackMap.set(seq, fn);
    return rawId;
  } as typeof globalThis.setTimeout;

  globalThis.setInterval = function (callback: TimerHandler, delay?: number, ...args: unknown[]): number {
    const seq = patchState.nextSeq++;
    const fn: TimerCallback = typeof callback === "string" ? () => eval(callback) : (callback as TimerCallback);

    const rawId = origSetInterval.call(globalThis, (...cbArgs: unknown[]) => {
      emit({
        type: "timer",
        kind: "interval",
        seq,
        scheduledDelay: delay ?? 0,
        actualTime: Date.now(),
      });
      (fn as (...cbArgs: unknown[]) => void)(...cbArgs);
    }, delay, ...args) as unknown as number;

    patchState.seqMap.set(rawId, seq);
    patchState.callbackMap.set(seq, fn);
    return rawId;
  } as typeof globalThis.setInterval;

  globalThis.clearTimeout = makeClearFn(origClearTimeout) as typeof globalThis.clearTimeout;
  globalThis.clearInterval = makeClearFn(origClearInterval) as typeof globalThis.clearInterval;

  if (origRAF) {
    (globalThis as any).requestAnimationFrame = function (callback: FrameRequestCallback): number {
      const seq = patchState.nextSeq++;
      const rawId = origRAF.call(globalThis, (ts: number) => {
        clearEntry(rawId, seq);
        emit({
          type: "timer",
          kind: "raf",
          seq,
          scheduledDelay: 0,
          actualTime: ts,
        });
        callback(ts);
      }) as unknown as number;
      patchState.seqMap.set(rawId, seq);
      patchState.callbackMap.set(seq, callback);
      return rawId;
    };

    (globalThis as any).cancelAnimationFrame = function (id: number): void {
      const seq = patchState.seqMap.get(id);
      if (seq !== undefined) clearEntry(id, seq);
      origCAF!.call(globalThis, id);
    };
  }

  if (origRIC) {
    (globalThis as any).requestIdleCallback = function (callback: IdleRequestCallback, opts?: IdleRequestOptions): number {
      const seq = patchState.nextSeq++;
      const rawId = origRIC.call(globalThis, (deadline: IdleDeadline) => {
        clearEntry(rawId, seq);
        emit({
          type: "timer",
          kind: "idle",
          seq,
          scheduledDelay: 0,
          actualTime: Date.now(),
        });
        callback(deadline);
      }, opts) as unknown as number;
      patchState.seqMap.set(rawId, seq);
      patchState.callbackMap.set(seq, callback);
      return rawId;
    };

    (globalThis as any).cancelIdleCallback = function (id: number): void {
      const seq = patchState.seqMap.get(id);
      if (seq !== undefined) clearEntry(id, seq);
      origCIC!.call(globalThis, id);
    };
  }

  function uninstall() {
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    globalThis.clearTimeout = origClearTimeout;
    globalThis.clearInterval = origClearInterval;
    if (origRAF) (globalThis as any).requestAnimationFrame = origRAF;
    if (origCAF) (globalThis as any).cancelAnimationFrame = origCAF;
    if (origRIC) (globalThis as any).requestIdleCallback = origRIC;
    if (origCIC) (globalThis as any).cancelIdleCallback = origCIC;
    patchState.seqMap.clear();
    patchState.callbackMap.clear();
  }

  return { uninstall, state: patchState };
}
