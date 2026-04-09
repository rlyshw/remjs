/**
 * Shared WebSocket session helper.
 *
 * Wraps a state object with createStateStream on the server. New clients
 * receive a snapshot on connect, and any server-side mutations are fanned
 * out. Clients can also push ops back — those are applied to the raw state
 * (bypassing the proxy to avoid echoes) and then rebroadcast to other
 * clients.
 */

import { WebSocketServer } from "ws";
import { createStateStream, applyOps } from "../../dist/index.js";

export function createSession(rawState, server) {
  const subscribers = new Set();

  const stream = createStateStream(rawState, {
    onOps: (ops) => broadcast({ type: "ops", ops }),
    batch: "microtask",
  });

  function broadcast(msg, except = null) {
    const payload = JSON.stringify(msg);
    for (const ws of subscribers) {
      if (ws !== except && ws.readyState === 1) ws.send(payload);
    }
  }

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    subscribers.add(ws);
    stream.flush();
    ws.send(JSON.stringify({ type: "snapshot", op: stream.snapshot() }));

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "ops" && Array.isArray(msg.ops)) {
        // Apply directly to the raw state — this bypasses the proxy so we
        // don't echo the client's own ops back to them via onOps.
        applyOps(rawState, msg.ops);
        broadcast({ type: "ops", ops: msg.ops }, ws);
      }
    });

    ws.on("close", () => subscribers.delete(ws));
  });

  return {
    state: stream.state,
    raw: rawState,
    broadcast,
    subscribers,
  };
}
