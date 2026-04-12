/**
 * Clock patch — intercepts Date.now() and performance.now().
 *
 * Records the actual value returned so replicas produce identical
 * timestamps without needing synchronized clocks.
 */

import type { ClockOp } from "../ops.js";

export type Emit = (op: ClockOp) => void;

export function installClockPatch(emit: Emit): () => void {
  const origDateNow = Date.now;
  const origPerfNow =
    typeof performance !== "undefined" ? performance.now.bind(performance) : null;

  Date.now = function () {
    const value = origDateNow.call(Date);
    emit({ type: "clock", source: "dateNow", value });
    return value;
  };

  if (origPerfNow && typeof performance !== "undefined") {
    performance.now = function () {
      const value = origPerfNow();
      emit({ type: "clock", source: "performanceNow", value });
      return value;
    };
  }

  return function uninstall() {
    Date.now = origDateNow;
    if (origPerfNow && typeof performance !== "undefined") {
      performance.now = origPerfNow;
    }
  };
}
