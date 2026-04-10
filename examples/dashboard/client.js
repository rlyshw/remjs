import { connect } from "/_shared/client.js";
import { createInspector } from "/_shared/inspector.js";

const inspector = createInspector(document.getElementById("inspector"));

const $cpu = document.getElementById("cpu");
const $mem = document.getElementById("memory");
const $rps = document.getElementById("rps");
const $errors = document.getElementById("errors");
const $services = document.getElementById("services");
const $events = document.getElementById("events");
const $meta = document.getElementById("meta");
const $spark = document.getElementById("spark");
const ctx = $spark.getContext("2d");

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

function render(state) {
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

connect({
  onChange: render,
  onMessage: (msg) => inspector.onMessage(msg),
});
