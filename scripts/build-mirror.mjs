/**
 * Build the standalone mirror demo HTML — v0.3 event loop replication.
 *
 * Generates two HTML files:
 *   1. The shuffleboard game page (can run standalone or as an iframe)
 *   2. The mirror page (side-by-side: source + iframe follower)
 *
 * The source canvas runs the game with real inputs. The iframe runs
 * the same code but with a player that replays recorded inputs via
 * postMessage. Both produce identical output — demonstrating event
 * loop replication without a server.
 *
 *   node scripts/build-mirror.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const SOURCES = [
  "ops.js",
  "codec.js",
  "patches/clock.js",
  "patches/random.js",
  "patches/timers.js",
  "patches/network.js",
  "patches/storage.js",
  "target.js",
  "patches/events.js",
  "recorder.js",
  "player.js",
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
    parts.push(`/* ---------- ${name} ---------- */\n${stripEsm(src)}`);
  }
  parts.push(`
window.remjs = {
  createRecorder,
  createPlayer,
  jsonCodec,
};
`);
  return `(function(){"use strict";\n${parts.join("\n")}\n})();`;
}

/* ── Game page (runs in both source and iframe) ───────────────── */

const GAME_PAGE = (bundle) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>remjs — shuffleboard</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; overflow: hidden; }
    canvas { display: block; width: 100%; height: 100vh; cursor: crosshair; }
  </style>
</head>
<body>
  <canvas id="canvas"></canvas>
  <script>${bundle}</script>
  <script>
(function() {
  var isFollower = (window.location.hash === "#follower") || window.__remjs_follower;
  var { createRecorder, createPlayer, jsonCodec } = window.remjs;

  var canvas = document.getElementById("canvas");
  var ctx = canvas.getContext("2d");

  /* ── geometry ─────────────────────────────────────────── */
  var W = 560, H = 420;
  var LAUNCHER = { x: W / 2, y: H - 34 };
  var TARGET = { x: W / 2, y: 70 };
  var ZONES = [
    { r: 22, pts: 5, color: "#f0c040" },
    { r: 46, pts: 3, color: "#6fa8dc" },
    { r: 74, pts: 1, color: "#3e5978" },
  ];
  var PUCK_R = 14, FRICTION = 0.985, REST = 0.2, BOUNCE = 0.9;

  /* ── state ────────────────────────────────────────────── */
  var pucks = [];
  var nextId = 1;
  var score = 0;
  var drag = null;

  function canvasXY(ev) {
    var r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width * W, y: (ev.clientY - r.top) / r.height * H };
  }

  /* ── game logic ───────────────────────────────────────── */
  function launchPuck(aimX, aimY) {
    var dx = aimX - LAUNCHER.x, dy = aimY - LAUNCHER.y;
    var len = Math.hypot(dx, dy);
    var power = Math.min(14, len / 14);
    if (power < 0.5) return;
    var nx = dx / (len || 1), ny = dy / (len || 1);
    var id = nextId++;
    pucks.push({
      id: id, x: LAUNCHER.x, y: LAUNCHER.y,
      vx: nx * power, vy: ny * power,
      color: "hsl(" + ((id * 53) % 360) + ", 80%, 60%)",
      stopped: false, points: 0,
    });
  }

  function scorePuck(x, y) {
    var d = Math.hypot(x - TARGET.x, y - TARGET.y);
    for (var z of ZONES) if (d <= z.r) return z.pts;
    return 0;
  }

  function step() {
    for (var p of pucks) {
      if (p.stopped) continue;
      p.x += p.vx; p.y += p.vy;
      p.vx *= FRICTION; p.vy *= FRICTION;
      if (p.x < PUCK_R) { p.x = PUCK_R; p.vx = -p.vx * 0.85; }
      else if (p.x > W - PUCK_R) { p.x = W - PUCK_R; p.vx = -p.vx * 0.85; }
      if (p.y < PUCK_R) { p.y = PUCK_R; p.vy = -p.vy * 0.85; }
      else if (p.y > H - PUCK_R) { p.y = H - PUCK_R; p.vy = -p.vy * 0.85; }
    }
    // collisions
    for (var i = 0; i < pucks.length; i++) {
      var a = pucks[i];
      for (var j = i + 1; j < pucks.length; j++) {
        var b = pucks[j];
        var dx = b.x - a.x, dy = b.y - a.y;
        var ds = dx * dx + dy * dy, md = PUCK_R * 2;
        if (ds >= md * md || ds === 0) continue;
        var d = Math.sqrt(ds);
        var nx = dx / d, ny = dy / d, ov = (md - d) / 2;
        a.x -= nx * ov; a.y -= ny * ov;
        b.x += nx * ov; b.y += ny * ov;
        var rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn > 0) continue;
        var imp = -(1 + BOUNCE) * rvn / 2;
        a.vx -= imp * nx; a.vy -= imp * ny;
        b.vx += imp * nx; b.vy += imp * ny;
        if (a.stopped) { a.stopped = false; a.points = 0; }
        if (b.stopped) { b.stopped = false; b.points = 0; }
      }
    }
    // scoring
    score = 0;
    for (var p of pucks) {
      if (!p.stopped && Math.hypot(p.vx, p.vy) < REST) {
        p.stopped = true; p.vx = 0; p.vy = 0;
        p.points = scorePuck(p.x, p.y);
      }
      if (p.stopped) score += p.points;
    }
  }

  /* ── draw ──────────────────────────────────────────────── */
  function draw() {
    // Sync canvas buffer to display size
    var rect = canvas.getBoundingClientRect();
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
    }

    ctx.fillStyle = "#06080d";
    ctx.fillRect(0, 0, W, H);

    // zones
    for (var i = ZONES.length - 1; i >= 0; i--) {
      var z = ZONES[i];
      ctx.fillStyle = z.color; ctx.globalAlpha = 0.18;
      ctx.beginPath(); ctx.arc(TARGET.x, TARGET.y, z.r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = z.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(TARGET.x, TARGET.y, z.r, 0, Math.PI * 2); ctx.stroke();
    }

    // launcher
    ctx.fillStyle = "#8b949e";
    ctx.beginPath();
    ctx.moveTo(LAUNCHER.x - 12, LAUNCHER.y + 10);
    ctx.lineTo(LAUNCHER.x + 12, LAUNCHER.y + 10);
    ctx.lineTo(LAUNCHER.x, LAUNCHER.y - 10);
    ctx.closePath(); ctx.fill();

    // pucks
    for (var p of pucks) {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.stopped ? 0.9 : 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, PUCK_R, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff"; ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(p.id), p.x, p.y);
    }

    // score
    ctx.fillStyle = "#58a6ff"; ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.fillText(String(score), W - 8, 6);
    ctx.font = "10px sans-serif"; ctx.fillStyle = "#8b949e";
    ctx.fillText("score", W - 8, 28);

    // label
    ctx.fillStyle = isFollower ? "#bc8cff" : "#58a6ff";
    ctx.font = "10px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(isFollower ? "follower — replayed inputs" : "source — real inputs", 8, 6);
  }

  /* ── input ────────────────────────────────────────────── */
  canvas.addEventListener("pointerdown", function(ev) { drag = canvasXY(ev); canvas.setPointerCapture(ev.pointerId); });
  canvas.addEventListener("pointermove", function(ev) { if (drag) drag = canvasXY(ev); });
  canvas.addEventListener("pointerup", function() { if (drag) { launchPuck(drag.x, drag.y); drag = null; } });
  canvas.addEventListener("pointercancel", function() { drag = null; });

  /* ── main loop ────────────────────────────────────────── */
  function loop() {
    step();
    draw();
    requestAnimationFrame(loop);
  }

  /* ── v0.3 event loop replication ──────────────────────── */
  if (isFollower) {
    // Follower: install player, receive ops from parent via postMessage
    var player = createPlayer();
    window.addEventListener("message", function(ev) {
      if (ev.data && ev.data.type === "remjs-ops") {
        player.apply(ev.data.ops);
      }
    });
  } else {
    // Source: install recorder, send ops UP to parent who relays to mirror
    var recorder = createRecorder({
      onOps: function(ops) {
        // Post to parent (the mirror/embed page relays to the follower iframe)
        if (window.parent !== window) {
          window.parent.postMessage({ type: "remjs-source-ops", ops: ops }, "*");
        }
      },
      batchMode: "sync",
      events: true,
      timers: true,
      random: true,
      clock: true,
      network: false,
      storage: false,
    });

    recorder.start();
  }

  requestAnimationFrame(loop);
})();
  </script>
</body>
</html>`;

