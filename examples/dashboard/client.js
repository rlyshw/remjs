import { connect } from "/_shared/client.js";

const $cpu = document.getElementById("cpu");
const $mem = document.getElementById("memory");
const $rps = document.getElementById("rps");
const $errors = document.getElementById("errors");
const $services = document.getElementById("services");
const $events = document.getElementById("events");
const $meta = document.getElementById("meta");
const $spark = document.getElementById("spark");
const ctx = $spark.getContext("2d");

/* ── App state (local, identical on every tab via event replay) ── */

const state = {
  startedAt: Date.now(),
  tick: 0,
  metrics: { cpu: 50, memory: 40, requestsPerSec: 200, errors: 0 },
  history: [],
  services: {
    api: { status: "healthy", latencyMs: 20 },
    db: { status: "healthy", latencyMs: 5 },
    cache: { status: "healthy", latencyMs: 1 },
  },
  events: [],
};

const STATUSES = ["healthy", "degraded", "down"];

function randomWalk(value, min, max, step) {
  const next = value + (Math.random() - 0.5) * step * 2;
  return Math.max(min, Math.min(max, next));
}

/* ── Simulation loop (runs on every tab, deterministic via replay) ── */

setInterval(() => {
  state.tick++;
  state.metrics.cpu = Math.round(randomWalk(state.metrics.cpu, 10, 95, 8));
  state.metrics.memory = Math.round(randomWalk(state.metrics.memory, 20, 85, 4));
  state.metrics.requestsPerSec = Math.round(
    randomWalk(state.metrics.requestsPerSec, 50, 500, 40),
  );

  state.history.push(state.metrics.cpu);
  if (state.history.length > 60) state.history.shift();

  if (Math.random() < 0.04) {
    const names = Object.keys(state.services);
    const name = names[Math.floor(Math.random() * names.length)];
    const prev = state.services[name].status;
    const next = STATUSES[Math.floor(Math.random() * STATUSES.length)];
    state.services[name].status = next;
    state.services[name].latencyMs = Math.round(
      5 + Math.random() * (next === "healthy" ? 25 : 500),
    );
    if (prev !== next) {
      state.events.push({ t: Date.now(), msg: `${name}: ${prev} → ${next}` });
      if (next !== "healthy") state.metrics.errors++;
      if (state.events.length > 20) state.events.shift();
    }
  }

  render();
}, 1500);

/* ── Render ──────────────────────────────────────────────────── */

function fmtTime(t) {
  return new Date(t).toISOString().slice(11, 19);
}

function drawSpark(history) {
  const w = $spark.width;
  const h = $spark.height;
  ctx.clearRect(0, 0, w, h);
  if (!history.length) return;
  ctx.strokeStyle = "#4a8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  const max = 100;
  const step = w / Math.max(history.length - 1, 1);
  history.forEach((v, i) => {
    const x = i * step;
    const y = h - (v / max) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function render() {
  $cpu.innerHTML = `${state.metrics.cpu}<span class="unit">%</span>`;
  $mem.innerHTML = `${state.metrics.memory}<span class="unit">%</span>`;
  $rps.textContent = state.metrics.requestsPerSec;
  $errors.textContent = state.metrics.errors;

  drawSpark(state.history);

  $services.innerHTML = Object.entries(state.services)
    .map(
      ([name, svc]) => `
      <div class="service-row">
        <div><span class="dot ${svc.status}"></span>${name}</div>
        <div>${svc.latencyMs} ms · ${svc.status}</div>
      </div>`,
    )
    .join("");

  $events.innerHTML = state.events
    .slice()
    .reverse()
    .map((e) => `<div class="row"><span class="t">${fmtTime(e.t)}</span>${e.msg}</div>`)
    .join("");

  const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
  $meta.textContent = `tick ${state.tick} · uptime ${uptime}s`;
}

/* ── Connect: recorder captures timer/random/clock, player replays ── */

connect({
  onOps: () => render(),
  recorderOptions: {
    events: false,   // no DOM events needed
    network: false,
    storage: false,
  },
});

render();
