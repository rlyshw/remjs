/**
 * Shared browser-side client helper — v0.3 event loop replication.
 *
 * Connects to the demo server. Sets up a recorder to capture local
 * event loop inputs (clicks, timers, random, clock) and sends them
 * to the server. Receives event ops from other clients via the server
 * and replays them locally via the player.
 *
 * `onOps` fires whenever ops are received from other clients, so
 * the demo can update its UI if needed.
 */

import { createRecorder, createPlayer, jsonCodec } from "/lib/index.js";

export function connect({ onOps, recorderOptions } = {}) {
  const ws = new WebSocket(`ws://${location.host}`);
  let replaying = false;

  const player = createPlayer();

  const recorder = createRecorder({
    onOps: (ops) => {
      if (replaying) return; // don't echo replayed events
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "ops", ops }));
      }
    },
    batchMode: "sync",
    ...recorderOptions,
  });

  ws.addEventListener("open", () => {
    recorder.start();
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "ops" && Array.isArray(msg.ops)) {
      replaying = true;
      player.apply(msg.ops);
      replaying = false;
      if (onOps) onOps(msg.ops);
    }
  });

  ws.addEventListener("close", () => {
    recorder.stop();
  });

  return { recorder, player, ws };
}