/* ── Mirror page (source + iframe side by side) ───────────────── */

const MIRROR_PAGE = (gameHtml) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>remjs mirror — event loop replication</title>
  <style>
    :root { color-scheme: dark; --font-sans: system-ui, -apple-system, sans-serif; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-sans); background: #0d1117; color: #e6edf3; }
    h1 { text-align: center; padding: 0.8em 0 0.2em; font-size: 1.3em; font-weight: 600; }
    .hint { text-align: center; color: #8b949e; font-size: 0.85em; padding-bottom: 0.8em;
      max-width: 700px; margin: 0 auto; line-height: 1.5; }
    .hint code { background: #161b22; padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.9em; }
    .panels { display: flex; gap: 4px; padding: 0 4px 4px; height: calc(100vh - 100px); }
    .panel { flex: 1; position: relative; border-radius: 6px; overflow: hidden; border: 1px solid #30363d; }
    .panel-label { position: absolute; top: 0; left: 0; right: 0; z-index: 1;
      font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.06em;
      padding: 6px 10px; background: rgba(13,17,23,0.85);
      display: flex; justify-content: space-between; pointer-events: none; }
    .panel-label .side { font-weight: 700; }
    .source .side { color: #58a6ff; }
    .mirror .side { color: #bc8cff; }
    .panel iframe { width: 100%; height: 100%; border: 0; }

    @media (max-width: 700px) {
      .panels { flex-direction: column; }
    }
  </style>
</head>
<body>
  <h1>remjs mirror — shuffleboard</h1>
  <p class="hint">
    <strong>Left</strong> runs with real inputs. <strong>Right</strong> replays
    recorded event-loop inputs (<code>Math.random</code>, <code>Date.now</code>,
    DOM events) via <code>createPlayer</code>. Same code, same inputs, identical output.
  </p>
  <div class="panels">
    <div class="panel source">
      <div class="panel-label"><span class="side">source — real inputs</span></div>
      <iframe id="sourceFrame"></iframe>
    </div>
    <div class="panel mirror">
      <div class="panel-label"><span class="side">follower — replayed inputs</span></div>
      <iframe id="mirrorFrame"></iframe>
    </div>
  </div>
  <script>
    // Use blob: URLs instead of srcdoc so postMessage works across origins
    var gameHtml = ${safeJsonEmbed(gameHtml)};
    var followerHtml = gameHtml.replace("</head>", "<script>window.__remjs_follower=true;<\\/script></head>");
    var sourceBlob = new Blob([gameHtml], {type: "text/html"});
    var mirrorBlob = new Blob([followerHtml], {type: "text/html"});
    document.getElementById("sourceFrame").src = URL.createObjectURL(sourceBlob);
    document.getElementById("mirrorFrame").src = URL.createObjectURL(mirrorBlob);

    // Relay: source posts "remjs-source-ops" up to us, we forward as "remjs-ops" down to mirror
    var mirrorFrame = document.getElementById("mirrorFrame");
    window.addEventListener("message", function(ev) {
      if (ev.data && ev.data.type === "remjs-source-ops") {
        mirrorFrame.contentWindow.postMessage({ type: "remjs-ops", ops: ev.data.ops }, "*");
      }
    });
  </script>
</body>
</html>`;

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** JSON.stringify that's safe to embed inside a <script> tag. */
function safeJsonEmbed(s) {
  return JSON.stringify(s).replace(/<\/script>/gi, "<\\/script>");
}

/* ── Embed page (for landing page iframe) ─────────────────────── */

const EMBED_PAGE = (gameHtml) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>remjs mirror embed</title>
  <style>
    :root { color-scheme: dark; --font-sans: system-ui, -apple-system, sans-serif; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-sans); background: #0d1117; color: #e6edf3; overflow: hidden; }
    .panels { display: flex; gap: 2px; height: 100vh; }
    .panel { flex: 1; position: relative; overflow: hidden; }
    .label { position: absolute; top: 4px; left: 8px; z-index: 1;
      font-size: 0.6em; text-transform: uppercase; letter-spacing: 0.06em;
      pointer-events: none; opacity: 0.7; }
    .source .label { color: #58a6ff; }
    .mirror .label { color: #bc8cff; }
    .panel iframe { width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>
  <div class="panels">
    <div class="panel source">
      <span class="label">source</span>
      <iframe id="sourceFrame"></iframe>
    </div>
    <div class="panel mirror">
      <span class="label">follower</span>
      <iframe id="mirrorFrame"></iframe>
    </div>
  </div>
  <script>
    var gameHtml = ${safeJsonEmbed(gameHtml)};
    var followerHtml = gameHtml.replace("</head>", "<script>window.__remjs_follower=true;<\\/script></head>");
    document.getElementById("sourceFrame").src = URL.createObjectURL(new Blob([gameHtml], {type:"text/html"}));
    document.getElementById("mirrorFrame").src = URL.createObjectURL(new Blob([followerHtml], {type:"text/html"}));
    var mirrorFrame = document.getElementById("mirrorFrame");
    window.addEventListener("message", function(ev) {
      if (ev.data && ev.data.type === "remjs-source-ops") {
        mirrorFrame.contentWindow.postMessage({ type: "remjs-ops", ops: ev.data.ops }, "*");
      }
    });
  </script>
</body>
</html>`;

/* ── Build ────────────────────────────────────────────────────── */

async function main() {
  const bundle = await buildBundle();
  const gameHtml = GAME_PAGE(bundle);

  const outputs = [
    { path: path.join(ROOT, "examples", "mirror", "index.html"), content: MIRROR_PAGE(gameHtml) },
    { path: path.join(ROOT, "docs", "mirror.html"), content: MIRROR_PAGE(gameHtml) },
    { path: path.join(ROOT, "docs", "mirror-embed.html"), content: EMBED_PAGE(gameHtml) },
  ];

  for (const { path: p, content } of outputs) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
    const kb = (Buffer.byteLength(content) / 1024).toFixed(1);
    console.log(`wrote ${path.relative(ROOT, p)} — ${kb} KB`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
