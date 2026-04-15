/**
 * Build the standalone strict-events demo HTML.
 *
 *   node scripts/build-strict-events-demo.mjs
 *
 * Single page with two panels:
 *   A. Non-strict follower: real user clicks fire the handler directly.
 *   B. Strict follower:     real user clicks are dropped by the filter;
 *                           only player-applied ops and app-code
 *                           dispatchEvent calls reach the handler.
 *
 * The install order here is deliberate and the whole point:
 *   1. attach all "observer" listeners that need to see trusted events
 *      (non-strict handler, dropped-click counter, demo control buttons)
 *   2. install the strict player — from here on, addEventListener is
 *      wrapped, and trusted events outside player-dispatch are filtered
 *   3. attach the strict follower's app handler THROUGH the wrapper
 *
 * In a real deployment the strict follower runs in its own process
 * (tab / iframe / peer) so install-order is trivial. This single-page
 * demo just illustrates the mechanics.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const SOURCES = [
  "ops.js", "codec.js", "synth-flag.js",
  "patches/clock.js", "patches/random.js",
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
  parts.push(`window.remjs = { createPlayer };`);
  return `(function(){"use strict";\n${parts.join("\n")}\n})();`;
}

const HTML = (bundle) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>remjs · strict events (0.5.2)</title>
<style>
  :root {
    --bg: #0d1017; --panel: #141924; --panel2: #0f1320; --ink: #e6edf3;
    --muted: #8b98a5; --dim: #5d6b7a; --accent: #6fa8dc; --ok: #7fcf73;
    --warn: #f0a04a; --bad: #e06767; --border: #2a3344; --hit: #f0c040;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink);
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px; }
  body { max-width: 1100px; margin: 0 auto; padding: 20px; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 16px; line-height: 1.5; }
  .sub code { background: #1a2030; padding: 1px 6px; border-radius: 4px; color: var(--accent);
    font-family: ui-monospace, monospace; font-size: 12px; }
  .sub strong { color: var(--ink); }
  .ctl { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
  button { background: var(--panel); border: 1px solid var(--border); color: var(--ink);
    padding: 7px 14px; border-radius: 6px; font-size: 12px; cursor: pointer;
    font-family: inherit; transition: background 0.15s; }
  button:hover:not(:disabled) { background: #1a2030; }
  button.primary { background: var(--accent); color: #0d1017; border-color: var(--accent); font-weight: 600; }
  button.primary:hover:not(:disabled) { background: #8fbbe0; }
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .panel.native { border-top: 2px solid var(--warn); }
  .panel.strict { border-top: 2px solid var(--ok); }
  .panel h2 { font-size: 12px; font-weight: 600; margin: 0 0 2px; letter-spacing: 0.04em;
    text-transform: uppercase; }
  .panel.native h2 { color: var(--warn); }
  .panel.strict h2 { color: var(--ok); }
  .panel .role { font-size: 11px; color: var(--muted); margin-bottom: 14px;
    font-family: ui-monospace, monospace; }
  .stage { background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
    padding: 20px; display: flex; flex-direction: column; gap: 14px; align-items: center;
    min-height: 160px; }
  .target-btn { background: #1a2030; border: 1px solid var(--border); color: var(--ink);
    padding: 12px 28px; border-radius: 6px; font-size: 15px; cursor: pointer;
    font-weight: 600; transition: background 0.15s; }
  .target-btn:hover { background: #243044; }
  .stats { display: flex; gap: 20px; font-variant-numeric: tabular-nums; flex-wrap: wrap;
    justify-content: center; }
  .stat { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .stat .n { font-size: 22px; font-weight: 700; line-height: 1; }
  .stat .l { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .panel.native .stat.primary .n { color: var(--warn); }
  .panel.strict .stat.primary .n { color: var(--ok); }
  .stat.trusted .n { color: var(--warn); }
  .stat.dropped .n { color: var(--bad); }
  .stat.synth .n { color: var(--accent); }
  .note { margin-top: 10px; padding: 8px 10px; background: #0a0e18; border-radius: 4px;
    font-size: 11px; line-height: 1.5; border-left: 2px solid var(--border); color: var(--muted); }
  .panel.native .note { border-left-color: var(--warn); }
  .panel.strict .note { border-left-color: var(--ok); }
  .note code { color: var(--accent); font-family: ui-monospace, monospace; }
  .note strong { color: var(--ink); }
  .log-wrap { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px; }
  .log-wrap h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); font-weight: 600; margin: 0 0 8px; }
  .log { font-family: ui-monospace, monospace; font-size: 11px; height: 140px;
    overflow-y: auto; background: var(--panel2); border-radius: 4px; padding: 8px; }
  .ln { color: var(--muted); margin-bottom: 2px; }
  .ln.ok { color: var(--ok); }
  .ln.drop { color: var(--bad); }
  .ln.synth { color: var(--accent); }
  .ln.native { color: var(--warn); }
</style>
</head>
<body>
  <h1>Strict events (remjs 0.5.2)</h1>
  <p class="sub">
    Both panels register <code>addEventListener("click", handler)</code> on a button.
    The <strong>non-strict</strong> panel treats native clicks as usual. The
    <strong>strict</strong> panel's wrapped <code>addEventListener</code> filters
    <code>event.isTrusted && !strictDispatching → drop</code> — native user input and
    cascaded events outside a player dispatch never reach the handler. Try clicking each button.
    Then use the control buttons to fire a player op (trusted-from-player → passes via the
    <code>strictDispatching</code> flag) or an app-code <code>dispatchEvent</code> (isTrusted=false → passes).
  </p>

  <div class="ctl">
    <button id="apply-op" class="primary">Apply click op → both followers</button>
    <button id="app-dispatch">App-code dispatchEvent (synthetic)</button>
    <button id="reset">Reset counters</button>
  </div>

  <div class="panels">
    <div class="panel native">
      <h2>Follower A · non-strict</h2>
      <div class="role">createPlayer({})</div>
      <div class="stage">
        <button class="target-btn" id="native-btn">click me</button>
        <div class="stats">
          <div class="stat primary"><span class="n" id="n-fires">0</span><span class="l">handler fires</span></div>
          <div class="stat trusted"><span class="n" id="n-trusted">0</span><span class="l">native clicks</span></div>
          <div class="stat synth"><span class="n" id="n-synth">0</span><span class="l">from op / synth</span></div>
        </div>
      </div>
      <div class="note">
        <strong>Native clicks reach the handler.</strong> No filter — the player doesn't
        patch <code>addEventListener</code> in non-strict mode.
      </div>
    </div>

    <div class="panel strict">
      <h2>Follower B · strict</h2>
      <div class="role">createPlayer({ strict: true })</div>
      <div class="stage">
        <button class="target-btn" id="strict-btn">click me</button>
        <div class="stats">
          <div class="stat primary"><span class="n" id="s-fires">0</span><span class="l">handler fires</span></div>
          <div class="stat dropped"><span class="n" id="s-dropped">0</span><span class="l">dropped trusted</span></div>
          <div class="stat synth"><span class="n" id="s-synth">0</span><span class="l">from op / synth</span></div>
        </div>
      </div>
      <div class="note">
        <strong>Native clicks are dropped.</strong> The wrapped <code>addEventListener</code>
        filter lets only player-originated or app-synthetic events through.
      </div>
    </div>
  </div>

  <div class="log-wrap">
    <h3>Event log</h3>
    <div class="log" id="log"></div>
  </div>

  <script>
${bundle}
  </script>

  <script>
(function () {
  const { createPlayer } = window.remjs;

  // DOM refs
  const log = document.getElementById("log");
  const nativeBtn = document.getElementById("native-btn");
  const strictBtn = document.getElementById("strict-btn");
  const applyOpBtn = document.getElementById("apply-op");
  const appDispatchBtn = document.getElementById("app-dispatch");
  const resetBtn = document.getElementById("reset");
  const nFires = document.getElementById("n-fires");
  const nTrusted = document.getElementById("n-trusted");
  const nSynth = document.getElementById("n-synth");
  const sFires = document.getElementById("s-fires");
  const sDropped = document.getElementById("s-dropped");
  const sSynth = document.getElementById("s-synth");

  // Counters
  let nativeFires = 0, nativeTrusted = 0, nativeSynth = 0;
  let strictFires = 0, strictDropped = 0, strictSynth = 0;

  function refresh() {
    nFires.textContent = nativeFires; nTrusted.textContent = nativeTrusted; nSynth.textContent = nativeSynth;
    sFires.textContent = strictFires; sDropped.textContent = strictDropped; sSynth.textContent = strictSynth;
  }

  function logLine(text, cls) {
    const div = document.createElement("div");
    div.className = "ln" + (cls ? " " + cls : "");
    div.textContent = text;
    log.insertBefore(div, log.firstChild);
    while (log.children.length > 80) log.removeChild(log.lastChild);
  }

  // ── Phase 1: attach everything that needs to see trusted events
  //    unfiltered. This happens BEFORE the strict player installs.
  // ──────────────────────────────────────────────────────────────

  // Non-strict follower's app handler on its button.
  function nativeHandler(e) {
    nativeFires++;
    if (e.isTrusted) { nativeTrusted++; logLine("[A] handler fires (trusted click, isTrusted=true)", "native"); }
    else             { nativeSynth++;   logLine("[A] handler fires (synthetic, isTrusted=false)", "synth"); }
    refresh();
  }
  nativeBtn.addEventListener("click", nativeHandler);

  // Observer on the strict button. Attached BEFORE strict install, so
  // it bypasses the wrapper and always sees the raw event — including
  // trusted clicks the strict wrapper is about to drop. Used to count
  // the drops so you can see the filter is working.
  strictBtn.addEventListener("click", function observer(e) {
    if (e.isTrusted) {
      strictDropped++;
      logLine("[B] native click dropped by strict filter (isTrusted=true, strictDispatching=false)", "drop");
      refresh();
    }
  }, true);

  // Demo control buttons — also attached before strict install so they
  // keep working when the user clicks them (trusted events).
  applyOpBtn.addEventListener("click", applyClickOp);
  appDispatchBtn.addEventListener("click", appDispatchSynthetic);
  resetBtn.addEventListener("click", reset);

  // ── Phase 2: install the strict player.
  //    From here on, every addEventListener call goes through the
  //    strict wrapper.
  // ──────────────────────────────────────────────────────────────

  const nativePlayer = createPlayer({
    timers: false, network: false, random: false, clock: false, storage: false,
  });
  nativePlayer.apply([]); // no-op install path; doesn't touch addEventListener

  const strictPlayer = createPlayer({
    strict: true,
    timers: false, network: false, random: false, clock: false, storage: false,
  });
  strictPlayer.apply([]); // installs the strict event wrapper

  // ── Phase 3: register the strict follower's app handler THROUGH
  //    the wrapper. Now filter applies: handler only fires when
  //    event is synthetic OR strictDispatching is true.
  // ──────────────────────────────────────────────────────────────

  function strictHandler(e) {
    strictFires++;
    if (e.isTrusted) {
      logLine("[B] handler fires (trusted, inside player dispatch)", "ok");
    } else {
      strictSynth++;
      logLine("[B] handler fires (synthetic, isTrusted=false)", "synth");
    }
    refresh();
  }
  strictBtn.addEventListener("click", strictHandler);

  // ── Controls ──
  function applyClickOp() {
    const ts = performance.now();
    nativePlayer.apply([{
      type: "event", eventType: "click", targetPath: "#native-btn",
      timestamp: ts, detail: { clientX: 0, clientY: 0, button: 0, buttons: 0 },
    }]);
    strictPlayer.apply([{
      type: "event", eventType: "click", targetPath: "#strict-btn",
      timestamp: ts, detail: { clientX: 0, clientY: 0, button: 0, buttons: 0 },
    }]);
    logLine("[OP] click dispatched via player.apply → both followers", "ok");
  }

  function appDispatchSynthetic() {
    nativeBtn.dispatchEvent(new Event("click"));
    strictBtn.dispatchEvent(new Event("click"));
    logLine("[APP] dispatchEvent(new Event('click')) on both buttons (isTrusted=false)", "synth");
  }

  function reset() {
    nativeFires = nativeTrusted = nativeSynth = 0;
    strictFires = strictDropped = strictSynth = 0;
    refresh();
    log.innerHTML = "";
  }

  refresh();
  logLine("ready — click either panel's button, or use the controls above", "");
})();
  </script>
</body>
</html>
`;

async function main() {
  const bundle = await buildBundle();
  const html = HTML(bundle);
  const out = path.join(ROOT, "docs", "strict-events.html");
  await fs.writeFile(out, html, "utf8");
  console.log(`wrote ${path.relative(ROOT, out)} — ${(html.length / 1024).toFixed(1)} KB`);
}

main();
