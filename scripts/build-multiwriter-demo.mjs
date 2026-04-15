/**
 * Build the multi-writer mesh demo HTML.
 *
 *   node scripts/build-multiwriter-demo.mjs
 *
 * Produces docs/multiwriter.html. Open it in two browser tabs. Each
 * tab picks a peer ID, runs a recorder + player, and broadcasts ops
 * over BroadcastChannel. Type in either tab; the other tab's chat
 * input fills in real-time as your keystrokes replicate. Submit on
 * either side and the message appends to the shared log on both.
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
<title>remjs · multi-writer mesh (0.5.5)</title>
<style>
  :root {
    --bg: #0d1017; --panel: #141924; --panel2: #0f1320; --ink: #e6edf3;
    --muted: #8b98a5; --dim: #5d6b7a; --accent: #6fa8dc; --ok: #7fcf73;
    --warn: #f0a04a; --bad: #e06767; --border: #2a3344;
    --alice: #f0a04a; --bob: #6fa8dc; --carol: #7fcf73; --dave: #e06767;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink);
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px; }
  body { max-width: 900px; margin: 0 auto; padding: 20px; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 16px; line-height: 1.5; }
  .sub code { background: #1a2030; padding: 1px 6px; border-radius: 4px; color: var(--accent);
    font-family: ui-monospace, monospace; font-size: 12px; }
  .sub strong { color: var(--ink); }

  .header { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 16px; margin-bottom: 14px; display: flex; align-items: center; gap: 14px;
    flex-wrap: wrap; }
  .header .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); font-weight: 600; }
  .peer-badge { font-family: ui-monospace, monospace; font-size: 13px; font-weight: 600;
    padding: 4px 10px; border-radius: 4px; background: #1a2030; }
  .peer-badge.alice { color: var(--alice); }
  .peer-badge.bob { color: var(--bob); }
  .peer-badge.carol { color: var(--carol); }
  .peer-badge.dave { color: var(--dave); }
  .header .instruction { margin-left: auto; color: var(--muted); font-size: 11px; }
  .header button { background: var(--panel2); border: 1px solid var(--border); color: var(--ink);
    padding: 5px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; font-family: inherit; }

  .chat { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; margin-bottom: 14px; }
  .chat h2 { font-size: 12px; font-weight: 600; margin: 0 0 10px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.04em; }
  .messages { background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
    padding: 10px; height: 220px; overflow-y: auto; margin-bottom: 10px;
    font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; }
  .msg { margin-bottom: 3px; }
  .msg .who { font-weight: 700; margin-right: 6px; }
  .msg .who.alice { color: var(--alice); }
  .msg .who.bob { color: var(--bob); }
  .msg .who.carol { color: var(--carol); }
  .msg .who.dave { color: var(--dave); }
  .msg.system { color: var(--dim); font-style: italic; }

  .compose { display: flex; gap: 8px; }
  .compose input { flex: 1; background: var(--panel2); border: 1px solid var(--border);
    color: var(--ink); padding: 8px 12px; border-radius: 6px; font-size: 13px;
    font-family: inherit; }
  .compose input:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
  .compose button { background: var(--accent); border: 1px solid var(--accent); color: #0d1017;
    padding: 8px 18px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;
    font-family: inherit; }

  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
  .stat { background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
    padding: 10px 14px; }
  .stat .n { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat .l { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); margin-top: 2px; }

  .log-wrap { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px; }
  .log-wrap h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); font-weight: 600; margin: 0 0 8px; }
  .log { font-family: ui-monospace, monospace; font-size: 11px; height: 160px;
    overflow-y: auto; background: var(--panel2); border-radius: 4px; padding: 8px;
    line-height: 1.5; }
  .logline { margin-bottom: 2px; }
  .logline.out { color: var(--ok); }
  .logline.in { color: var(--accent); }
  .logline.echo { color: var(--dim); }
  .logline.system { color: var(--warn); }
</style>
</head>
<body>
  <h1>Multi-writer mesh (remjs 0.5.5)</h1>
  <p class="sub">
    Open this page in <strong>two browser tabs</strong> (or windows) on the same
    origin. Each tab picks a peer ID, runs a <code>createRecorder</code> + <code>createPlayer</code>
    pair, and broadcasts ops over a <code>BroadcastChannel</code>. Type in either
    chat input — your keystrokes replicate live into the other tab's input box
    via <code>input</code> events. Submit on either side and the message appends
    to the shared log on both.
  </p>

  <div class="header">
    <span class="label">You are</span>
    <span class="peer-badge" id="peer-badge">—</span>
    <span class="label" style="margin-left: 20px;">Channel</span>
    <code style="font-size: 12px; color: var(--accent);">remjs-multiwriter</code>
    <button id="reroll" class="instruction">reroll peer ID</button>
  </div>

  <div class="chat">
    <h2>Shared chat</h2>
    <div class="messages" id="messages"></div>
    <form class="compose" id="compose">
      <input type="text" id="msg-input" placeholder="type a message…" autocomplete="off" />
      <button type="submit">Send</button>
    </form>
  </div>

  <div class="stats">
    <div class="stat"><div class="n" id="n-sent">0</div><div class="l">ops emitted</div></div>
    <div class="stat"><div class="n" id="n-received">0</div><div class="l">ops applied from peers</div></div>
    <div class="stat"><div class="n" id="n-echoes">0</div><div class="l">own echoes dropped</div></div>
  </div>

  <div class="log-wrap">
    <h3>Op wire log <span style="color: var(--muted); font-weight: 400; text-transform: none; letter-spacing: 0;">
      — <span style="color: var(--ok)">out</span> · <span style="color: var(--accent)">in from peer</span> · <span style="color: var(--dim)">own echo</span>
    </span></h3>
    <div class="log" id="log"></div>
  </div>

  <script>
${bundle}
  </script>

  <script>
(function () {
  const { createRecorder, createPlayer, jsonCodec } = window.remjs;

  // ── Peer identity ──
  const names = ["alice", "bob", "carol", "dave"];
  function pickPeer() {
    const fromHash = (location.hash || "").slice(1);
    if (names.includes(fromHash)) return fromHash;
    return names[Math.floor(Math.random() * names.length)];
  }
  let me = pickPeer();
  const peerBadge = document.getElementById("peer-badge");
  function paintPeer() {
    peerBadge.textContent = me;
    peerBadge.className = "peer-badge " + me;
    document.title = "remjs · multi-writer · " + me;
  }
  paintPeer();

  // ── UI refs ──
  const messages = document.getElementById("messages");
  const form = document.getElementById("compose");
  const input = document.getElementById("msg-input");
  const log = document.getElementById("log");
  const nSent = document.getElementById("n-sent");
  const nReceived = document.getElementById("n-received");
  const nEchoes = document.getElementById("n-echoes");
  const rerollBtn = document.getElementById("reroll");

  let sent = 0, received = 0, echoes = 0;
  function refreshStats() {
    nSent.textContent = sent;
    nReceived.textContent = received;
    nEchoes.textContent = echoes;
  }

  function logLine(text, cls) {
    const div = document.createElement("div");
    div.className = "logline " + (cls || "");
    div.textContent = text;
    log.insertBefore(div, log.firstChild);
    while (log.children.length > 80) log.removeChild(log.lastChild);
  }

  function appendMessage(peer, text) {
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = '<span class="who ' + peer + '">' + peer + ':</span>' +
      document.createTextNode(text).textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function systemMessage(text) {
    const div = document.createElement("div");
    div.className = "msg system";
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── Mesh transport ──
  const ch = new BroadcastChannel("remjs-multiwriter");

  // ── Player: applies remote ops ──
  const player = createPlayer();
  player.apply([]); // force install

  ch.onmessage = (e) => {
    const { from, ops } = jsonCodec.decodeBatchWithMeta(e.data);
    if (from === me) {
      // Echo of our own batch — the recorder already fired the handler
      // locally. Drop to avoid double-firing.
      echoes += ops.length;
      for (const op of ops) logLine("← " + op.type + " from=" + from + " (echo, dropped)", "echo");
      refreshStats();
      return;
    }
    received += ops.length;
    for (const op of ops) logLine("← " + op.type + " from=" + from + " (applied)", "in");
    player.apply(ops);
    refreshStats();
  };

  // ── Recorder: captures local inputs and broadcasts ──
  const recorder = createRecorder({
    onOps: (ops) => {
      sent += ops.length;
      for (const op of ops) logLine("→ " + op.type + " from=" + me, "out");
      ch.postMessage(jsonCodec.encodeBatchWithMeta({ from: me, ops }));
      refreshStats();
    },
    batchMode: "task",
    peer: me,
    timers: false, network: false, random: false, clock: false, storage: false,
  });

  // ── App logic ──
  // The submit handler is registered BEFORE the recorder starts, so it's
  // a plain native listener. When a remote submit op arrives, the player
  // dispatches a synthetic submit event; the browser fires our handler;
  // handler reads input.value (which the remote peer's input events have
  // already populated) and appends the message.
  function handleSubmit(e) {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    // Determine who submitted: check the target's ownerDocument? The
    // simpler model: whoever "owns" the submit event is whoever sent
    // the ops. We pull the peer from the event's op metadata via a
    // runtime trick — the last op applied carries 'peer'. But for
    // synchronously-dispatched events we don't have that context.
    //
    // Cleanest approach: identify the sender through the input field's
    // value prefix pattern, OR via a hidden data attribute we write
    // before submit. We use the simpler approach: each peer prepends
    // its name. But that requires coordination too.
    //
    // Best pragmatic answer for this demo: use a WeakMap of
    // event→peer populated by the player. Since this is demo code,
    // we lean on \`lastAppliedPeer\` variable set by the player's
    // apply wrapper. See below.
    const who = currentDispatchPeer || me;
    appendMessage(who, text);
    input.value = "";
  }
  form.addEventListener("submit", handleSubmit);

  // Track "who produced the op we're currently applying" so the
  // submit handler knows which peer to attribute the message to.
  let currentDispatchPeer = null;
  const origApply = player.apply.bind(player);
  player.apply = function (ops, options) {
    // Find the peer from the first op that has one (all ops in a
    // batch share peer because the recorder stamps per emit; they
    // all come from the same producer).
    for (const op of ops) {
      if (op.peer) { currentDispatchPeer = op.peer; break; }
    }
    try { return origApply(ops, options); }
    finally { currentDispatchPeer = null; }
  };

  recorder.start();

  systemMessage("joined as " + me + " — try opening a second tab (add #alice, #bob, #carol, or #dave to the URL)");
  refreshStats();

  // ── Reroll ──
  rerollBtn.addEventListener("click", () => {
    me = names[(names.indexOf(me) + 1) % names.length];
    location.hash = me;
    location.reload();
  });
})();
  </script>
</body>
</html>
`;

async function main() {
  const bundle = await buildBundle();
  const html = HTML(bundle);
  const out = path.join(ROOT, "docs", "multiwriter.html");
  await fs.writeFile(out, html, "utf8");
  console.log(`wrote ${path.relative(ROOT, out)} — ${(html.length / 1024).toFixed(1)} KB`);
}

main();
