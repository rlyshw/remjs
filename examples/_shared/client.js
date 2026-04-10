/**
 * Shared browser-side client helper.
 *
 * Connects to the demo server, receives a snapshot, then sets up a
 * single shared registry that's used by BOTH:
 *   - a `createReceiver` for incoming server ops (mutates raw objects
 *     directly via registry lookup, no echo)
 *   - a `createObserver` for outgoing local ops (proxy traps capture
 *     user-driven mutations and ship them back over the WebSocket)
 *
 * Sharing the registry between observer and receiver is what makes
 * bidirectional sync work — both sides agree on the same id space, so
 * a server-introduced object id can be referenced by a client mutation
 * and vice versa.
 *
 * `onChange` fires on every state update (local or remote) so the UI
 * can re-render.
 */

import {
  createObserver,
  createReceiver,
  applyOps,
} from "/lib/index.js";

export function connect({ onChange, onMessage }) {
  const ws = new WebSocket(`ws://${location.host}`);
  let receiver = null;
  let observer = null;
  let proxy = null;
  let ready = false;

  const readyPromise = new Promise((resolve) => {
    ws.addEventListener("message", function onMsg(ev) {
      const msg = JSON.parse(ev.data);
      // Forward every raw message to the optional callback so debug
      // panes (e.g. the state inspector) can mirror the same op stream
      // without opening a second WebSocket.
      if (onMessage) onMessage(msg);
      if (msg.type === "snapshot") {
        receiver = createReceiver();
        receiver.apply([msg.op]);
        observer = createObserver({
          onOps: (ops) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "ops", ops }));
            }
            // Locally-emitted ops also go to the inspector so the demo's
            // own mutations are visualized in the same pane.
            if (onMessage) onMessage({ type: "ops", ops });
            onChange(receiver.state);
          },
          batchMode: "microtask",
          registry: receiver.registry,
        });
        proxy = observer.track(receiver.state);
        ready = true;
        ws.removeEventListener("message", onMsg);
        onChange(receiver.state);
        resolve({ state: proxy, raw: receiver.state });
      }
    });
  });

  ws.addEventListener("message", (ev) => {
    if (!ready) return;
    const msg = JSON.parse(ev.data);
    if (onMessage) onMessage(msg);
    if (msg.type === "ops") {
      applyOps(null, msg.ops, receiver.registry);
      onChange(receiver.state);
    }
  });

  return readyPromise;
}
