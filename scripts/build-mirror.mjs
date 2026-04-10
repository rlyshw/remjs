/**
 * Build the standalone mirror demo HTML.
 *
 * Reads the compiled remjs library from `dist/` and inlines it (as a plain
 * IIFE exposing `window.remjs`) alongside the demo code into a single
 * self-contained HTML file at `examples/mirror/index.html`.
 *
 * After running, the HTML file has zero external dependencies and can be
 * opened directly from the filesystem or dropped onto any static host
 * (GitHub Pages, Netlify, etc).
 *
 *   node scripts/build-mirror.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

/** Order matters: each file can only refer to identifiers from earlier files. */
const SOURCES = [
  "proxy-symbol.js",
  "ops.js",
  "registry.js",
  "codec.js",
  "proxy.js",
  "apply.js",
  "observer.js",
  "stream.js",
];

/** Strip ESM import statements and `export` keywords so declarations live in
 *  the same IIFE scope. */
function stripEsm(src) {
  return src
    // Drop `import ... from "...";` lines entirely.
    .replace(/^\s*import\s[^;]*;\s*$/gm, "")
    // Drop `//# sourceMappingURL=...` trailers.
    .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
    // Rewrite `export function foo` / `export const foo` → bare declaration.
    .replace(/^\s*export\s+(function|const|let|var|class)\s/gm, "$1 ")
    // Drop any stray `export { ... };` re-exports.
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, "");
}

async function buildBundle() {
  const parts = [];
  for (const name of SOURCES) {
    const src = await fs.readFile(path.join(DIST, name), "utf8");
    parts.push(`/* ---------- ${name} ---------- */\n${stripEsm(src)}`);
  }
  // Expose the public surface on `window.remjs`.
  parts.push(`
window.remjs = {
  // v0.2 primary API
  createObserver,
  createObjectRegistry,
  // Receiver
  applyOp,
  applyOps,
  createReceiver,
  // Codec
  encode,
  encodeContents,
  decode,
  // v0.1 compatibility shim
  createStateStream,
  // Op helpers
  normalizeLegacyOp,
  TAG,
};
`);
  return `(function(){\n"use strict";\n${parts.join("\n")}\n})();`;
}

