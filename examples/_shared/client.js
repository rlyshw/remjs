/**
 * Shared browser-side client helper.
 *
 * Connects to the demo server, receives a snapshot, then:
 *   - Wraps local state with createStateStream so UI-driven mutations turn
 *     into ops and get shipped to the server.
 *   - Applies remote ops from the server directly to the raw state (bypass
 *     the proxy to avoid re-emitting them).
 *
 * Calls `onChange` on every state update (local or remote) so the UI can
 * re-render.
 */

import { createStateStream, applyOps } from "/lib/index.js";

export function connect({ onChange }) {
  const ws = new WebSocket(`ws://${location.host}`);
  let rawState = null;
  let proxy = null;
  let ready = false;

  const readyPromise = new Promise((resolve) => {
    ws.addEventListener("message", function onMsg(ev) {
      const msg = JSON.parse(ev.data);
      if (msg.type === "snapshot") {
        rawState = applyOps(null, [msg.op]);
        const stream = createStateStream(rawState, {
          onOps: (ops) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "ops", ops }));
            }
            onChange(rawState);
          },
          batch: "microtask",
        });
        proxy = stream.state;
        ready = true;
        ws.removeEventListener("message", onMsg);
        onChange(rawState);
        resolve({ state: proxy, raw: rawState });
      }
    });
  });

  ws.addEventListener("message", (ev) => {
    if (!ready) return;
    const msg = JSON.parse(ev.data);
    if (msg.type === "ops") {
      applyOps(rawState, msg.ops);
      onChange(rawState);
    }
  });

  return readyPromise;
}
