/**
 * Shared WebSocket session helper — v0.3 event loop replication.
 *
 * The server acts as a relay: it receives event ops from one client
 * and broadcasts them to all other clients. Each client runs the
 * same app code and replays received events to stay in sync.
 *
 * Optionally, the server can also be a "leader" that generates
 * events (e.g. timer-driven state updates in the dashboard demo).
 */

import { WebSocketServer } from "ws";

export function createSession(server) {
  const subscribers = new Set();
  let opLog = [];  // accumulated ops for late joiners

  function broadcast(msg, except = null) {
    const payload = JSON.stringify(msg);
    for (const ws of subscribers) {
      if (ws !== except && ws.readyState === 1) ws.send(payload);
    }
  }

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    subscribers.add(ws);

    // Send accumulated op history so late joiners can replay
    if (opLog.length > 0) {
      ws.send(JSON.stringify({ type: "ops", ops: opLog }));
    }

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "ops" && Array.isArray(msg.ops)) {
        // Store and relay to all OTHER clients
        opLog.push(...msg.ops);
        broadcast({ type: "ops", ops: msg.ops }, ws);
      }
    });

    ws.on("close", () => subscribers.delete(ws));
  });

  return {
    broadcast,
    subscribers,
    /** Push server-generated ops to all clients and the log. */
    emit(ops) {
      opLog.push(...ops);
      broadcast({ type: "ops", ops });
    },
    /** Reset the op log (e.g. on state reset). */
    reset() {
      opLog = [];
    },
  };
}
