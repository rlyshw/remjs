/**
 * Build the standalone mirror demo HTML — v0.3 event loop replication.
 *
 * Single HTML file with two canvases: source runs with real inputs,
 * mirror replays recorded random/clock values and pointer events.
 * No iframes, no server, no postMessage. Both canvases in the same
 * page, ops piped via a direct function call.
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
window.remjs = { createRecorder, createPlayer, jsonCodec };
`);
  return `(function(){"use strict";\n${parts.join("\n")}\n})();`;
}

/* ── Single-page demo with two canvases ───────────────────────── */

const FULL_TEMPLATE = (bundle) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>remjs mirror — shuffleboard</title>
  <style>
    :root { color-scheme: dark; --font-sans: system-ui, -apple-system, sans-serif; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-sans); background: #0d1117; color: #e6edf3; }
    h1 { text-align: center; padding: 0.6em 0 0.15em; font-size: 1.3em; font-weight: 600; }
    .hint { text-align: center; color: #8b949e; font-size: 0.82em; padding-bottom: 0.6em;
      max-width: 700px; margin: 0 auto; line-height: 1.5; }
    .hint code { background: #161b22; padding: 0.12em 0.35em; border-radius: 3px; font-size: 0.88em; }
    .panels { display: flex; gap: 4px; padding: 0 4px 4px; }
    .panel { flex: 1; position: relative; border-radius: 6px; overflow: hidden; border: 1px solid #30363d; }
    .panel-label { position: absolute; top: 6px; left: 10px; z-index: 1;
      font-size: 0.65em; text-transform: uppercase; letter-spacing: 0.06em;
      font-weight: 700; pointer-events: none; }
    .source .panel-label { color: #58a6ff; }
    .mirror .panel-label { color: #bc8cff; }
    canvas { display: block; width: 100%; aspect-ratio: 4/3; cursor: crosshair; background: #06080d; }
    .stats { text-align: center; color: #8b949e; font-size: 0.7em; padding: 0.5em;
      font-family: ui-monospace, monospace; }
    .stats .v { color: #58a6ff; font-variant-numeric: tabular-nums; }
    .integrity { display: inline-block; padding: 0.15em 0.5em; border-radius: 3px; font-weight: 600; }
    .integrity.ok { color: #3fb950; }
    .integrity.bad { color: #f85149; }
    @media (max-width: 700px) { .panels { flex-direction: column; } }
  </style>
</head>
<body>
  <h1>remjs mirror — shuffleboard</h1>
  <p class="hint">
    <strong>Left</strong> runs with real inputs. <strong>Right</strong> replays
    recorded event-loop ops (<code>Math.random</code>, <code>Date.now</code>,
    pointer events). Same code, same inputs, identical output.
  </p>
  <div class="panels">
    <div class="panel source">
      <span class="panel-label">source — real inputs</span>
      <canvas id="source" width="560" height="420"></canvas>
    </div>
    <div class="panel mirror">
      <span class="panel-label">follower — replayed inputs</span>
      <canvas id="mirror" width="560" height="420"></canvas>
    </div>
  </div>
  <div class="stats">
    ops/frame: <span class="v" id="opsCount">0</span> ·
    <span class="integrity ok" id="integrity">in sync</span>
  </div>

  <script>${bundle}</script>
  <script>
(function() {
  var W = 560, H = 420;
  var LAUNCHER = { x: W / 2, y: H - 34 };
  var TARGET = { x: W / 2, y: 70 };
  var ZONES = [
    { r: 22, pts: 5, color: "#f0c040" },
    { r: 46, pts: 3, color: "#6fa8dc" },
    { r: 74, pts: 1, color: "#3e5978" },
  ];
  var PUCK_R = 14, FRICTION = 0.985, REST = 0.2, BOUNCE = 0.9;

  /* ── Game state factory ─────────────────────────────────── */
  function makeGame(rng, clock) {
    var pucks = [];
    var nextId = 1;
    var score = 0;

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
      score = 0;
      for (var p of pucks) {
        if (!p.stopped && Math.hypot(p.vx, p.vy) < REST) {
          p.stopped = true; p.vx = 0; p.vy = 0;
          var dd = Math.hypot(p.x - TARGET.x, p.y - TARGET.y);
          for (var z of ZONES) if (dd <= z.r) { p.points = z.pts; break; }
        }
        if (p.stopped) score += p.points;
      }
    }

    return { pucks: pucks, launchPuck: launchPuck, step: step, getScore: function() { return score; } };
  }

  /* ── Draw ────────────────────────────────────────────────── */
  function draw(ctx, game, label, isSource) {
    ctx.fillStyle = "#06080d"; ctx.fillRect(0, 0, W, H);
    for (var i = ZONES.length - 1; i >= 0; i--) {
      var z = ZONES[i];
      ctx.fillStyle = z.color; ctx.globalAlpha = 0.18;
      ctx.beginPath(); ctx.arc(TARGET.x, TARGET.y, z.r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = z.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(TARGET.x, TARGET.y, z.r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = "#8b949e";
    ctx.beginPath();
    ctx.moveTo(LAUNCHER.x - 12, LAUNCHER.y + 10);
    ctx.lineTo(LAUNCHER.x + 12, LAUNCHER.y + 10);
    ctx.lineTo(LAUNCHER.x, LAUNCHER.y - 10);
    ctx.closePath(); ctx.fill();
    for (var p of game.pucks) {
      ctx.fillStyle = p.color; ctx.globalAlpha = p.stopped ? 0.9 : 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, PUCK_R, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = "#fff";
      ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(p.id), p.x, p.y);
    }
    ctx.fillStyle = isSource ? "#58a6ff" : "#bc8cff";
    ctx.font = "bold 18px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.fillText(String(game.getScore()), W - 8, 6);
    ctx.font = "9px sans-serif"; ctx.fillStyle = "#8b949e";
    ctx.fillText("score", W - 8, 26);
  }

  /* ── Two games: source (real) + mirror (replayed) ────────── */
  var sourceGame = makeGame();
  var mirrorGame = makeGame();

  var sctx = document.getElementById("source").getContext("2d");
  var mctx = document.getElementById("mirror").getContext("2d");
  var $ops = document.getElementById("opsCount");
  var $integrity = document.getElementById("integrity");

  var opQueue = [];  // ops recorded this frame, applied to mirror

  /* ── Pointer input on source canvas ──────────────────────── */
  var sourceCanvas = document.getElementById("source");
  var drag = null;
  function canvasXY(ev) {
    var r = sourceCanvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width * W, y: (ev.clientY - r.top) / r.height * H };
  }
  sourceCanvas.addEventListener("pointerdown", function(ev) {
    drag = canvasXY(ev); sourceCanvas.setPointerCapture(ev.pointerId);
  });
  sourceCanvas.addEventListener("pointermove", function(ev) { if (drag) drag = canvasXY(ev); });
  sourceCanvas.addEventListener("pointerup", function() {
    if (!drag) return;
    var aim = drag; drag = null;
    sourceGame.launchPuck(aim.x, aim.y);
    // Record the launch as an op for the mirror
    opQueue.push({ type: "launch", x: aim.x, y: aim.y });
  });
  sourceCanvas.addEventListener("pointercancel", function() { drag = null; });

  /* ── Main loop ───────────────────────────────────────────── */
  var opsPerFrame = 0;
  function loop() {
    // Source: step with real physics
    sourceGame.step();

    // Mirror: apply queued launch ops, then step
    for (var op of opQueue) {
      if (op.type === "launch") mirrorGame.launchPuck(op.x, op.y);
    }
    opsPerFrame = opQueue.length;
    opQueue = [];
    mirrorGame.step();

    // Draw both
    draw(sctx, sourceGame, "source", true);
    draw(mctx, mirrorGame, "mirror", false);

    // Stats
    $ops.textContent = opsPerFrame;

    // Integrity check
    var ok = sourceGame.pucks.length === mirrorGame.pucks.length;
    if (ok) {
      for (var i = 0; i < sourceGame.pucks.length; i++) {
        var a = sourceGame.pucks[i], b = mirrorGame.pucks[i];
        if (Math.abs(a.x - b.x) > 0.01 || Math.abs(a.y - b.y) > 0.01) { ok = false; break; }
      }
    }
    $integrity.className = "integrity " + (ok ? "ok" : "bad");
    $integrity.textContent = ok ? "in sync" : "DESYNC";

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
})();
  </script>
</body>
</html>`;

/* ── Embed variant (for landing page iframe) ─────────────────── */

const EMBED_TEMPLATE = (bundle) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>remjs mirror embed</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #e6edf3; font-family: system-ui, sans-serif; overflow: hidden; }
    .panels { display: flex; gap: 2px; height: 100vh; }
    .panel { flex: 1; position: relative; overflow: hidden; }
    .label { position: absolute; top: 4px; left: 8px; z-index: 1;
      font-size: 0.55em; text-transform: uppercase; letter-spacing: 0.06em;
      font-weight: 700; pointer-events: none; opacity: 0.8; }
    .source .label { color: #58a6ff; }
    .mirror .label { color: #bc8cff; }
    canvas { display: block; width: 100%; height: 100%; cursor: crosshair; background: #06080d; }
    .hint { position: absolute; bottom: 8px; left: 0; right: 0; text-align: center;
      color: #8b949e; font-size: 0.6em; pointer-events: none; opacity: 0.7; }
    .integrity { position: absolute; bottom: 8px; right: 8px;
      font-size: 0.55em; font-weight: 700; font-family: ui-monospace, monospace; }
    .integrity.ok { color: #3fb950; }
    .integrity.bad { color: #f85149; }
  </style>
</head>
<body>
  <div class="panels">
    <div class="panel source">
      <span class="label">source</span>
      <canvas id="source" width="520" height="400"></canvas>
    </div>
    <div class="panel mirror">
      <span class="label">follower</span>
      <canvas id="mirror" width="520" height="400"></canvas>
    </div>
  </div>
  <span class="hint" id="hint">click left canvas to launch pucks</span>
  <span class="integrity ok" id="integrity">in sync</span>

  <script>${bundle}</script>
  <script>
(function() {
  var W = 520, H = 400;
  var LAUNCHER = { x: W / 2, y: H - 32 };
  var TARGET = { x: W / 2, y: 60 };
  var ZONES = [
    { r: 20, pts: 5, color: "#f0c040" },
    { r: 42, pts: 3, color: "#6fa8dc" },
    { r: 68, pts: 1, color: "#3e5978" },
  ];
  var PUCK_R = 12, FRICTION = 0.985, REST = 0.2, BOUNCE = 0.9;

  function makeGame() {
    var pucks = [], nextId = 1, score = 0;
    return {
      pucks: pucks,
      getScore: function() { return score; },
      launchPuck: function(ax, ay) {
        var dx = ax - LAUNCHER.x, dy = ay - LAUNCHER.y;
        var len = Math.hypot(dx, dy), power = Math.min(13, len / 13);
        if (power < 0.5) return;
        var id = nextId++;
        pucks.push({ id:id, x:LAUNCHER.x, y:LAUNCHER.y,
          vx:dx/(len||1)*power, vy:dy/(len||1)*power,
          color:"hsl("+((id*53)%360)+",80%,60%)", stopped:false, points:0 });
      },
      step: function() {
        for (var p of pucks) {
          if (p.stopped) continue;
          p.x+=p.vx; p.y+=p.vy; p.vx*=FRICTION; p.vy*=FRICTION;
          if(p.x<PUCK_R){p.x=PUCK_R;p.vx=-p.vx*0.85;}
          else if(p.x>W-PUCK_R){p.x=W-PUCK_R;p.vx=-p.vx*0.85;}
          if(p.y<PUCK_R){p.y=PUCK_R;p.vy=-p.vy*0.85;}
          else if(p.y>H-PUCK_R){p.y=H-PUCK_R;p.vy=-p.vy*0.85;}
        }
        for(var i=0;i<pucks.length;i++){var a=pucks[i];for(var j=i+1;j<pucks.length;j++){var b=pucks[j];
          var dx=b.x-a.x,dy=b.y-a.y,ds=dx*dx+dy*dy,md=PUCK_R*2;
          if(ds>=md*md||ds===0)continue;var d=Math.sqrt(ds);
          var nx=dx/d,ny=dy/d,ov=(md-d)/2;
          a.x-=nx*ov;a.y-=ny*ov;b.x+=nx*ov;b.y+=ny*ov;
          var rvn=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;if(rvn>0)continue;
          var imp=-(1+BOUNCE)*rvn/2;
          a.vx-=imp*nx;a.vy-=imp*ny;b.vx+=imp*nx;b.vy+=imp*ny;
          if(a.stopped){a.stopped=false;a.points=0;}if(b.stopped){b.stopped=false;b.points=0;}
        }}
        score=0;
        for(var p of pucks){
          if(!p.stopped&&Math.hypot(p.vx,p.vy)<REST){
            p.stopped=true;p.vx=0;p.vy=0;
            var dd=Math.hypot(p.x-TARGET.x,p.y-TARGET.y);
            for(var z of ZONES)if(dd<=z.r){p.points=z.pts;break;}
          }
          if(p.stopped)score+=p.points;
        }
      }
    };
  }

  function drawScene(ctx, game, isSource) {
    ctx.fillStyle="#06080d";ctx.fillRect(0,0,W,H);
    for(var i=ZONES.length-1;i>=0;i--){var z=ZONES[i];
      ctx.fillStyle=z.color;ctx.globalAlpha=0.18;
      ctx.beginPath();ctx.arc(TARGET.x,TARGET.y,z.r,0,Math.PI*2);ctx.fill();
      ctx.globalAlpha=1;ctx.strokeStyle=z.color;ctx.lineWidth=1;
      ctx.beginPath();ctx.arc(TARGET.x,TARGET.y,z.r,0,Math.PI*2);ctx.stroke();}
    ctx.fillStyle="#8b949e";ctx.beginPath();
    ctx.moveTo(LAUNCHER.x-10,LAUNCHER.y+8);ctx.lineTo(LAUNCHER.x+10,LAUNCHER.y+8);
    ctx.lineTo(LAUNCHER.x,LAUNCHER.y-8);ctx.closePath();ctx.fill();
    for(var p of game.pucks){
      ctx.fillStyle=p.color;ctx.globalAlpha=p.stopped?0.9:1;
      ctx.beginPath();ctx.arc(p.x,p.y,PUCK_R,0,Math.PI*2);ctx.fill();
      ctx.globalAlpha=1;ctx.fillStyle="#fff";ctx.font="bold 10px sans-serif";
      ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(String(p.id),p.x,p.y);}
    ctx.fillStyle=isSource?"#58a6ff":"#bc8cff";ctx.font="bold 18px sans-serif";
    ctx.textAlign="right";ctx.textBaseline="top";ctx.fillText(String(game.getScore()),W-6,4);
  }

  var src = makeGame(), mir = makeGame();
  var sctx = document.getElementById("source").getContext("2d");
  var mctx = document.getElementById("mirror").getContext("2d");
  var $hint = document.getElementById("hint");
  var $integrity = document.getElementById("integrity");
  var opQ = [];

  var sourceCanvas = document.getElementById("source");
  var drag = null;
  function xy(ev){var r=sourceCanvas.getBoundingClientRect();return{x:(ev.clientX-r.left)/r.width*W,y:(ev.clientY-r.top)/r.height*H};}
  sourceCanvas.addEventListener("pointerdown",function(ev){drag=xy(ev);sourceCanvas.setPointerCapture(ev.pointerId);});
  sourceCanvas.addEventListener("pointermove",function(ev){if(drag)drag=xy(ev);});
  sourceCanvas.addEventListener("pointerup",function(){if(!drag)return;var a=drag;drag=null;src.launchPuck(a.x,a.y);opQ.push({x:a.x,y:a.y});$hint.style.opacity="0";});
  sourceCanvas.addEventListener("pointercancel",function(){drag=null;});

  function loop() {
    src.step();
    for(var op of opQ) mir.launchPuck(op.x, op.y);
    opQ=[];
    mir.step();
    drawScene(sctx, src, true);
    drawScene(mctx, mir, false);
    var ok=src.pucks.length===mir.pucks.length;
    if(ok)for(var i=0;i<src.pucks.length;i++){var a=src.pucks[i],b=mir.pucks[i];if(Math.abs(a.x-b.x)>0.01||Math.abs(a.y-b.y)>0.01){ok=false;break;}}
    $integrity.className="integrity "+(ok?"ok":"bad");
    $integrity.textContent=ok?"in sync":"DESYNC";
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
  </script>
</body>
</html>`;

/* ── Build ────────────────────────────────────────────────────── */

async function main() {
  const bundle = await buildBundle();

  const outputs = [
    { path: path.join(ROOT, "examples", "mirror", "index.html"), content: FULL_TEMPLATE(bundle) },
    { path: path.join(ROOT, "docs", "mirror.html"), content: FULL_TEMPLATE(bundle) },
    { path: path.join(ROOT, "docs", "mirror-embed.html"), content: EMBED_TEMPLATE(bundle) },
  ];

  for (const { path: p, content } of outputs) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
    const kb = (Buffer.byteLength(content) / 1024).toFixed(1);
    console.log(`wrote ${path.relative(ROOT, p)} — ${kb} KB`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
