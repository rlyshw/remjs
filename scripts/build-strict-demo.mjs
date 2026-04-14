/**
 * Build the standalone strict-timers demo HTML.
 *
 *   node scripts/build-strict-demo.mjs
 *
 * Produces docs/strict-timers.html with the remjs runtime bundled inline,
 * plus a side-by-side demo of a leader and two followers (strict vs
 * non-strict) on the same timer stream.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const SOURCES = [
  "ops.js", "codec.js", "patches/clock.js", "patches/random.js",
  "patches/timers.js", "patches/network.js", "patches/storage.js",
  "target.js", "patches/events.js", "recorder.js", "player.js",
];

function stripEsm(src) {
  return src
    .replace(/^\s*import\s[^;]*;\s*$/gm, "")
    .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
    .replace(/^\s*export\s+(function|const|let|var|class)\s/gm, "$1 ")
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, "");
}

async function buildBundle() {
  const parts = [];
  for (const name of SOURCES) {
    const src = await fs.readFile(path.join(DIST, name), "utf8");
    parts.push(stripEsm(src));
  }
  parts.push(`window.remjs = { createRecorder, createPlayer, jsonCodec };`);
  return `(function(){"use strict";\n${parts.join("\n")}\n})();`;
}

const HTML = (bundle) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>remjs · strict timers (0.5.1)</title>
<style>
  :root {
    --bg: #0d1017; --panel: #141924; --panel2: #0f1320; --ink: #e6edf3;
    --muted: #8b98a5; --dim: #5d6b7a; --accent: #6fa8dc; --ok: #7fcf73;
    --warn: #f0a04a; --bad: #e06767; --border: #2a3344; --hit: #f0c040;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink);
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px; }
  body { max-width: 1200px; margin: 0 auto; padding: 20px; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 16px; line-height: 1.5; }
  .sub code { background: #1a2030; padding: 1px 6px; border-radius: 4px; color: var(--accent);
    font-family: ui-monospace, monospace; font-size: 12px; }

  .controls { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  button { background: var(--panel); border: 1px solid var(--border); color: var(--ink);
    padding: 7px 14px; border-radius: 6px; font-size: 12px; cursor: pointer;
    font-family: inherit; transition: background 0.15s; }
  button:hover:not(:disabled) { background: #1a2030; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.primary { background: var(--accent); color: #0d1017; border-color: var(--accent); font-weight: 600; }
  button.primary:hover:not(:disabled) { background: #8fbbe0; }

  /* Channel strip */
  .channel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 16px; margin-bottom: 16px; display: flex; align-items: center; gap: 14px; }
  .channel.paused { border-color: var(--warn); }
  .channel-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); font-weight: 600; min-width: 90px; }
  .channel-inflight { flex: 1; font-family: ui-monospace, monospace; font-size: 12px;
    color: var(--dim); min-height: 20px; overflow: hidden; white-space: nowrap;
    text-overflow: ellipsis; }
  .channel-inflight .op-live { color: var(--accent); animation: flash 0.6s ease-out; }
  .channel.paused .channel-inflight { color: var(--warn); }
  @keyframes flash { 0% { color: var(--hit); } 100% { color: var(--accent); } }
  .channel-badge { background: #1a2030; border: 1px solid var(--border); border-radius: 4px;
    padding: 3px 10px; font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace;
    font-variant-numeric: tabular-nums; }
  .channel.paused .channel-badge { color: var(--warn); border-color: var(--warn); }

  /* Runtime panels */
  .panels { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 16px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px; display: flex; flex-direction: column; min-height: 320px; }
  .panel h2 { font-size: 12px; font-weight: 600; margin: 0 0 2px;
    letter-spacing: 0.04em; text-transform: uppercase; }
  .panel.leader h2 { color: var(--accent); }
  .panel.native h2 { color: var(--warn); }
  .panel.strict h2 { color: var(--ok); }
  .panel .role { font-size: 11px; color: var(--muted); margin-bottom: 10px;
    font-family: ui-monospace, monospace; }

  .section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--dim); font-weight: 600; margin: 10px 0 6px; }

  /* Registry table */
  .registry { background: var(--panel2); border: 1px solid var(--border); border-radius: 4px;
    font-family: ui-monospace, monospace; font-size: 11px; overflow: hidden;
    flex: 1; display: flex; flex-direction: column; }
  .registry-head, .registry-row { display: grid;
    grid-template-columns: 38px 62px 1fr 46px; gap: 8px; padding: 5px 8px; align-items: center; }
  .registry-head { background: #0a0e18; color: var(--dim); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); }
  .registry-row { border-bottom: 1px solid #1a2030; transition: background 0.3s; }
  .registry-row:last-child { border-bottom: none; }
  .registry-row.hit { background: rgba(240, 192, 64, 0.15); }
  .registry-row .seq { color: var(--accent); font-variant-numeric: tabular-nums; }
  .registry-row .kind { color: var(--ink); }
  .registry-row .cb { color: var(--muted); overflow: hidden; white-space: nowrap;
    text-overflow: ellipsis; }
  .registry-row .fires { color: var(--ok); text-align: right;
    font-variant-numeric: tabular-nums; font-weight: 600; }
  .registry-row.empty { color: var(--dim); font-style: italic;
    grid-template-columns: 1fr; padding: 12px; text-align: center; }
  .registry-footer { padding: 6px 8px; font-size: 10px; color: var(--dim);
    border-top: 1px solid var(--border); background: #0a0e18;
    display: flex; justify-content: space-between; }

  .note { font-size: 11px; color: var(--muted); margin-top: 8px; line-height: 1.5;
    padding: 8px 10px; background: #0a0e18; border-radius: 4px; border-left: 2px solid var(--border); }
  .panel.native .note { border-left-color: var(--warn); }
  .panel.strict .note { border-left-color: var(--ok); }
  .panel.leader .note { border-left-color: var(--accent); }

  /* Op log */
  .oplog-wrap { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px; }
  .oplog-wrap h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); font-weight: 600; margin: 0 0 8px; }
  .oplog { font-family: ui-monospace, monospace; font-size: 11px; height: 140px;
    overflow-y: auto; background: var(--panel2); border-radius: 4px; padding: 8px; }
  .oplog-entry { color: var(--muted); margin-bottom: 2px; }
  .oplog-entry .t { color: var(--accent); }
  .oplog-entry .seq-val { color: var(--hit); }
  .oplog-entry.dropped { color: var(--bad); text-decoration: line-through; }
  .oplog-entry.delivered-late { color: var(--ok); }
</style>
</head>
<body>
  <h1>Strict timers (remjs 0.5.1) — state machine view</h1>
  <p class="sub">
    Each runtime is a state machine. Its state here is the <strong>callback registry</strong>
    (seq → callback) plus the fire-count per slot. Below: leader's recorder registry,
    non-strict follower's registry (empty — it uses native timers), strict follower's
    registry (gated by ops). An op arriving at a runtime increments the matching slot's
    fire count. Pause the channel to see strict stop transitioning while non-strict keeps
    going on its own.
  </p>

  <div class="controls">
    <button id="start" class="primary">Start</button>
    <button id="pause" disabled>Pause channel</button>
    <button id="resume" disabled>Resume channel</button>
    <button id="stop" disabled>Stop</button>
  </div>

  <div class="channel" id="channel">
    <div class="channel-label">Op channel</div>
    <div class="channel-inflight" id="channel-inflight">—</div>
    <div class="channel-badge" id="channel-state">IDLE</div>
  </div>

  <div class="panels">
    <div class="panel leader">
      <h2>Leader runtime</h2>
      <div class="role">recorder — emits TimerOps</div>
      <div class="section-label">Recorder registry (seqMap)</div>
      <div class="registry" id="leader-reg">
        <div class="registry-head"><div>seq</div><div>kind</div><div>callback</div><div>fires</div></div>
        <div id="leader-reg-rows"></div>
        <div class="registry-footer">
          <span id="leader-reg-size">0 slots</span>
          <span id="leader-reg-emitted">0 emitted</span>
        </div>
      </div>
      <div class="note">Native setInterval/setTimeout fire; recorder stamps each fire with the slot's seq and emits a TimerOp.</div>
    </div>

    <div class="panel native">
      <h2>Follower A · non-strict</h2>
      <div class="role">createPlayer({})</div>
      <div class="section-label">Registry state</div>
      <div class="registry" id="native-reg">
        <div class="registry-head"><div>seq</div><div>kind</div><div>callback</div><div>fires</div></div>
        <div id="native-reg-rows"><div class="registry-row empty">no registry — native timers run underneath</div></div>
        <div class="registry-footer">
          <span id="native-counter">native fires: 0</span>
          <span id="native-received">0 ops received</span>
        </div>
      </div>
      <div class="note">Non-strict player doesn't patch timers. The follower's own native setInterval fires independently; incoming TimerOps are no-ops.</div>
    </div>

    <div class="panel strict">
      <h2>Follower B · strict</h2>
      <div class="role">createPlayer({ strict: true })</div>
      <div class="section-label">strictTimers map</div>
      <div class="registry" id="strict-reg">
        <div class="registry-head"><div>seq</div><div>kind</div><div>callback</div><div>fires</div></div>
        <div id="strict-reg-rows"></div>
        <div class="registry-footer">
          <span id="strict-reg-size">0 slots</span>
          <span id="strict-reg-applied">0 applied</span>
        </div>
      </div>
      <div class="note">setInterval/setTimeout register against a seq but never schedule native. Incoming TimerOp looks up its seq and invokes that callback; one-shots are deleted, intervals stay.</div>
    </div>
  </div>

  <div class="oplog-wrap">
    <h3>Op log (newest first) — <span id="oplog-legend" style="color: var(--muted); text-transform: none; letter-spacing: 0; font-weight: 400;">delivered · <span style="color: var(--bad);">dropped (channel paused)</span> · <span style="color: var(--ok);">delivered late</span></span></h3>
    <div class="oplog" id="oplog"></div>
  </div>

  <script>
${bundle}
  </script>

  <script>
(function () {
  const { createPlayer } = window.remjs;

  // Native timer APIs — captured before any player patches window globals.
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);

  const $ = (id) => document.getElementById(id);
  const leaderRegRows = $("leader-reg-rows"), leaderRegSize = $("leader-reg-size"),
        leaderRegEmitted = $("leader-reg-emitted");
  const strictRegRows = $("strict-reg-rows"), strictRegSize = $("strict-reg-size"),
        strictRegApplied = $("strict-reg-applied");
  const nativeCounter = $("native-counter"), nativeReceived = $("native-received");
  const channelEl = $("channel"), channelInflight = $("channel-inflight"),
        channelState = $("channel-state");
  const oplog = $("oplog");
  const startBtn = $("start"), pauseBtn = $("pause"),
        resumeBtn = $("resume"), stopBtn = $("stop");

  // ── Models of each runtime's registry ──────────────────────────────
  // We mirror the state each runtime holds internally. These objects are
  // the "state machine state" rendered in the UI.
  const leaderReg = new Map();    // seq → { kind, cbName, fires }
  const strictReg = new Map();    // seq → { kind, cbName, fires }
  let nativeFires = 0;
  let opsEmitted = 0;
  let opsApplied = 0;
  let opsReceived = 0;

  let nativePlayer = null, strictPlayer = null;
  let paused = false;
  let queued = [];
  let leaderTicks = [];   // native intervals driving the leader
  let nativeFollowerTicks = [];

  // ── UI rendering ───────────────────────────────────────────────────
  function renderRegistry(container, reg, hitSeq) {
    if (reg.size === 0) {
      container.innerHTML = '<div class="registry-row empty">(empty)</div>';
      return;
    }
    let html = "";
    for (const [seq, row] of reg) {
      const hit = seq === hitSeq ? " hit" : "";
      html += '<div class="registry-row' + hit + '" data-seq="' + seq + '">' +
        '<div class="seq">' + seq + '</div>' +
        '<div class="kind">' + row.kind + '</div>' +
        '<div class="cb">' + row.cbName + '</div>' +
        '<div class="fires">' + row.fires + '</div>' +
        '</div>';
    }
    container.innerHTML = html;
  }

  function pulseRow(container, seq) {
    const row = container.querySelector('[data-seq="' + seq + '"]');
    if (!row) return;
    row.classList.add("hit");
    nativeSetTimeout(() => row.classList.remove("hit"), 300);
  }

  // setTimeout was captured for pulse timing — save it now.
  const nativeSetTimeout = window.setTimeout.bind(window);

  function updateCounters() {
    leaderRegSize.textContent = leaderReg.size + " slot" + (leaderReg.size === 1 ? "" : "s");
    leaderRegEmitted.textContent = opsEmitted + " emitted";
    strictRegSize.textContent = strictReg.size + " slot" + (strictReg.size === 1 ? "" : "s");
    strictRegApplied.textContent = opsApplied + " applied";
    nativeCounter.textContent = "native fires: " + nativeFires;
    nativeReceived.textContent = opsReceived + " ops received";
  }

  function logOp(op, cls) {
    const div = document.createElement("div");
    div.className = "oplog-entry" + (cls ? " " + cls : "");
    div.innerHTML = '{ <span class="t">type</span>: "timer", kind: "' + op.kind +
      '", seq: <span class="seq-val">' + op.seq + '</span>, scheduledDelay: ' +
      op.scheduledDelay + ' }';
    oplog.insertBefore(div, oplog.firstChild);
    while (oplog.children.length > 60) oplog.removeChild(oplog.lastChild);
  }

  function showInflight(op) {
    channelInflight.innerHTML = '<span class="op-live">→ { type: "timer", kind: "' +
      op.kind + '", seq: ' + op.seq + ' }</span>';
  }

  // ── Op channel ─────────────────────────────────────────────────────
  function deliver(op) {
    if (paused) {
      queued.push(op);
      logOp(op, "dropped");
      return;
    }
    opsApplied++;
    opsReceived++;
    logOp(op);
    showInflight(op);

    // Non-strict: TimerOp is a no-op on the player, but we still count
    // "received" for honesty. The non-strict follower's native fires
    // increment through its own setInterval, not via ops.
    nativePlayer.apply([op]);

    // Strict: op triggers the callback. Pulse the matching row and bump
    // its fire count.
    strictPlayer.apply([op]);
    if (strictReg.has(op.seq)) {
      const row = strictReg.get(op.seq);
      row.fires++;
      if (row.kind !== "interval") strictReg.delete(op.seq);
    }

    renderRegistry(strictRegRows, strictReg);
    pulseRow(strictRegRows, op.seq);
    updateCounters();
  }

  function drainQueued() {
    const batch = queued.slice();
    queued = [];
    for (const op of batch) {
      logOp(op, "delivered-late");
      opsApplied++;
      opsReceived++;
      showInflight(op);
      nativePlayer.apply([op]);
      strictPlayer.apply([op]);
      if (strictReg.has(op.seq)) {
        const row = strictReg.get(op.seq);
        row.fires++;
        if (row.kind !== "interval") strictReg.delete(op.seq);
      }
    }
    renderRegistry(strictRegRows, strictReg);
    updateCounters();
  }

  // ── Start / lifecycle ──────────────────────────────────────────────
  function start() {
    // Reset all state
    leaderReg.clear(); strictReg.clear();
    nativeFires = 0; opsEmitted = 0; opsApplied = 0; opsReceived = 0;
    oplog.innerHTML = "";
    channelInflight.textContent = "—";
    channelState.textContent = "LIVE";
    channelEl.classList.remove("paused");
    queued = [];
    paused = false;

    // Non-strict player: doesn't patch timers; timer ops are no-ops.
    nativePlayer = createPlayer({
      events: false, network: false, random: false, clock: false, storage: false,
    });
    nativePlayer.apply([]);

    // Strict player: patches setInterval/setTimeout/rAF/rIC.
    strictPlayer = createPlayer({
      strict: true,
      events: false, network: false, random: false, clock: false, storage: false,
    });
    strictPlayer.apply([]);

    // ── Follower B (strict) "app code" ──
    // Registers two callbacks at different cadences. They return seqs
    // without scheduling native timers.
    const tickSeq = window.setInterval(() => {}, 200);
    strictReg.set(tickSeq, { kind: "interval", cbName: "tick()", fires: 0 });

    const heartbeatSeq = window.setInterval(() => {}, 500);
    strictReg.set(heartbeatSeq, { kind: "interval", cbName: "heartbeat()", fires: 0 });

    // A one-shot timeout fires once then the row disappears.
    const onceSeq = window.setTimeout(() => {}, 1000);
    strictReg.set(onceSeq, { kind: "timeout", cbName: "once()", fires: 0 });

    // ── Follower A (non-strict) "app code" ──
    // Its code also calls setInterval but since this player doesn't gate,
    // we'd really hit native. Simulate with nativeSetInterval, counting
    // fires so the user sees native ticks accumulate independent of ops.
    nativeFollowerTicks.push(nativeSetInterval(() => {
      nativeFires++;
      updateCounters();
    }, 200));
    nativeFollowerTicks.push(nativeSetInterval(() => {
      nativeFires++;
      updateCounters();
    }, 500));

    // ── Leader ──
    // On the leader the same app code would run; its recorder's seqMap
    // would populate identically. For the demo we mirror leaderReg from
    // the same seqs we registered above, and fire ops matching each.
    leaderReg.set(tickSeq, { kind: "interval", cbName: "tick()", fires: 0 });
    leaderReg.set(heartbeatSeq, { kind: "interval", cbName: "heartbeat()", fires: 0 });
    leaderReg.set(onceSeq, { kind: "timeout", cbName: "once()", fires: 0 });

    const emitTimerOp = (seq, kind, delay) => {
      const op = {
        type: "timer", kind, seq,
        scheduledDelay: delay, actualTime: performance.now(),
      };
      // Leader-side: its recorder would bump the seq's fire count.
      if (leaderReg.has(seq)) {
        const row = leaderReg.get(seq);
        row.fires++;
        if (row.kind !== "interval") leaderReg.delete(seq);
      }
      opsEmitted++;
      renderRegistry(leaderRegRows, leaderReg);
      pulseRow(leaderRegRows, seq);
      updateCounters();
      deliver(op);
    };

    leaderTicks.push(nativeSetInterval(() => emitTimerOp(tickSeq, "interval", 200), 200));
    leaderTicks.push(nativeSetInterval(() => emitTimerOp(heartbeatSeq, "interval", 500), 500));
    leaderTicks.push(nativeSetTimeout(() => emitTimerOp(onceSeq, "timeout", 1000), 1000));

    renderRegistry(leaderRegRows, leaderReg);
    renderRegistry(strictRegRows, strictReg);
    updateCounters();

    startBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
  }

  function pause() {
    paused = true;
    channelState.textContent = "PAUSED";
    channelEl.classList.add("paused");
    pauseBtn.disabled = true;
    resumeBtn.disabled = false;
  }

  function resume() {
    paused = false;
    channelState.textContent = "LIVE";
    channelEl.classList.remove("paused");
    drainQueued();
    pauseBtn.disabled = false;
    resumeBtn.disabled = true;
  }

  function stop() {
    for (const t of leaderTicks) nativeClearInterval(t);
    for (const t of nativeFollowerTicks) nativeClearInterval(t);
    leaderTicks = []; nativeFollowerTicks = [];
    if (nativePlayer) { nativePlayer.destroy(); nativePlayer = null; }
    if (strictPlayer) { strictPlayer.destroy(); strictPlayer = null; }
    channelState.textContent = "STOPPED";
    channelEl.classList.remove("paused");
    channelInflight.textContent = "—";
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    resumeBtn.disabled = true;
    stopBtn.disabled = true;
  }

  startBtn.addEventListener("click", start);
  pauseBtn.addEventListener("click", pause);
  resumeBtn.addEventListener("click", resume);
  stopBtn.addEventListener("click", stop);

  // Initial empty render
  renderRegistry(leaderRegRows, leaderReg);
  renderRegistry(strictRegRows, strictReg);
  updateCounters();
})();
  </script>
</body>
</html>
`;

async function main() {
  const bundle = await buildBundle();
  const html = HTML(bundle);
  const out = path.join(ROOT, "docs", "strict-timers.html");
  await fs.writeFile(out, html, "utf8");
  console.log(`wrote ${path.relative(ROOT, out)} — ${(html.length / 1024).toFixed(1)} KB`);
}

main();
