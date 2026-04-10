/**
 * Live remjs state graph inspector — drop-in pane for any demo.
 *
 * Usage:
 *   import { createInspector } from "/_shared/inspector.js";
 *   const inspector = createInspector(document.getElementById("inspector"));
 *
 *   // Forward every WebSocket message to the inspector. The shared
 *   // demo client (`/_shared/client.js`) does this via `onMessage`.
 *   inspector.onMessage(msg);
 *
 * The inspector owns its own DOM (header, canvas, tabbed bottom panel),
 * built into the supplied container element. The CSS lives in
 * `/_shared/inspector.css`. The graph is built from snapshot ops; live
 * ops animate node flashes. Click a node to select it; the bottom
 * panel switches to "details" and shows the selected node's encoded
 * contents as pretty JSON, updated on every op that touches it.
 */

const TAG = "__remjs";

/* ── Layout constants ────────────────────────────────────────────
   Tuned for stability with 1–25 nodes. Stronger damping + smaller
   forces prevent the perpetual jitter that bigger graphs would
   otherwise show with the dashboard's chatty op stream. */
const REPULSION = 3500;
const SPRING_K = 0.012;
const DAMPING = 0.72;
const CENTER_PULL = 0.0004;
const VELOCITY_FLOOR = 0.05; // below this, snap to zero (kills micro-jitter) */

/** Compute a viewport-aware node radius based on canvas size and node
 *  count. Big canvases get bigger nodes; many nodes shrink to fit. */
function computeNodeR(canvas, nodeCount) {
  const w = canvas.clientWidth || 400;
  const h = canvas.clientHeight || 300;
  const minDim = Math.min(w, h);
  const base = minDim / 14; // ~28px on a 400px canvas
  const n = Math.max(1, nodeCount);
  // Shrink as more nodes pack in (sqrt scaling).
  const densityScale = n > 8 ? Math.sqrt(8 / n) : 1;
  return Math.max(10, Math.min(36, base * densityScale));
}

/** Spring rest length scales with node radius so the layout looks
 *  consistent at any zoom level. */
function computeSpringLen(nodeR) {
  return nodeR * 4.5;
}

class Node {
  constructor(id, kind, encoded) {
    this.id = id;
    this.kind = kind;
    this.encoded = encoded;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.highlight = 1;
    this.alpha = 0;
    this.dragged = false;
    this.label = "";
    this.refs = new Set();
    this.updateRefs();
    this.updateLabel();
  }
  updateRefs() {
    const refs = new Set();
    walkRefs(this.encoded, (id) => refs.add(id));
    this.refs = refs;
  }
  updateLabel() {
    if (this.kind === "array") {
      const len = Array.isArray(this.encoded) ? this.encoded.length : 0;
      this.label = "[" + len + "]";
    } else if (this.kind === "map") {
      const e = this.encoded?.entries?.length ?? 0;
      this.label = "Map(" + e + ")";
    } else if (this.kind === "set") {
      const v = this.encoded?.values?.length ?? 0;
      this.label = "Set(" + v + ")";
    } else {
      const keys = this.encoded && typeof this.encoded === "object"
        ? Object.keys(this.encoded).filter((k) => k !== TAG)
        : [];
      this.label = keys.length === 0
        ? "{}"
        : "{" + keys.slice(0, 2).join(",") + (keys.length > 2 ? "…" : "") + "}";
    }
  }
  flash() { this.highlight = 1; }
}

function kindOf(encoded) {
  if (Array.isArray(encoded)) return "array";
  if (encoded && typeof encoded === "object" && encoded[TAG] === "map") return "map";
  if (encoded && typeof encoded === "object" && encoded[TAG] === "set") return "set";
  return "object";
}

