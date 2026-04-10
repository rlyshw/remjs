/**
 * Shared WebSocket session helper.
 *
 * Wraps a state object with `createObserver` on the server. New clients
 * receive a snapshot on connect, and any server-side mutations are fanned
 * out. Clients can also push ops back — those go through `applyOps`
 * with the observer's own registry, which mutates the underlying raw
 * objects directly (bypassing the proxy traps so we don't echo).
 */

import { WebSocketServer } from "ws";
import { createObserver, applyOps } from "../../dist/index.js";

export function createSession(rawState, server) {
  const subscribers = new Set();

  const observer = createObserver({
    onOps: (ops) => broadcast({ type: "ops", ops }),
    batchMode: "microtask",
  });
  // Tracking returns a proxy that emits ops on mutation. Server code that
  // mutates state should go through this `state`, not the raw object,
  // so its mutations are captured.
  const state = observer.track(rawState);

  function broadcast(msg, except = null) {
    const payload = JSON.stringify(msg);
    for (const ws of subscribers) {
      if (ws !== except && ws.readyState === 1) ws.send(payload);
    }
  }

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    subscribers.add(ws);
    observer.flush();
    ws.send(JSON.stringify({ type: "snapshot", op: observer.snapshot() }));

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "ops" && Array.isArray(msg.ops)) {
        // Apply via the observer's registry. Ops mutate the raw objects
        // directly (no proxy traps fire), so the client's mutation
        // doesn't echo back through the observer's onOps.
        applyOps(null, msg.ops, observer.registry);
        broadcast({ type: "ops", ops: msg.ops }, ws);
      }
    });

    ws.on("close", () => subscribers.delete(ws));
  });

  return {
    state,
    raw: rawState,
    broadcast,
    subscribers,
    observer,
  };
}
