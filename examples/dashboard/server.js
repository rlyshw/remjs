/**
 * Dashboard demo — the server owns the state and streams live metric
 * updates to all connected clients. Clients are read-only in this demo;
 * all mutations happen server-side through the proxied state.
 *
 * This exercises the server → client direction and shows how small deltas
 * (a single number changed on a nested object) turn into single ops.
 */

import { createStaticServer } from "../_shared/static-server.js";
import { createSession } from "../_shared/session.js";

const server = createStaticServer(import.meta.url);

const state = {
  startedAt: Date.now(),
  tick: 0,
  metrics: {
    cpu: 0,
    memory: 0,
    requestsPerSec: 0,
    errors: 0,
  },
  history: [], // last 60 samples of cpu
  services: {
    api: { status: "healthy", latencyMs: 20 },
    db: { status: "healthy", latencyMs: 5 },
    cache: { status: "healthy", latencyMs: 1 },
  },
  events: [],
};

const session = createSession(state, server);
// Mutate through the proxy so ops stream automatically.
const live = session.state;

const STATUSES = ["healthy", "degraded", "down"];

function randomWalk(value, min, max, step) {
  const next = value + (Math.random() - 0.5) * step * 2;
  return Math.max(min, Math.min(max, next));
}

setInterval(() => {
  live.tick++;

  live.metrics.cpu = Math.round(randomWalk(live.metrics.cpu, 10, 95, 8));
  live.metrics.memory = Math.round(randomWalk(live.metrics.memory, 20, 85, 4));
  live.metrics.requestsPerSec = Math.round(
    randomWalk(live.metrics.requestsPerSec, 50, 500, 40),
  );

  live.history.push(live.metrics.cpu);
  if (live.history.length > 60) live.history.shift();

  // Occasional service status flap
  if (Math.random() < 0.04) {
    const names = Object.keys(live.services);
    const name = names[Math.floor(Math.random() * names.length)];
    const prev = live.services[name].status;
    const next = STATUSES[Math.floor(Math.random() * STATUSES.length)];
    live.services[name].status = next;
    live.services[name].latencyMs = Math.round(
      5 + Math.random() * (next === "healthy" ? 25 : 500),
    );
    if (prev !== next) {
      live.events.push({
        t: Date.now(),
        msg: `${name}: ${prev} → ${next}`,
      });
      if (next !== "healthy") live.metrics.errors++;
      if (live.events.length > 20) live.events.shift();
    }
  }
}, 1500);

const PORT = 7403;
server.listen(PORT, () => {
  console.log(`remjs dashboard demo → http://localhost:${PORT}`);
});
