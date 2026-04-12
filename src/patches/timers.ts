/**
 * Timer patch — intercepts setTimeout, setInterval, clearTimeout, clearInterval.
 *
 * Assigns monotonic sequence numbers so leader and follower can match
 * timer registrations without sharing raw browser timer IDs.
 * Records a TimerOp when the callback actually fires.
 *
 * requestAnimationFrame is browser-only; skipped in this patch (added
 * in the events patch or a browser-specific extension).
 */

import type { TimerOp } from "../ops.js";

export type Emit = (op: TimerOp) => void;

export interface TimerPatchState {
  seqMap: Map<number, number>;       // rawId → seq
  callbackMap: Map<number, Function>; // seq → original callback
  nextSeq: number;
}

export function installTimerPatch(emit: Emit): { uninstall: () => void; state: TimerPatchState } {
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  const origClearTimeout = globalThis.clearTimeout;
  const origClearInterval = globalThis.clearInterval;

  const patchState: TimerPatchState = {
    seqMap: new Map(),
    callbackMap: new Map(),
    nextSeq: 0,
  };

  globalThis.setTimeout = function (callback: Function | string, delay?: number, ...args: unknown[]): number {
    const seq = patchState.nextSeq++;
    const fn = typeof callback === "string" ? () => eval(callback) : callback;

    const rawId = origSetTimeout.call(globalThis, (...cbArgs: unknown[]) => {
      patchState.seqMap.delete(rawId);
      patchState.callbackMap.delete(seq);
      emit({
        type: "timer",
        kind: "timeout",
        seq,
        scheduledDelay: delay ?? 0,
        actualTime: Date.now(),
      });
      fn(...cbArgs);
    }, delay, ...args) as unknown as number;

    patchState.seqMap.set(rawId, seq);
    patchState.callbackMap.set(seq, fn);
    return rawId;
  } as typeof globalThis.setTimeout;

  globalThis.setInterval = function (callback: Function | string, delay?: number, ...args: unknown[]): number {
    const seq = patchState.nextSeq++;
    const fn = typeof callback === "string" ? () => eval(callback) : callback;

    const rawId = origSetInterval.call(globalThis, (...cbArgs: unknown[]) => {
      emit({
        type: "timer",
        kind: "interval",
        seq,
        scheduledDelay: delay ?? 0,
        actualTime: Date.now(),
      });
      fn(...cbArgs);
    }, delay, ...args) as unknown as number;

    patchState.seqMap.set(rawId, seq);
    patchState.callbackMap.set(seq, fn);
    return rawId;
  } as typeof globalThis.setInterval;

  globalThis.clearTimeout = function (id?: number): void {
    if (id !== undefined) {
      const seq = patchState.seqMap.get(id);
      if (seq !== undefined) {
        patchState.seqMap.delete(id);
        patchState.callbackMap.delete(seq);
      }
    }
    origClearTimeout.call(globalThis, id);
  } as typeof globalThis.clearTimeout;

  globalThis.clearInterval = function (id?: number): void {
    if (id !== undefined) {
      const seq = patchState.seqMap.get(id);
      if (seq !== undefined) {
        patchState.seqMap.delete(id);
        patchState.callbackMap.delete(seq);
      }
    }
    origClearInterval.call(globalThis, id);
  } as typeof globalThis.clearInterval;

  function uninstall() {
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    globalThis.clearTimeout = origClearTimeout;
    globalThis.clearInterval = origClearInterval;
    patchState.seqMap.clear();
    patchState.callbackMap.clear();
  }

  return { uninstall, state: patchState };
}