const FULL_TEMPLATE = (bundle) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>remjs — mirror (bouncing balls)</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        font-family: system-ui, -apple-system, sans-serif;
        max-width: 1200px;
        margin: 2em auto;
        padding: 0 1em;
        color: #222;
        background: #fafafa;
      }
      h1 { margin: 0 0 0.2em; }
      .hint { color: #666; margin: 0 0 1em; max-width: 780px; line-height: 1.5; }
      .hint code {
        background: #eef;
        padding: 0.1em 0.35em;
        border-radius: 3px;
        font-size: 0.9em;
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 1.2em;
        align-items: center;
        margin: 1em 0;
        padding: 0.8em 1em;
        background: white;
        border-radius: 8px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
      }
      .controls label { display: flex; align-items: center; gap: 0.4em; }
      .controls input[type="range"] { width: 160px; }
      .controls button {
        padding: 0.45em 1.1em;
        border: 1px solid #888;
        background: #f5f5f5;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.9em;
      }
      .controls button:hover { background: #eee; }
      .panes {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1em;
      }
      .pane {
        background: white;
        border-radius: 8px;
        padding: 0.9em;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
        position: relative;
      }
      .pane h3 {
        margin: 0 0 0.5em;
        font-size: 0.8em;
        text-transform: uppercase;
        color: #888;
        letter-spacing: 0.06em;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .pulse {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #4a8;
        transition: box-shadow 0.08s, transform 0.08s;
      }
      .pulse.active {
        box-shadow: 0 0 0 6px rgba(74, 168, 102, 0.4);
        transform: scale(1.15);
      }
      canvas {
        display: block;
        width: 100%;
        background: #0e1116;
        border-radius: 6px;
        cursor: crosshair;
      }
      .hint-caption {
        text-align: center;
        font-size: 0.75em;
        color: #888;
        margin-top: 0.4em;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 0.8em;
        margin-top: 1em;
        padding: 0.9em 1em;
        background: white;
        border-radius: 8px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
      }
      .stat .label {
        font-size: 0.7em;
        text-transform: uppercase;
        color: #888;
        letter-spacing: 0.06em;
      }
      .stat .value {
        font-size: 1.6em;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .stat .unit { font-size: 0.55em; color: #aaa; margin-left: 0.2em; font-weight: 500; }
      .integrity {
        margin-top: 1em;
        padding: 0.7em 1em;
        font-family: ui-monospace, monospace;
        font-size: 0.85em;
        background: white;
        border-radius: 8px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
        border-left: 4px solid #4a8;
      }
      .integrity.bad { border-left-color: #d54; color: #c33; }
      .footer {
        margin-top: 2em;
        text-align: center;
        color: #888;
        font-size: 0.8em;
      }
      .readout {
        display: none;
        grid-template-columns: 1fr 1fr;
        gap: 1em;
        margin-top: 1em;
      }
      .readout.visible { display: grid; }
      .readout .pane { padding: 0.6em 0.8em; }
      .readout h4 {
        margin: 0 0 0.4em;
        font-size: 0.75em;
        text-transform: uppercase;
        color: #888;
        letter-spacing: 0.06em;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .readout h4 button {
        padding: 0.15em 0.55em;
        font-size: 0.85em;
        border: 1px solid #aaa;
        background: #f5f5f5;
        border-radius: 3px;
        cursor: pointer;
      }
      .readout pre {
        margin: 0;
        max-height: 340px;
        overflow: auto;
        font-family: ui-monospace, monospace;
        font-size: 0.78em;
        line-height: 1.35;
        background: #f7f7f8;
        padding: 0.6em 0.8em;
        border-radius: 4px;
        border: 1px solid #eee;
        color: #222;
        white-space: pre;
      }
      .readout.desync pre { border-color: #d54; background: #fff5f4; }
      .speed-value {
        display: inline-block;
        min-width: 3em;
        font-variant-numeric: tabular-nums;
        font-family: ui-monospace, monospace;
        font-size: 0.85em;
        color: #555;
      }
    </style>
  </head>
  <body>
    <h1>remjs mirror — shuffleboard</h1>
    <p class="hint">
      Two canvases, one HTML file, nothing in between but a function call.
      The left court owns the state — a proxied JS object with a score,
      a list of pucks, and a shot log. Click-and-drag from the launcher
      at the bottom to aim and fire a puck; the drag length sets the
      power. Physics (friction, wall bounces) runs on the source only,
      and every mutation emits a <code>set</code> op. Those ops go
      through <code>JSON.stringify</code> → <code>JSON.parse</code> →
      <code>applyOps</code> onto a plain object that drives the right
      court. Fire a puck, watch both sides animate identically, pause
      (<kbd>space</kbd>), step a frame at a time (<kbd>→</kbd>), or turn
      on "show state" to compare the raw JSON side-by-side. The two
      panes should always agree down to the last bit.
    </p>

    <div class="controls">
      <label>speed: <input type="range" id="speed" min="0" max="200" value="100" step="5" /></label>
      <span class="speed-value" id="speedVal">1.00×</span>
      <button id="pause">pause</button>
      <button id="stepOne">step ▸</button>
      <label><input type="checkbox" id="readout" /> show state</label>
      <label><input type="checkbox" id="trails" checked /> trails</label>
      <label><input type="checkbox" id="delay" /> 250ms mirror lag</label>
      <button id="reset">new game</button>
    </div>

    <div class="panes">
      <div class="pane">
        <h3>source — your court <span class="pulse" id="pulseSource"></span></h3>
        <canvas id="source" width="560" height="420"></canvas>
        <div class="hint-caption">click and drag from the launcher to aim &amp; fire</div>
      </div>
      <div class="pane">
        <h3>mirror — rebuilt from op stream <span class="pulse" id="pulseMirror"></span></h3>
        <canvas id="mirror" width="560" height="420"></canvas>
        <div class="hint-caption">receives ops only; never touched by user</div>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="label">ops / sec</div><div class="value" id="opsPs">—</div></div>
      <div class="stat"><div class="label">batches / sec</div><div class="value" id="batchesPs">—</div></div>
      <div class="stat"><div class="label">wire bytes / sec</div><div class="value" id="bytesPs">—<span class="unit">KB</span></div></div>
      <div class="stat"><div class="label">bytes / op</div><div class="value" id="bytesPerOp">—</div></div>
      <div class="stat"><div class="label">frame cost</div><div class="value" id="frameMs">—<span class="unit">ms</span></div></div>
    </div>

    <div class="integrity" id="integrity">integrity: initialising…</div>

    <div class="readout" id="readoutWrap">
      <div class="pane">
        <h4>
          <span>source state (raw JS)</span>
          <button id="copySource">copy</button>
        </h4>
        <pre id="sourceJson">—</pre>
      </div>
      <div class="pane">
        <h4>
          <span>mirror state (rebuilt from ops)</span>
          <button id="copyMirror">copy</button>
        </h4>
        <pre id="mirrorJson">—</pre>
      </div>
    </div>

    <p class="footer">
      Single-file demo · <a href="https://github.com/anthropics/claude-code">remjs</a>
    </p>

    <!-- ───────────── remjs library (inlined IIFE bundle) ───────────── -->
    <script>
${bundle}
    </script>

    <!-- ───────────── demo code ───────────── -->
    <script>
(function () {
  const { createStateStream, applyOps, decode } = window.remjs;

  /* court geometry --------------------------------------------------- */

  const W = 560;
  const H = 420;
  const LAUNCHER = { x: W / 2, y: H - 34 };
  const TARGET = { x: W / 2, y: 70 };
  const ZONES = [
    { r: 22, points: 5, color: "#f0c040" },
    { r: 46, points: 3, color: "#6fa8dc" },
    { r: 74, points: 1, color: "#3e5978" },
  ];
  const PUCK_R = 14;
  const FRICTION = 0.985;
  const REST_SPEED = 0.2;
  const RESTITUTION = 0.9;

  const sourceCanvas = document.getElementById("source");
  const mirrorCanvas = document.getElementById("mirror");
  const sctx = sourceCanvas.getContext("2d");
  const mctx = mirrorCanvas.getContext("2d");

  const $speed = document.getElementById("speed");
  const $speedVal = document.getElementById("speedVal");
  const $pause = document.getElementById("pause");
  const $stepOne = document.getElementById("stepOne");
  const $readoutCk = document.getElementById("readout");
  const $readoutWrap = document.getElementById("readoutWrap");
  const $sourceJson = document.getElementById("sourceJson");
  const $mirrorJson = document.getElementById("mirrorJson");
  const $copySource = document.getElementById("copySource");
  const $copyMirror = document.getElementById("copyMirror");
  const $delay = document.getElementById("delay");
  const $trails = document.getElementById("trails");
  const $reset = document.getElementById("reset");
  const $opsPs = document.getElementById("opsPs");
  const $batchesPs = document.getElementById("batchesPs");
  const $bytesPs = document.getElementById("bytesPs");
  const $bytesPerOp = document.getElementById("bytesPerOp");
  const $frameMs = document.getElementById("frameMs");
  const $integrity = document.getElementById("integrity");
  const $pulseSource = document.getElementById("pulseSource");
  const $pulseMirror = document.getElementById("pulseMirror");

  /* game state ------------------------------------------------------- */

  function makeInitialGame() {
    return {
      tick: 0,
      nextId: 1,
      score: 0,
      pucks: [],   // { id, x, y, vx, vy, color, stopped, points }
      shots: [],   // { id, puckId, tick, aimX, aimY, result }
    };
  }

  /* trails (local render state) -------------------------------------- */

  const TRAIL_LEN = 28;
  function makeTrailMap() { return new Map(); }
  const sourceTrails = makeTrailMap();
  const mirrorTrails = makeTrailMap();

  function updateTrails(trails, state) {
    const alive = new Set();
    const pucks = state.pucks;
    for (let i = 0; i < pucks.length; i++) {
      const p = pucks[i];
      alive.add(p.id);
      let trail = trails.get(p.id);
      if (!trail) {
        trail = { color: p.color, points: [] };
        trails.set(p.id, trail);
      }
      // Only record trail points while the puck is actually moving so
      // stopped pucks stop leaving breadcrumbs.
      if (!p.stopped) {
        trail.points.push(p.x, p.y);
        if (trail.points.length > TRAIL_LEN * 2) {
          trail.points.splice(0, trail.points.length - TRAIL_LEN * 2);
        }
      }
    }
    for (const id of trails.keys()) {
      if (!alive.has(id)) trails.delete(id);
    }
  }

  /* streaming -------------------------------------------------------- */

  let source = null;
  let stream = null;
  let proxy = null;
  let mirror = null;

  let opsThisSec = 0;
  let batchesThisSec = 0;
  let bytesThisSec = 0;
  let delayMs = 0;
  let speed = 1;
  let stepAccumulator = 0;
  let paused = false;
  let readoutOn = false;
  let readoutDirty = true;

  function flashPulse(el) {
    el.classList.add("active");
    setTimeout(() => el.classList.remove("active"), 80);
  }

  function pipe(ops) {
    opsThisSec += ops.length;
    batchesThisSec++;
    flashPulse($pulseSource);
    const wire = JSON.stringify(ops);
    bytesThisSec += wire.length;
    const deliver = () => {
      applyOps(mirror, JSON.parse(wire));
      flashPulse($pulseMirror);
    };
    if (delayMs > 0) setTimeout(deliver, delayMs);
    else deliver();
  }

  function wireUp() {
    if (stream) stream.dispose();
    source = makeInitialGame();
    stream = createStateStream(source, { onOps: pipe, batch: "microtask" });
    proxy = stream.state;
    mirror = decode(stream.snapshot().value);
  }

  /* game actions ----------------------------------------------------- */

  function launchPuck(aimX, aimY) {
    // Vector from launcher to aim point.
    let dx = aimX - LAUNCHER.x;
    let dy = aimY - LAUNCHER.y;
    // Clamp power based on drag length.
    const dragLen = Math.hypot(dx, dy);
    const MAX_POWER = 14;
    const power = Math.min(MAX_POWER, dragLen / 14);
    if (power < 0.5) return; // too weak to matter
    const nx = dx / (dragLen || 1);
    const ny = dy / (dragLen || 1);
    const vx = nx * power;
    const vy = ny * power;

    const puckId = proxy.nextId;
    proxy.nextId++;
    proxy.pucks.push({
      id: puckId,
      x: LAUNCHER.x,
      y: LAUNCHER.y,
      vx,
      vy,
      color: "hsl(" + ((puckId * 53) % 360) + ", 80%, 60%)",
      stopped: false,
      points: 0,
    });
    proxy.shots.push({
      id: proxy.shots.length + 1,
      puckId,
      tick: proxy.tick,
      aimX: Math.round(aimX),
      aimY: Math.round(aimY),
      result: "in_flight",
    });
    readoutDirty = true;
  }

  function distanceToTarget(x, y) {
    const dx = x - TARGET.x;
    const dy = y - TARGET.y;
    return Math.hypot(dx, dy);
  }

  function scorePuck(x, y) {
    const d = distanceToTarget(x, y);
    for (const z of ZONES) {
      if (d <= z.r) return z.points;
    }
    return 0;
  }

  /* physics ---------------------------------------------------------- */

  function recomputeScore() {
    let total = 0;
    const pucks = proxy.pucks;
    for (let i = 0; i < pucks.length; i++) {
      if (pucks[i].stopped) total += pucks[i].points;
    }
    if (total !== proxy.score) proxy.score = total;
  }

  function updateShotLogForPuck(puckId, result) {
    // Find the most recent shot entry for this puck and update its result.
    const shots = proxy.shots;
    for (let j = shots.length - 1; j >= 0; j--) {
      if (shots[j].puckId === puckId) {
        if (shots[j].result !== result) shots[j].result = result;
        return;
      }
    }
  }

  /** Resolve puck-on-puck collisions by positional correction + impulse.
   *  Equal mass, partially elastic. Stopped pucks get woken up if hit. */
  function resolveCollisions() {
    const pucks = proxy.pucks;
    const n = pucks.length;
    for (let i = 0; i < n; i++) {
      const a = pucks[i];
      for (let j = i + 1; j < n; j++) {
        const b = pucks[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy;
        const minDist = PUCK_R * 2;
        if (distSq >= minDist * minDist || distSq === 0) continue;

        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const ny = dy / dist;

        // Push each puck out so they're just touching.
        const overlap = (minDist - dist) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;

        // Relative velocity along the collision normal.
        const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        // If already separating, the positional correction is enough.
        if (rvn > 0) continue;

        // Equal-mass elastic impulse with restitution.
        const impulse = -(1 + RESTITUTION) * rvn / 2;
        const ix = impulse * nx;
        const iy = impulse * ny;
        a.vx -= ix;
        a.vy -= iy;
        b.vx += ix;
        b.vy += iy;

        // Any stopped puck that got hit is now in motion again and
        // loses its previous scoring contribution until it settles.
        if (a.stopped) {
          a.stopped = false;
          if (a.points !== 0) a.points = 0;
          updateShotLogForPuck(a.id, "bumped");
        }
        if (b.stopped) {
          b.stopped = false;
          if (b.points !== 0) b.points = 0;
          updateShotLogForPuck(b.id, "bumped");
        }
      }
    }
  }

  function step() {
    proxy.tick++;
    const pucks = proxy.pucks;

    // 1. Integrate motion for moving pucks.
    for (let i = 0; i < pucks.length; i++) {
      const p = pucks[i];
      if (p.stopped) continue;

      let x = p.x, y = p.y, vx = p.vx, vy = p.vy;
      x += vx;
      y += vy;
      vx *= FRICTION;
      vy *= FRICTION;

      if (x < PUCK_R) { x = PUCK_R; vx = -vx * 0.85; }
      else if (x > W - PUCK_R) { x = W - PUCK_R; vx = -vx * 0.85; }
      if (y < PUCK_R) { y = PUCK_R; vy = -vy * 0.85; }
      else if (y > H - PUCK_R) { y = H - PUCK_R; vy = -vy * 0.85; }

      p.x = x;
      p.y = y;
      p.vx = vx;
      p.vy = vy;
    }

    // 2. Resolve puck-on-puck collisions (may wake stopped pucks).
    resolveCollisions();

    // 3. Detect newly rested pucks, score them, log the result.
    for (let i = 0; i < pucks.length; i++) {
      const p = pucks[i];
      if (p.stopped) continue;
      if (Math.hypot(p.vx, p.vy) < REST_SPEED) {
        p.stopped = true;
        p.vx = 0;
        p.vy = 0;
        const pts = scorePuck(p.x, p.y);
        p.points = pts;
        updateShotLogForPuck(p.id, pts > 0 ? "scored " + pts : "miss");
      }
    }

    // 4. Recompute the total score from the currently-stopped pucks.
    //    This handles both the just-rested case and the "woke up during
    //    collision" case — a bumped puck drops out of the score
    //    immediately and rejoins when it re-settles.
    recomputeScore();
  }

  /* rendering -------------------------------------------------------- */

  let showTrails = true;

  function drawScene(ctx, state, trails, paneLabel, isSource) {
    // Background.
    ctx.fillStyle = "#0e1116";
    ctx.fillRect(0, 0, W, H);

    // Scoring zones — outer to inner so inner overdraws.
    for (let i = ZONES.length - 1; i >= 0; i--) {
      const z = ZONES[i];
      ctx.fillStyle = z.color;
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.arc(TARGET.x, TARGET.y, z.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = z.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(TARGET.x, TARGET.y, z.r, 0, Math.PI * 2);
      ctx.stroke();
      // Point value text on the right edge of the ring.
      ctx.fillStyle = z.color;
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(String(z.points), TARGET.x + z.r + 4, TARGET.y);
    }

    // Launcher marker.
    ctx.fillStyle = "#8a8f99";
    ctx.beginPath();
    ctx.moveTo(LAUNCHER.x - 14, LAUNCHER.y + 10);
    ctx.lineTo(LAUNCHER.x + 14, LAUNCHER.y + 10);
    ctx.lineTo(LAUNCHER.x, LAUNCHER.y - 10);
    ctx.closePath();
    ctx.fill();

    // Trails.
    if (showTrails) {
      for (const trail of trails.values()) {
        const pts = trail.points;
        if (pts.length < 4) continue;
        ctx.strokeStyle = trail.color;
        ctx.lineCap = "round";
        for (let j = 0; j < pts.length - 2; j += 2) {
          const t = (j / 2) / (pts.length / 2 - 1);
          ctx.globalAlpha = Math.max(0.05, t * 0.55);
          ctx.lineWidth = 1 + t * 2.5;
          ctx.beginPath();
          ctx.moveTo(pts[j], pts[j + 1]);
          ctx.lineTo(pts[j + 2], pts[j + 3]);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Pucks.
    const pucks = state.pucks;
    for (let i = 0; i < pucks.length; i++) {
      const p = pucks[i];
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.stopped ? 0.85 : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PUCK_R, 0, Math.PI * 2);
      ctx.fill();
      // Outline for stopped pucks so they read as "settled".
      if (p.stopped) {
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, PUCK_R, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff";
      ctx.font = "bold 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(p.id), p.x, p.y);
    }

    // Aim line (only on the source canvas while dragging).
    if (isSource && drag) {
      const dx = drag.x - LAUNCHER.x;
      const dy = drag.y - LAUNCHER.y;
      const len = Math.min(Math.hypot(dx, dy), 14 * 14);
      const nx = dx / (Math.hypot(dx, dy) || 1);
      const ny = dy / (Math.hypot(dx, dy) || 1);
      ctx.strokeStyle = "#fff";
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(LAUNCHER.x, LAUNCHER.y);
      ctx.lineTo(LAUNCHER.x + nx * len, LAUNCHER.y + ny * len);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // HUD: score + shot count + pane label + tick.
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("score " + state.score, W - 10, 8);

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(
      paneLabel + "  tick=" + state.tick + "  pucks=" + pucks.length + "  shots=" + state.shots.length,
      8,
      8,
    );

    // Last few shots, as a small log in the bottom-left.
    const shots = state.shots;
    if (shots.length > 0) {
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      const take = shots.slice(Math.max(0, shots.length - 4));
      for (let i = 0; i < take.length; i++) {
        const s = take[i];
        const line = "#" + s.id + " puck " + s.puckId + " · " + s.result;
        ctx.fillText(line, 10, H - 10 - (take.length - 1 - i) * 14);
      }
    }
  }

  /* main loop -------------------------------------------------------- */

  let lastFrameTs = performance.now();
  let frameTimeAccum = 0;
  let frameCount = 0;

  function runPhysicsForFrame() {
    if (paused) return;
    stepAccumulator += speed;
    let steps = 0;
    while (stepAccumulator >= 1 && steps < 8) {
      step();
      stepAccumulator -= 1;
      steps++;
    }
    if (steps > 0) {
      stream.flush();
      updateTrails(sourceTrails, source);
      updateTrails(mirrorTrails, mirror);
      readoutDirty = true;
    }
  }

  function loop(ts) {
    lastFrameTs = ts;
    const t0 = performance.now();
    runPhysicsForFrame();
    drawScene(sctx, source, sourceTrails, "source", true);
    drawScene(mctx, mirror, mirrorTrails, "mirror", false);
    const t1 = performance.now();
    frameTimeAccum += t1 - t0;
    frameCount++;
    maybeUpdateReadout();
    requestAnimationFrame(loop);
  }

  function stepOnce() {
    step();
    stream.flush();
    updateTrails(sourceTrails, source);
    updateTrails(mirrorTrails, mirror);
    readoutDirty = true;
  }

  /* state readout ---------------------------------------------------- */

  let lastReadoutAt = 0;

  function serializeState(state) {
    // Deterministic key order — needed so two identical states produce
    // byte-identical JSON for easy visual diffing.
    return JSON.stringify(
      state,
      (key, value) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const ordered = {};
          const keys = Object.keys(value).sort();
          for (const k of keys) ordered[k] = value[k];
          return ordered;
        }
        return value;
      },
      2,
    );
  }

  function maybeUpdateReadout() {
    if (!readoutOn) return;
    const now = performance.now();
    // Throttle: update at ~6Hz while running, immediately when paused/dirty.
    if (!paused && !readoutDirty) return;
    if (!paused && now - lastReadoutAt < 160) return;
    lastReadoutAt = now;
    readoutDirty = false;

    const srcText = serializeState(source);
    const mirText = serializeState(mirror);
    $sourceJson.textContent = srcText;
    $mirrorJson.textContent = mirText;
    $readoutWrap.classList.toggle("desync", srcText !== mirText);
  }

  /* stats / integrity ------------------------------------------------ */

  function checkIntegrity() {
    if (!source || !mirror) return "initialising";
    if (source.tick !== mirror.tick) {
      return "tick drift (" + source.tick + " vs " + mirror.tick + ")";
    }
    if (source.score !== mirror.score) return "score drift";
    if (source.pucks.length !== mirror.pucks.length) {
      return "puck-count drift (" + source.pucks.length + " vs " + mirror.pucks.length + ")";
    }
    if (source.shots.length !== mirror.shots.length) {
      return "shot-log drift (" + source.shots.length + " vs " + mirror.shots.length + ")";
    }
    let mismatches = 0;
    let firstBad = -1;
    for (let i = 0; i < source.pucks.length; i++) {
      const a = source.pucks[i];
      const b = mirror.pucks[i];
      if (
        a.id !== b.id ||
        a.x !== b.x ||
        a.y !== b.y ||
        a.vx !== b.vx ||
        a.vy !== b.vy ||
        a.color !== b.color ||
        a.stopped !== b.stopped ||
        a.points !== b.points
      ) {
        if (firstBad === -1) firstBad = i;
        mismatches++;
      }
    }
    if (mismatches > 0) {
      return mismatches + " puck mismatches (first @ index " + firstBad + ")";
    }
    // Shot-log entries.
    for (let i = 0; i < source.shots.length; i++) {
      const a = source.shots[i];
      const b = mirror.shots[i];
      if (a.id !== b.id || a.puckId !== b.puckId || a.tick !== b.tick || a.result !== b.result) {
        return "shot-log entry " + i + " drift";
      }
    }
    return null;
  }

  setInterval(() => {
    $opsPs.textContent = opsThisSec.toLocaleString();
    $batchesPs.textContent = batchesThisSec.toLocaleString();
    $bytesPs.innerHTML = (bytesThisSec / 1024).toFixed(1) + '<span class="unit">KB</span>';
    $bytesPerOp.textContent = opsThisSec ? (bytesThisSec / opsThisSec).toFixed(1) : "—";
    $frameMs.innerHTML = frameCount
      ? (frameTimeAccum / frameCount).toFixed(2) + '<span class="unit">ms</span>'
      : "—";

    opsThisSec = 0;
    batchesThisSec = 0;
    bytesThisSec = 0;
    frameTimeAccum = 0;
    frameCount = 0;

    if (delayMs === 0) {
      const err = checkIntegrity();
      if (err) {
        $integrity.className = "integrity bad";
        $integrity.textContent = "integrity: DESYNC — " + err;
      } else {
        $integrity.className = "integrity";
        $integrity.textContent =
          "integrity: OK · score=" + source.score +
          " · " + source.pucks.length + " pucks · " +
          source.shots.length + " shots verified @ tick " + source.tick;
      }
    } else {
      $integrity.className = "integrity";
      $integrity.textContent =
        "integrity: delayed mode — mirror trails by " + delayMs + "ms (expected drift)";
    }
  }, 1000);

  /* click & drag to fire --------------------------------------------- */

  let drag = null; // { x, y } in canvas coords, while a drag is in progress

  function canvasXY(ev) {
    const rect = sourceCanvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * W,
      y: ((ev.clientY - rect.top) / rect.height) * H,
    };
  }

  sourceCanvas.addEventListener("pointerdown", (ev) => {
    drag = canvasXY(ev);
    sourceCanvas.setPointerCapture(ev.pointerId);
  });
  sourceCanvas.addEventListener("pointermove", (ev) => {
    if (drag) drag = canvasXY(ev);
  });
  sourceCanvas.addEventListener("pointerup", (ev) => {
    if (!drag) return;
    const { x, y } = drag;
    drag = null;
    launchPuck(x, y);
  });
  sourceCanvas.addEventListener("pointercancel", () => { drag = null; });

  /* controls --------------------------------------------------------- */

  function resetDemo() {
    sourceTrails.clear();
    mirrorTrails.clear();
    drag = null;
    wireUp();
  }

  function setSpeedFromSlider() {
    // Slider is 0..200, map to 0..2 with a mild curve so the low end
    // has more precision (tracking balls frame-by-frame is near 0).
    const raw = Number($speed.value) / 100; // 0..2
    speed = raw;
    $speedVal.textContent = speed.toFixed(2) + "×";
  }

  function setPaused(p) {
    paused = p;
    $pause.textContent = paused ? "resume" : "pause";
    if (paused) readoutDirty = true;
  }

  $speed.addEventListener("input", setSpeedFromSlider);
  $pause.addEventListener("click", () => setPaused(!paused));
  $stepOne.addEventListener("click", () => { if (!paused) setPaused(true); stepOnce(); });
  $readoutCk.addEventListener("change", () => {
    readoutOn = $readoutCk.checked;
    $readoutWrap.classList.toggle("visible", readoutOn);
    readoutDirty = true;
  });
  $copySource.addEventListener("click", () => {
    navigator.clipboard?.writeText($sourceJson.textContent || "");
  });
  $copyMirror.addEventListener("click", () => {
    navigator.clipboard?.writeText($mirrorJson.textContent || "");
  });
  $delay.addEventListener("change", () => { delayMs = $delay.checked ? 250 : 0; });
  $trails.addEventListener("change", () => { showTrails = $trails.checked; });
  $reset.addEventListener("click", () => { resetDemo(); });

  // Keyboard: space = pause/resume, → = step one frame.
  document.addEventListener("keydown", (e) => {
    if (e.target && e.target.tagName === "INPUT") return;
    if (e.code === "Space") {
      e.preventDefault();
      setPaused(!paused);
    } else if (e.code === "ArrowRight") {
      e.preventDefault();
      if (!paused) setPaused(true);
      stepOnce();
    }
  });

  setSpeedFromSlider();

  /* go --------------------------------------------------------------- */

  wireUp();
  requestAnimationFrame(loop);
})();
    </script>
  </body>
</html>
`;

/**
 * Minimal embed variant — just the two canvases and the shuffleboard game,
 * dark-themed to match the landing page. No controls, no stats grid, no
 * JSON readout. Used as an iframe on docs/index.html.
 */
const EMBED_TEMPLATE = (bundle) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>remjs mirror embed</title>
    <style>
      :root {
        --bg: #0d1117;
        --surface: #161b22;
        --border: #30363d;
        --text: #e6edf3;
        --text-muted: #8b949e;
        --accent: #58a6ff;
        --purple: #bc8cff;
        --green: #3fb950;
        --font-mono: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
        --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: var(--font-sans);
        color: var(--text);
        background: var(--bg);
        padding: 0.85rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
      }
      .panes {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
      }
      .pane {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
        min-width: 0;
      }
      .label {
        font-family: var(--font-mono);
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-muted);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .label .side-source { color: var(--accent); }
      .label .side-mirror { color: var(--purple); }
      .pulse {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--green);
        transition: box-shadow 0.08s, transform 0.08s;
        opacity: 0.25;
      }
      .pulse.active {
        opacity: 1;
        box-shadow: 0 0 0 5px rgba(63, 185, 80, 0.35);
        transform: scale(1.2);
      }
      canvas {
        display: block;
        width: 100%;
        /* Canvas intrinsic resolution is 520×400; use the same aspect
           ratio in CSS so the canvas scales proportionally and never
           gets squished. */
        aspect-ratio: 13 / 10;
        background: #06080d;
        border: 1px solid var(--border);
        border-radius: 6px;
        cursor: crosshair;
      }
      .footnote {
        font-family: var(--font-mono);
        font-size: 0.72rem;
        color: var(--text-muted);
        text-align: center;
      }
      .footnote .sep { margin: 0 0.4rem; color: var(--border); }
      .footnote .ok { color: var(--green); }
      .footnote .bad { color: #f85149; }

      /* Mobile / narrow iframes: stack the two courts vertically.
         Side-by-side at half-width crushes each canvas to <180px,
         which makes the pucks unreadable and the click target tiny. */
      @media (max-width: 540px) {
        body { padding: 0.7rem 0.85rem; gap: 0.55rem; }
        .panes { grid-template-columns: 1fr; gap: 0.85rem; }
      }
    </style>
  </head>
  <body>
    <div class="panes">
      <div class="pane">
        <div class="label">
          <span class="side-source">source — your court</span>
          <span class="pulse" id="pulseSource"></span>
        </div>
        <canvas id="source" width="520" height="400"></canvas>
      </div>
      <div class="pane">
        <div class="label">
          <span class="side-mirror">mirror — rebuilt from op stream</span>
          <span class="pulse" id="pulseMirror"></span>
        </div>
        <canvas id="mirror" width="520" height="400"></canvas>
      </div>
    </div>
    <div class="footnote">
      <span id="hint">click &amp; drag from the triangle to fire a puck</span>
      <span class="sep">·</span>
      <span id="integrity" class="ok">in sync</span>
    </div>

    <script>
${bundle}
    </script>
    <script>
(function () {
  const { createStateStream, applyOps, decode } = window.remjs;

  const W = 520, H = 400;
  const LAUNCHER = { x: W / 2, y: H - 32 };
  const TARGET = { x: W / 2, y: 60 };
  const ZONES = [
    { r: 20, points: 5, color: "#f0c040" },
    { r: 42, points: 3, color: "#6fa8dc" },
    { r: 68, points: 1, color: "#3e5978" },
  ];
  const PUCK_R = 12;
  const FRICTION = 0.985;
  const REST_SPEED = 0.2;
  const RESTITUTION = 0.9;

  const sourceCanvas = document.getElementById("source");
  const mirrorCanvas = document.getElementById("mirror");
  const sctx = sourceCanvas.getContext("2d");
  const mctx = mirrorCanvas.getContext("2d");
  const $pulseSource = document.getElementById("pulseSource");
  const $pulseMirror = document.getElementById("pulseMirror");
  const $integrity = document.getElementById("integrity");
  const $hint = document.getElementById("hint");

  function makeInitial() { return { tick: 0, nextId: 1, score: 0, pucks: [], shots: [] }; }
  let source = makeInitial();
  let stream = null;
  let proxy = null;
  let mirror = null;

  function flashPulse(el) {
    el.classList.add("active");
    setTimeout(() => el.classList.remove("active"), 100);
  }

  function pipe(ops) {
    flashPulse($pulseSource);
    const wire = JSON.stringify(ops);
    applyOps(mirror, JSON.parse(wire));
    flashPulse($pulseMirror);
  }

  function wireUp() {
    if (stream) stream.dispose();
    source = makeInitial();
    stream = createStateStream(source, { onOps: pipe, batch: "microtask" });
    proxy = stream.state;
    mirror = decode(stream.snapshot().value);
  }

  function launchPuck(aimX, aimY) {
    const dx = aimX - LAUNCHER.x;
    const dy = aimY - LAUNCHER.y;
    const dragLen = Math.hypot(dx, dy);
    const power = Math.min(13, dragLen / 13);
    if (power < 0.5) return;
    const nx = dx / (dragLen || 1);
    const ny = dy / (dragLen || 1);
    const puckId = proxy.nextId++;
    proxy.pucks.push({
      id: puckId,
      x: LAUNCHER.x,
      y: LAUNCHER.y,
      vx: nx * power,
      vy: ny * power,
      color: "hsl(" + ((puckId * 53) % 360) + ", 80%, 60%)",
      stopped: false,
      points: 0,
    });
    proxy.shots.push({ id: proxy.shots.length + 1, puckId, tick: proxy.tick, result: "in_flight" });
    $hint.style.opacity = "0.5";
  }

  function scorePuck(x, y) {
    const d = Math.hypot(x - TARGET.x, y - TARGET.y);
    for (const z of ZONES) if (d <= z.r) return z.points;
    return 0;
  }

  function recomputeScore() {
    let total = 0;
    for (const p of proxy.pucks) if (p.stopped) total += p.points;
    if (total !== proxy.score) proxy.score = total;
  }

  function updateShotLogForPuck(puckId, result) {
    const shots = proxy.shots;
    for (let j = shots.length - 1; j >= 0; j--) {
      if (shots[j].puckId === puckId) {
        if (shots[j].result !== result) shots[j].result = result;
        return;
      }
    }
  }

  function resolveCollisions() {
    const pucks = proxy.pucks;
    for (let i = 0; i < pucks.length; i++) {
      const a = pucks[i];
      for (let j = i + 1; j < pucks.length; j++) {
        const b = pucks[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const ds = dx * dx + dy * dy;
        const md = PUCK_R * 2;
        if (ds >= md * md || ds === 0) continue;
        const d = Math.sqrt(ds);
        const nx = dx / d, ny = dy / d;
        const overlap = (md - d) / 2;
        a.x -= nx * overlap; a.y -= ny * overlap;
        b.x += nx * overlap; b.y += ny * overlap;
        const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn > 0) continue;
        const imp = -(1 + RESTITUTION) * rvn / 2;
        a.vx -= imp * nx; a.vy -= imp * ny;
        b.vx += imp * nx; b.vy += imp * ny;
        if (a.stopped) { a.stopped = false; a.points = 0; updateShotLogForPuck(a.id, "bumped"); }
        if (b.stopped) { b.stopped = false; b.points = 0; updateShotLogForPuck(b.id, "bumped"); }
      }
    }
  }

  function step() {
    proxy.tick++;
    const pucks = proxy.pucks;
    for (const p of pucks) {
      if (p.stopped) continue;
      let { x, y, vx, vy } = p;
      x += vx; y += vy;
      vx *= FRICTION; vy *= FRICTION;
      if (x < PUCK_R) { x = PUCK_R; vx = -vx * 0.85; }
      else if (x > W - PUCK_R) { x = W - PUCK_R; vx = -vx * 0.85; }
      if (y < PUCK_R) { y = PUCK_R; vy = -vy * 0.85; }
      else if (y > H - PUCK_R) { y = H - PUCK_R; vy = -vy * 0.85; }
      p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    }
    resolveCollisions();
    for (const p of pucks) {
      if (p.stopped) continue;
      if (Math.hypot(p.vx, p.vy) < REST_SPEED) {
        p.stopped = true; p.vx = 0; p.vy = 0;
        const pts = scorePuck(p.x, p.y);
        p.points = pts;
        updateShotLogForPuck(p.id, pts > 0 ? "scored " + pts : "miss");
      }
    }
    recomputeScore();
  }

  let drag = null;
  function canvasXY(ev) {
    const r = sourceCanvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
  }
  sourceCanvas.addEventListener("pointerdown", (ev) => {
    drag = canvasXY(ev);
    sourceCanvas.setPointerCapture(ev.pointerId);
  });
  sourceCanvas.addEventListener("pointermove", (ev) => { if (drag) drag = canvasXY(ev); });
  sourceCanvas.addEventListener("pointerup", () => {
    if (!drag) return;
    const { x, y } = drag;
    drag = null;
    launchPuck(x, y);
  });
  sourceCanvas.addEventListener("pointercancel", () => { drag = null; });

  function drawScene(ctx, state, isSource) {
    ctx.fillStyle = "#06080d";
    ctx.fillRect(0, 0, W, H);

    // Scoring zones
    for (let i = ZONES.length - 1; i >= 0; i--) {
      const z = ZONES[i];
      ctx.fillStyle = z.color;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(TARGET.x, TARGET.y, z.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = z.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(TARGET.x, TARGET.y, z.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Launcher
    ctx.fillStyle = "#8b949e";
    ctx.beginPath();
    ctx.moveTo(LAUNCHER.x - 12, LAUNCHER.y + 10);
    ctx.lineTo(LAUNCHER.x + 12, LAUNCHER.y + 10);
    ctx.lineTo(LAUNCHER.x, LAUNCHER.y - 10);
    ctx.closePath();
    ctx.fill();

    // Pucks
    for (const p of state.pucks) {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.stopped ? 0.9 : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PUCK_R, 0, Math.PI * 2);
      ctx.fill();
      if (p.stopped) {
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, PUCK_R, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px var(--font-sans), sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(p.id), p.x, p.y);
    }

    // Aim line
    if (isSource && drag) {
      const dx = drag.x - LAUNCHER.x;
      const dy = drag.y - LAUNCHER.y;
      const mag = Math.hypot(dx, dy);
      if (mag > 2) {
        const nx = dx / mag, ny = dy / mag;
        const len = Math.min(mag, 13 * 13);
        ctx.strokeStyle = "#e6edf3";
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(LAUNCHER.x, LAUNCHER.y);
        ctx.lineTo(LAUNCHER.x + nx * len, LAUNCHER.y + ny * len);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // Score (top-right corner)
    ctx.fillStyle = isSource ? "#58a6ff" : "#bc8cff";
    ctx.font = "bold 20px var(--font-sans), sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(String(state.score), W - 8, 6);
    ctx.font = "10px var(--font-sans), sans-serif";
    ctx.fillStyle = "#8b949e";
    ctx.fillText("score", W - 8, 28);
  }

  function checkIntegrity() {
    if (source.tick !== mirror.tick) return false;
    if (source.score !== mirror.score) return false;
    if (source.pucks.length !== mirror.pucks.length) return false;
    if (source.shots.length !== mirror.shots.length) return false;
    for (let i = 0; i < source.pucks.length; i++) {
      const a = source.pucks[i], b = mirror.pucks[i];
      if (a.x !== b.x || a.y !== b.y || a.stopped !== b.stopped || a.points !== b.points) return false;
    }
    return true;
  }

  function loop() {
    step();
    stream.flush();
    drawScene(sctx, source, true);
    drawScene(mctx, mirror, false);
    requestAnimationFrame(loop);
  }

  setInterval(() => {
    const ok = checkIntegrity();
    $integrity.className = ok ? "ok" : "bad";
    $integrity.textContent = ok ? "in sync" : "DESYNC";
  }, 500);

  wireUp();
  requestAnimationFrame(loop);
})();
    </script>
  </body>
</html>
`;

/** Output targets:
 *  - The full, feature-rich mirror demo (controls + stats + readout)
 *    goes to examples/mirror/index.html and docs/mirror.html so it's
 *    available both as a local file and via GitHub Pages.
 *  - A minimal embed variant (just the two canvases + click-to-fire)
 *    goes to docs/mirror-embed.html, used as an iframe in the landing
 *    page. Dark-themed to match the landing design. */
function outputs() {
  return [
    { path: path.join(ROOT, "examples", "mirror", "index.html"), template: FULL_TEMPLATE },
    { path: path.join(ROOT, "docs", "mirror.html"), template: FULL_TEMPLATE },
    { path: path.join(ROOT, "docs", "mirror-embed.html"), template: EMBED_TEMPLATE },
  ];
}

async function main() {
  const bundle = await buildBundle();
  for (const { path: out, template } of outputs()) {
    const html = template(bundle);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, html);
    const stats = await fs.stat(out);
    console.log(
      `wrote ${path.relative(ROOT, out)} — ${(stats.size / 1024).toFixed(1)} KB`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