function walkRefs(value, cb) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkRefs(item, cb);
    return;
  }
  if (value[TAG] === "ref") {
    cb(value.id);
    return;
  }
  if (value[TAG] === "newobj") {
    cb(value.id);
    walkRefs(value.contents, cb);
    return;
  }
  if (value[TAG] === "map") {
    for (const [k, v] of value.entries) {
      walkRefs(k, cb);
      walkRefs(v, cb);
    }
    return;
  }
  if (value[TAG] === "set") {
    for (const v of value.values) walkRefs(v, cb);
    return;
  }
  if (value[TAG]) return;
  for (const k of Object.keys(value)) walkRefs(value[k], cb);
}

function colorForKind(kind) {
  switch (kind) {
    case "array": return "#3fb950";
    case "map":   return "#d29922";
    case "set":   return "#bc8cff";
    default:      return "#58a6ff";
  }
}
function hexAlpha(a) {
  const v = Math.max(0, Math.min(255, Math.round(a * 255)));
  return v.toString(16).padStart(2, "0");
}
function shortId(id) {
  return id ? id.slice(0, 6) : "";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* ── Pretty-printer that turns a ref tag into a clickable link ─── */

function prettyEncoded(value, indent = 0) {
  const pad = "  ".repeat(indent);
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = value.map((v) => pad + "  " + prettyEncoded(v, indent + 1)).join(",\n");
    return "[\n" + inner + "\n" + pad + "]";
  }
  if (value[TAG] === "ref") {
    const id = value.id;
    return '<a class="ref-link" data-ref-id="' + escapeHtml(id) + '">→ ref ' + escapeHtml(shortId(id)) + "</a>";
  }
  if (value[TAG] === "newobj") {
    const id = value.id;
    return '<a class="ref-link" data-ref-id="' + escapeHtml(id) + '">→ newobj ' + escapeHtml(shortId(id)) + "</a> " + prettyEncoded(value.contents, indent);
  }
  if (value[TAG]) {
    // Other tagged forms (date, regex, bigint, undef, nan, inf, ninf, map, set)
    return '<span class="tag">' + escapeHtml(JSON.stringify(value)) + "</span>";
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  const inner = keys
    .map((k) => pad + "  " + '<span class="key">' + escapeHtml(JSON.stringify(k)) + "</span>: " + prettyEncoded(value[k], indent + 1))
    .join(",\n");
  return "{\n" + inner + "\n" + pad + "}";
}

/* ── Public API ──────────────────────────────────────────────── */

export function createInspector(container) {
  container.innerHTML = `
    <div class="ins-header">
      <span class="title">state graph</span>
      <span class="stat">nodes <span class="v" data-stat="nodes">0</span></span>
      <span class="stat">edges <span class="v" data-stat="edges">0</span></span>
      <span class="stat">ops <span class="v" data-stat="ops">0</span></span>
    </div>
    <div class="ins-canvas-wrap">
      <canvas></canvas>
      <div class="ins-legend">
        <div class="row"><span class="dot obj"></span>object</div>
        <div class="row"><span class="dot arr"></span>array</div>
        <div class="row"><span class="dot map"></span>map</div>
        <div class="row"><span class="dot set"></span>set</div>
      </div>
    </div>
    <div class="ins-bottom">
      <div class="ins-tabs">
        <button data-tab="state" class="active">state</button>
        <button data-tab="ops">ops</button>
        <button data-tab="details">details</button>
      </div>
      <div class="ins-tab-content">
        <pre class="ins-state" data-pane="state"></pre>
        <div class="ins-op-log" data-pane="ops"></div>
        <div class="ins-details" data-pane="details">
          <div class="ins-empty">click a node to inspect its encoded form</div>
        </div>
      </div>
    </div>
  `;

  const canvas = container.querySelector("canvas");
  const opLog = container.querySelector(".ins-op-log");
  const details = container.querySelector(".ins-details");
  const statePane = container.querySelector(".ins-state");
  const stats = {
    nodes: container.querySelector('[data-stat="nodes"]'),
    edges: container.querySelector('[data-stat="edges"]'),
    ops: container.querySelector('[data-stat="ops"]'),
  };
  const tabButtons = container.querySelectorAll(".ins-tabs button");
  const panes = {
    state: statePane,
    ops: opLog,
    details: container.querySelector('[data-pane="details"]'),
  };

  const ctx = canvas.getContext("2d");
  const nodes = new Map();
  let rootIds = [];
  let edgeCount = 0;
  let totalOps = 0;
  let dpr = window.devicePixelRatio || 1;
  let selectedId = null;
  let activeTab = "state";

  function showTab(tab) {
    activeTab = tab;
    for (const b of tabButtons) b.classList.toggle("active", b.dataset.tab === tab);
    for (const [k, el] of Object.entries(panes)) {
      el.style.display = k === tab ? "block" : "none";
    }
    if (tab === "state") renderState();
  }
  for (const b of tabButtons) {
    b.addEventListener("click", () => showTab(b.dataset.tab));
  }
  showTab("state");

  function selectNode(id) {
    selectedId = id;
    showTab("details");
    renderDetails();
  }

  function renderDetails() {
    if (!selectedId) {
      details.innerHTML = '<div class="ins-empty">click a node to inspect its encoded form</div>';
      return;
    }
    const node = nodes.get(selectedId);
    if (!node) {
      details.innerHTML = '<div class="ins-empty">selected node no longer exists</div>';
      return;
    }
    const refsOut = Array.from(node.refs).filter((id) => nodes.has(id));
    details.innerHTML = `
      <div class="ins-detail-header">
        <span class="kind kind-${node.kind}">${node.kind}</span>
        <span class="id" title="${escapeHtml(node.id)}">${escapeHtml(node.id)}</span>
        <button class="deselect" type="button">×</button>
      </div>
      <pre class="ins-detail-body">${prettyEncoded(node.encoded)}</pre>
      <div class="ins-detail-meta">
        refs out: ${refsOut.length} · referenced from: ${countRefsIn(node.id)}
      </div>
    `;
    const deselectBtn = details.querySelector(".deselect");
    if (deselectBtn) deselectBtn.addEventListener("click", () => {
      selectedId = null;
      renderDetails();
    });
    // Wire up ref-link clicks to navigate selection
    details.querySelectorAll(".ref-link").forEach((el) => {
      el.addEventListener("click", () => {
        const refId = el.dataset.refId;
        if (nodes.has(refId)) selectNode(refId);
      });
    });
  }

  function countRefsIn(targetId) {
    let n = 0;
    for (const node of nodes.values()) {
      if (node.refs.has(targetId)) n++;
    }
    return n;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  function adoptNewobjs(encoded) {
    if (encoded === null || typeof encoded !== "object") return;
    if (Array.isArray(encoded)) {
      for (const item of encoded) adoptNewobjs(item);
      return;
    }
    if (encoded[TAG] === "newobj") {
      if (!nodes.has(encoded.id)) {
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        const node = new Node(encoded.id, encoded.kind, encoded.contents);
        node.x = cw / 2 + (Math.random() - 0.5) * 60;
        node.y = ch / 2 + (Math.random() - 0.5) * 60;
        nodes.set(encoded.id, node);
      } else {
        nodes.get(encoded.id).flash();
      }
      adoptNewobjs(encoded.contents);
      return;
    }
    if (encoded[TAG] === "map") {
      for (const [k, v] of encoded.entries) {
        adoptNewobjs(k);
        adoptNewobjs(v);
      }
      return;
    }
    if (encoded[TAG] === "set") {
      for (const v of encoded.values) adoptNewobjs(v);
      return;
    }
    if (encoded[TAG]) return;
    for (const k of Object.keys(encoded)) adoptNewobjs(encoded[k]);
  }

  function loadSnapshot(snap) {
    nodes.clear();
    rootIds = snap.rootIds ? [...snap.rootIds] : [];
    if (!snap.objects) return;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    for (const { id, encoded } of snap.objects) {
      const node = new Node(id, kindOf(encoded), encoded);
      node.x = cw / 2 + (Math.random() - 0.5) * 200;
      node.y = ch / 2 + (Math.random() - 0.5) * 200;
      node.alpha = 1;
      nodes.set(id, node);
    }
    recountEdges();
  }

  /* Walk the encoded graph from each root id, inlining refs and
     handling cycles. Returns a single text representation of the
     entire reconstructed state — what JSON.stringify(receiver.state)
     would look like, but produced from the inspector's local copy of
     the encoded graph so it works without a parallel receiver. */
  function prettyState() {
    if (rootIds.length === 0) return "(no state)";
    const out = [];
    for (let i = 0; i < rootIds.length; i++) {
      const rid = rootIds[i];
      out.push("// root " + i + " — " + rid.slice(0, 8));
      out.push(prettyNodeContents(rid, 0, new Set()));
      if (i < rootIds.length - 1) out.push("");
    }
    return out.join("\n");
  }

  function prettyNodeContents(id, indent, visiting) {
    const node = nodes.get(id);
    if (!node) return "<missing " + id.slice(0, 6) + ">";
    if (visiting.has(id)) return "<circular → " + id.slice(0, 6) + ">";
    visiting.add(id);
    const result = renderEncodedAsText(node.encoded, indent, visiting, node.kind);
    visiting.delete(id);
    return result;
  }

  function renderEncodedAsText(value, indent, visiting, hint) {
    const pad = "  ".repeat(indent);
    if (value === null) return "null";
    if (typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const items = value.map(
        (v) => pad + "  " + renderEncodedAsText(v, indent + 1, visiting),
      );
      return "[\n" + items.join(",\n") + "\n" + pad + "]";
    }
    if (value[TAG] === "ref") {
      return prettyNodeContents(value.id, indent, visiting);
    }
    if (value[TAG] === "newobj") {
      return prettyNodeContents(value.id, indent, visiting);
    }
    if (value[TAG] === "date") return "Date(" + new Date(value.v).toISOString() + ")";
    if (value[TAG] === "regex") return "/" + value.src + "/" + value.flags;
    if (value[TAG] === "bigint") return value.v + "n";
    if (value[TAG] === "undef") return "undefined";
    if (value[TAG] === "nan") return "NaN";
    if (value[TAG] === "inf") return "Infinity";
    if (value[TAG] === "ninf") return "-Infinity";
    if (value[TAG] === "map") {
      if (!value.entries.length) return "Map(0)";
      const items = value.entries.map(([k, v]) =>
        pad + "  " + renderEncodedAsText(k, indent + 1, visiting) +
        " => " + renderEncodedAsText(v, indent + 1, visiting),
      );
      return "Map(" + value.entries.length + ") {\n" + items.join(",\n") + "\n" + pad + "}";
    }
    if (value[TAG] === "set") {
      if (!value.values.length) return "Set(0)";
      const items = value.values.map(
        (v) => pad + "  " + renderEncodedAsText(v, indent + 1, visiting),
      );
      return "Set(" + value.values.length + ") {\n" + items.join(",\n") + "\n" + pad + "}";
    }
    const keys = Object.keys(value).filter((k) => k !== TAG);
    if (keys.length === 0) return "{}";
    const items = keys.map((k) =>
      pad + "  " + JSON.stringify(k) + ": " +
      renderEncodedAsText(value[k], indent + 1, visiting),
    );
    return "{\n" + items.join(",\n") + "\n" + pad + "}";
  }

  function renderState() {
    if (!statePane || activeTab !== "state") return;
    statePane.textContent = prettyState();
  }
  function recountEdges() {
    edgeCount = 0;
    for (const node of nodes.values()) {
      for (const refId of node.refs) {
        if (nodes.has(refId)) edgeCount++;
      }
    }
  }

  let stateRenderScheduled = false;
  function scheduleStateRender() {
    if (stateRenderScheduled) return;
    stateRenderScheduled = true;
    queueMicrotask(() => {
      stateRenderScheduled = false;
      renderState();
    });
  }

  function applyOp(op) {
    if (op.type === "snapshot") {
      loadSnapshot(op);
      logOp({ type: "snapshot" });
      scheduleStateRender();
      return;
    }
    const target = op.target;
    if (!target) return;
    let touchedSelected = false;
    if (target.kind === "ref") {
      const node = nodes.get(target.id);
      if (op.value !== undefined) adoptNewobjs(op.value);
      if (op.key !== undefined) adoptNewobjs(op.key);
      if (node) {
        if (op.type === "set" && target.prop) {
          if (Array.isArray(node.encoded) || (node.encoded && typeof node.encoded === "object")) {
            node.encoded[target.prop] = op.value;
          }
        } else if (op.type === "delete" && target.prop) {
          if (node.encoded && typeof node.encoded === "object") {
            delete node.encoded[target.prop];
          }
        } else if (op.type === "mapSet") {
          const e = node.encoded?.entries;
          if (Array.isArray(e)) e.push([op.key, op.value]);
        } else if (op.type === "setAdd") {
          const v = node.encoded?.values;
          if (Array.isArray(v)) v.push(op.value);
        }
        node.updateRefs();
        node.updateLabel();
        node.flash();
        if (node.id === selectedId) touchedSelected = true;
      }
      if (op.value !== undefined) {
        walkRefs(op.value, (id) => {
          const n = nodes.get(id);
          if (n) n.flash();
          if (id === selectedId) touchedSelected = true;
        });
      }
      recountEdges();
    }
    logOp(op);
    if (touchedSelected) renderDetails();
    scheduleStateRender();
  }

  function logOp(op) {
    totalOps++;
    if (!opLog) return;
    const row = document.createElement("div");
    row.className = "op-row op-" + op.type;
    let detail = "";
    if (op.type === "snapshot") {
      detail = '<span class="op-id">' + nodes.size + " nodes</span>";
    } else if (op.target?.kind === "ref") {
      const idShort = shortId(op.target.id);
      const prop = op.target.prop ? '<span class="op-prop">.' + op.target.prop + "</span>" : "";
      detail = '<span class="op-id">' + idShort + "</span>" + prop;
    }
    row.innerHTML = '<span class="op-type">' + op.type + "</span>" + detail;
    opLog.appendChild(row);
    while (opLog.children.length > 200) opLog.removeChild(opLog.firstChild);
    opLog.scrollTop = opLog.scrollHeight;
  }

  function onMessage(msg) {
    if (msg.type === "snapshot") {
      applyOp(msg.op);
    } else if (msg.type === "ops") {
      for (const op of msg.ops) applyOp(op);
    }
  }

  function step() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const cx = w / 2;
    const cy = h / 2;
    const nodeR = computeNodeR(canvas, nodes.size);
    const springLen = computeSpringLen(nodeR);
    const list = Array.from(nodes.values());
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1) continue;
        const d = Math.sqrt(d2);
        const f = REPULSION / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    for (const a of list) {
      for (const refId of a.refs) {
        const b = nodes.get(refId);
        if (!b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const force = (d - springLen) * SPRING_K;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    for (const node of list) {
      node.vx += (cx - node.x) * CENTER_PULL;
      node.vy += (cy - node.y) * CENTER_PULL;
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      // Snap micro-velocities to zero so the layout actually settles
      // instead of perpetually drifting by fractions of a pixel.
      if (Math.abs(node.vx) < VELOCITY_FLOOR) node.vx = 0;
      if (Math.abs(node.vy) < VELOCITY_FLOOR) node.vy = 0;
      if (!node.dragged) {
        node.x += node.vx;
        node.y += node.vy;
      }
      if (node.x < nodeR) { node.x = nodeR; node.vx = 0; }
      if (node.x > w - nodeR) { node.x = w - nodeR; node.vx = 0; }
      if (node.y < nodeR) { node.y = nodeR; node.vy = 0; }
      if (node.y > h - nodeR) { node.y = h - nodeR; node.vy = 0; }
      node.highlight *= 0.9;
      if (node.highlight < 0.01) node.highlight = 0;
      node.alpha = Math.min(1, node.alpha + 0.05);
    }
    if (stats.nodes) stats.nodes.textContent = nodes.size;
    if (stats.edges) stats.edges.textContent = edgeCount;
    if (stats.ops) stats.ops.textContent = totalOps;
  }

  function draw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const nodeR = computeNodeR(canvas, nodes.size);
    const labelFont = Math.max(9, Math.round(nodeR * 0.45));
    const idFont = Math.max(8, Math.round(nodeR * 0.36));
    ctx.fillStyle = "#06080d";
    ctx.fillRect(0, 0, w, h);

    for (const a of nodes.values()) {
      for (const refId of a.refs) {
        const b = nodes.get(refId);
        if (!b) continue;
        const alpha = Math.min(a.alpha, b.alpha) * 0.55;
        ctx.strokeStyle = "rgba(139, 148, 158, " + alpha + ")";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const ax = b.x - Math.cos(angle) * (nodeR + 2);
        const ay = b.y - Math.sin(angle) * (nodeR + 2);
        const head = Math.max(6, nodeR * 0.3);
        ctx.fillStyle = "rgba(139, 148, 158, " + (alpha + 0.2) + ")";
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(angle - 0.4) * head, ay - Math.sin(angle - 0.4) * head);
        ctx.lineTo(ax - Math.cos(angle + 0.4) * head, ay - Math.sin(angle + 0.4) * head);
        ctx.closePath();
        ctx.fill();
      }
    }

    for (const node of nodes.values()) {
      const color = colorForKind(node.kind);
      const alpha = node.alpha;
      // Constant radius — flashes are pure glow + ring, no scale pulse,
      // so the layout doesn't shimmer.
      const r = nodeR;
      if (node.highlight > 0.05) {
        ctx.fillStyle = color + hexAlpha(node.highlight * 0.4);
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 12, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = color + hexAlpha(alpha);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (node.id === selectedId) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      } else if (node.highlight > 0.05) {
        ctx.strokeStyle = "rgba(255,255,255," + node.highlight + ")";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,255,255," + alpha + ")";
      ctx.font = "bold " + labelFont + "px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(node.label, node.x, node.y);
      ctx.fillStyle = "rgba(139,148,158," + (alpha * 0.85) + ")";
      ctx.font = idFont + "px ui-monospace, monospace";
      ctx.fillText(node.id.slice(0, 8), node.x, node.y + r + idFont + 2);
    }
  }

  let raf = 0;
  function loop() {
    step();
    draw();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  // Drag + click. Track movement during pointerdown→pointerup; if the
  // pointer barely moved, treat it as a click and select the node.
  let dragNode = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let pointerDownX = 0;
  let pointerDownY = 0;
  let pointerDownNode = null;

  canvas.addEventListener("pointerdown", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const hitR = computeNodeR(canvas, nodes.size) + 4;
    pointerDownX = x;
    pointerDownY = y;
    pointerDownNode = null;
    for (const node of nodes.values()) {
      if (Math.hypot(x - node.x, y - node.y) < hitR) {
        pointerDownNode = node;
        dragNode = node;
        node.dragged = true;
        dragOffsetX = node.x - x;
        dragOffsetY = node.y - y;
        canvas.setPointerCapture(ev.pointerId);
        return;
      }
    }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragNode) return;
    const r = canvas.getBoundingClientRect();
    dragNode.x = (ev.clientX - r.left) + dragOffsetX;
    dragNode.y = (ev.clientY - r.top) + dragOffsetY;
    dragNode.vx = 0;
    dragNode.vy = 0;
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (dragNode) { dragNode.dragged = false; dragNode = null; }
    // Click detection: pointer barely moved AND we landed on a node
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    const moved = Math.hypot(x - pointerDownX, y - pointerDownY);
    if (moved < 5 && pointerDownNode) {
      selectNode(pointerDownNode.id);
    }
    pointerDownNode = null;
  });

  return {
    onMessage,
    selectNode,
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
  };
}
