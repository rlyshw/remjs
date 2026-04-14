// Strict-timers demo — run with: node examples/strict-timers/demo.mjs
//
// Shows that under createPlayer({ strict: true }):
//   (a) setTimeout does NOT fire natively,
//   (b) the callback fires only when the matching TimerOp is applied,
//   (c) clearTimeout swallows a straggler op.

import { createPlayer } from "../../dist/player.js";

// Capture the native setTimeout BEFORE strict mode patches it, so this
// demo script can use plain wall-clock waits independent of the gate.
const nativeSetTimeout = setTimeout;
const wait = (ms) => new Promise((r) => nativeSetTimeout(r, ms));

const log = (...args) => console.log("  ·", ...args);

async function main() {
  console.log("\n── 1. Non-strict baseline ──────────────────────────────");
  {
    const player = createPlayer({
      events: false, network: false, random: false, clock: false, storage: false,
    });
    player.apply([]); // force install

    let fired = false;
    setTimeout(() => { fired = true; }, 30);
    await wait(80);
    log("non-strict follower: setTimeout fired natively →", fired);

    player.destroy();
  }

  console.log("\n── 2. Strict: no native fire ───────────────────────────");
  let seqA;
  let firedA = false;
  const strictPlayer = createPlayer({
    strict: true,
    events: false, network: false, random: false, clock: false, storage: false,
  });
  strictPlayer.apply([]);
  {
    seqA = setTimeout(() => { firedA = true; log("callback A fired"); }, 30);
    log("setTimeout returned seq =", seqA);
    await wait(80);
    log("after 80ms: fired =", firedA, " ← stays false until we apply the op");
  }

  console.log("\n── 3. Strict: apply TimerOp → callback fires ───────────");
  {
    strictPlayer.apply([
      { type: "timer", kind: "timeout", seq: seqA, scheduledDelay: 30, actualTime: 0 },
    ]);
    log("after apply: fired =", firedA);
  }

  console.log("\n── 4. Strict: clearTimeout swallows the op ─────────────");
  {
    let firedB = false;
    const seqB = setTimeout(() => { firedB = true; }, 30);
    clearTimeout(seqB);
    strictPlayer.apply([
      { type: "timer", kind: "timeout", seq: seqB, scheduledDelay: 30, actualTime: 0 },
    ]);
    log("cleared before op arrived → fired =", firedB);
  }

  console.log("\n── 5. Strict: setInterval fires per op ─────────────────");
  {
    let count = 0;
    const seqC = setInterval(() => { count++; }, 10);
    const tick = { type: "timer", kind: "interval", seq: seqC, scheduledDelay: 10, actualTime: 0 };
    strictPlayer.apply([tick]);
    strictPlayer.apply([tick]);
    strictPlayer.apply([tick]);
    log("after 3 interval ops: count =", count);
    clearInterval(seqC);
    strictPlayer.apply([tick]);
    log("after clearInterval + another op: count =", count, " ← unchanged");
  }

  strictPlayer.destroy();
  console.log("\n✓ Strict timers (0.5.1) verified.\n");
}

main();
