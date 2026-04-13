/**
 * Build per-subsystem demo HTML files — v0.3 event loop replication.
 *
 * Each demo is a single HTML file with two iframes (source + follower)
 * and a shared op inspector panel. Source runs createRecorder, follower
 * runs createPlayer. Ops flow through the parent page's inspector.
 *
 *   node scripts/build-demos.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";

import { buildBundle, ROOT } from "./_bundle.mjs";
import { inspectorCSS, inspectorHTML, inspectorJS } from "./_inspector.mjs";

/** Escape </script> inside embedded strings so HTML parser doesn't terminate the script block */
function safe(s) { return s.replace(/<\//g, "<\\/"); }
/** Escape for JSON-stringified content embedded in <script> — replace </script in the JSON output */
function safeJson(s) { return JSON.stringify(s).replace(/<\//g, "\\u003c/"); }

/**
 * Build the srcdoc content for the SOURCE iframe.
 * The recorder captures ops and posts them to the parent.
 */
function sourceFrame({ bundle, appCode, recorderFlags }) {
  const flags = Object.entries(recorderFlags)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  return `<!doctype html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#06080d;color:#e6edf3;font-family:system-ui,sans-serif;overflow:hidden}</style>
</head><body>
<script>${safe(bundle)}<\/script>
<script>
(function(){
var remjs=window.remjs;
var _buf=[],_batchPending=false;
var recorder=remjs.createRecorder({
  onOps:function(ops){
    _buf.push.apply(_buf,ops);
    if(!_batchPending){
      _batchPending=true;
      setTimeout(function(){
        _batchPending=false;
        var batch=_buf;_buf=[];
        window.parent.postMessage({type:"ops",ops:batch},"*");
      },0);
    }
  },
  batchMode:"sync",
  ${flags}
});
recorder.start();
})();
<\/script>
<script>
(function(){
${appCode}
})();
<\/script>
</body></html>`;
}

/**
 * Build the srcdoc content for the FOLLOWER iframe.
 * The player receives ops from the parent and replays them.
 */
function followerFrame({ bundle, appCode }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#06080d;color:#e6edf3;font-family:system-ui,sans-serif;overflow:hidden}</style>
</head><body>
<script>${safe(bundle)}<\/script>
<script>
(function(){
var remjs=window.remjs;
var player=remjs.createPlayer({mode:"instant"});
// Bootstrap patches before app code runs
player.apply([]);
window.addEventListener("message",function(ev){
  if(ev.data&&ev.data.type==="ops"&&Array.isArray(ev.data.ops)){
    player.apply(ev.data.ops);
    window.dispatchEvent(new Event("remjs:applied"));
  }
});
// Signal readiness to parent
window.parent.postMessage({type:"follower-ready"},"*");
})();
<\/script>
<script>
(function(){
${appCode}
})();
<\/script>
</body></html>`;
}

/**
 * Build the full parent page HTML.
 */
function parentPage({ title, hint, sourceSrcdoc, followerSrcdoc, extraInspectorUI, extraParentJS }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>remjs — ${title}</title>
<style>
:root{color-scheme:dark;--f:system-ui,-apple-system,sans-serif;--m:ui-monospace,'SF Mono',monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--f);background:#0d1117;color:#e6edf3}
h1{text-align:center;padding:.5em 0 .1em;font-size:1.15em;font-weight:600}
.hint{text-align:center;color:#8b949e;font-size:.75em;padding-bottom:.4em;max-width:720px;margin:0 auto;line-height:1.4}
.hint code{background:#161b22;padding:.1em .3em;border-radius:3px;font-size:.85em}
.layout{display:grid;grid-template-columns:1fr 260px 1fr;gap:4px;padding:0 4px;height:calc(100vh - 80px);min-height:320px}
.panel{position:relative;border-radius:6px;overflow:hidden;border:1px solid #30363d}
.plbl{position:absolute;top:4px;left:8px;z-index:1;font-size:.58em;text-transform:uppercase;letter-spacing:.06em;font-weight:700;pointer-events:none}
.source .plbl{color:#58a6ff}.follower .plbl{color:#bc8cff}
iframe{display:block;width:100%;height:100%;border:none;background:#06080d}
${inspectorCSS()}
@media(max-width:900px){.layout{grid-template-columns:1fr 1fr;grid-template-rows:1fr 200px}.opp{grid-column:1/-1}}
@media(max-width:500px){.layout{grid-template-columns:1fr;grid-template-rows:1fr 160px 1fr;height:auto;min-height:0}}
</style></head><body>
<h1>remjs — ${title}</h1>
<p class="hint">${hint}</p>
<div class="layout">
<div class="panel source"><span class="plbl">source</span><iframe id="src" sandbox="allow-scripts allow-same-origin"></iframe></div>
${inspectorHTML(extraInspectorUI)}
<div class="panel follower"><span class="plbl">follower</span><iframe id="fol" sandbox="allow-scripts allow-same-origin"></iframe></div>
</div>
<script>
(function(){
var sourceFrame=document.getElementById("src");
var followerFrame=document.getElementById("fol");

var srcDoc=${safeJson(sourceSrcdoc)};
var folDoc=${safeJson(followerSrcdoc)};

// Load iframes
sourceFrame.srcdoc=srcDoc;
followerFrame.srcdoc=folDoc;

// Follower readiness gate — buffer ops until follower signals ready
var followerReady=false;

window.addEventListener("message",function(ev){
  // Follower ready signal
  if(ev.source===followerFrame.contentWindow&&ev.data&&ev.data.type==="follower-ready"){
    followerReady=true;
    return;
  }
  // Ops from source
  if(ev.source===sourceFrame.contentWindow&&ev.data&&ev.data.type==="ops"&&Array.isArray(ev.data.ops)){
    for(var i=0;i<ev.data.ops.length;i++)addOp(ev.data.ops[i]);
  }
});

// Reset handler
function onReset(){
  sourceFrame.srcdoc=srcDoc;
  followerFrame.srcdoc=folDoc;
}

${inspectorJS()}
${extraParentJS || ""}
})();
<\/script></body></html>`;
}

// ── Demo definitions ──────────────────────────────────────────────

const DEMOS = [
  {
    name: "heatmap",
    title: "click heatmap (events)",
    hint: "Click the left panel. Each click emits an <code>EventOp</code> with coordinates. The follower receives it, dispatches the event, and paints a dot at the same position.",
    recorderFlags: { events: true, timers: false, network: false, random: false, clock: false, storage: false },
    formatOp: `function formatOp(o){
      if(o.type==="event")return o.eventType+" ("+Math.round(o.detail.clientX||0)+","+Math.round(o.detail.clientY||0)+")";
      return JSON.stringify(o).slice(0,40);
    }`,
    appCode: `
var W=600,H=400;
var c=document.createElement("canvas");c.width=W;c.height=H;
c.style.cssText="display:block;width:100%;height:100%;cursor:crosshair";
document.body.appendChild(c);
var cx=c.getContext("2d");

// State: list of dots
var dots=[];

function render(){
  cx.fillStyle="#06080d";cx.fillRect(0,0,W,H);
  cx.font="11px system-ui";cx.fillStyle="#30363d";cx.textAlign="center";cx.fillText("click anywhere",W/2,H/2);
  for(var i=0;i<dots.length;i++){
    var d=dots[i];
    cx.beginPath();cx.arc(d.x,d.y,d.r,0,Math.PI*2);
    cx.fillStyle=d.color;cx.globalAlpha=0.7;cx.fill();cx.globalAlpha=1;
  }
}

// Derive color deterministically from position
function posColor(x,y){
  var h=((x*7+y*13)*37)%360;
  return "hsl("+h+",70%,55%)";
}

document.body.addEventListener("click",function(e){
  var rect=c.getBoundingClientRect();
  var x=(e.clientX-rect.left)/rect.width*W;
  var y=(e.clientY-rect.top)/rect.height*H;
  var r=8+((x*3+y*5)%12);
  dots.push({x:x,y:y,r:r,color:posColor(x,y)});
  render();
});

render();
    `,
  },
  {
    name: "dice",
    title: "dice roller (random)",
    hint: "Click <strong>Roll</strong>. Each die rolls one at a time — each <code>Math.random()</code> emits a <code>RandomOp</code>. The follower dequeues each value, producing identical faces.",
    recorderFlags: { events: true, timers: false, network: false, random: true, clock: false, storage: false },
    formatOp: `var _dieIdx=0;
    function formatOp(o){
      if(o.type==="random"){var face=Math.floor(o.values[0]*6)+1;var d=(_dieIdx%5)+1;_dieIdx++;return "die "+d+" \\u2192 "+face+" ("+o.values[0].toFixed(4)+")";}
      if(o.type==="event"){_dieIdx=0;return o.eventType;}
      if(o.type==="timer")return null;
      return JSON.stringify(o).slice(0,40);
    }`,
    appCode: `
var DICE=5;
var container=document.createElement("div");
container.style.cssText="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;padding:16px";
document.body.appendChild(container);

var diceRow=document.createElement("div");
diceRow.style.cssText="display:flex;gap:12px;flex-wrap:wrap;justify-content:center";
container.appendChild(diceRow);

var btn=document.createElement("button");
btn.textContent="Roll";
btn.id="roll-btn";
btn.style.cssText="font-size:1.2em;padding:8px 24px;cursor:pointer;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px";
container.appendChild(btn);

var historyEl=document.createElement("div");
historyEl.style.cssText="font-family:ui-monospace,monospace;font-size:.75em;color:#8b949e;max-height:120px;overflow-y:auto;width:100%;text-align:center";
container.appendChild(historyEl);

// Pip patterns for dice faces 1-6
var PIPS=[
  [[.5,.5]],
  [[.25,.25],[.75,.75]],
  [[.25,.25],[.5,.5],[.75,.75]],
  [[.25,.25],[.75,.25],[.25,.75],[.75,.75]],
  [[.25,.25],[.75,.25],[.5,.5],[.25,.75],[.75,.75]],
  [[.25,.25],[.75,.25],[.25,.5],[.75,.5],[.25,.75],[.75,.75]]
];

function drawDie(canvas,face,highlight){
  var s=canvas.width,cx=canvas.getContext("2d");
  cx.clearRect(0,0,s,s);
  cx.fillStyle="#161b22";cx.beginPath();
  var r=8;cx.moveTo(r,0);cx.lineTo(s-r,0);cx.quadraticCurveTo(s,0,s,r);
  cx.lineTo(s,s-r);cx.quadraticCurveTo(s,s,s-r,s);cx.lineTo(r,s);cx.quadraticCurveTo(0,s,0,s-r);
  cx.lineTo(0,r);cx.quadraticCurveTo(0,0,r,0);cx.fill();
  cx.strokeStyle=highlight?"#58a6ff":"#30363d";cx.lineWidth=highlight?3:2;cx.stroke();
  if(face<1)return;
  var pips=PIPS[face-1];
  cx.fillStyle="#e6edf3";
  for(var i=0;i<pips.length;i++){
    var px=pips[i][0]*s,py=pips[i][1]*s;
    cx.beginPath();cx.arc(px,py,s*0.08,0,Math.PI*2);cx.fill();
  }
}

var diceCanvases=[];
for(var i=0;i<DICE;i++){
  var cv=document.createElement("canvas");cv.width=64;cv.height=64;
  cv.style.cssText="width:64px;height:64px";
  diceRow.appendChild(cv);diceCanvases.push(cv);
  drawDie(cv,1,false);
}

var rollQueue=[],animating=false;
btn.addEventListener("click",function(){
  var faces=[];
  for(var i=0;i<DICE;i++)faces.push(Math.floor(Math.random()*6)+1);
  rollQueue.push(faces);
  if(!animating)animateNext();
});
function animateNext(){
  if(!rollQueue.length){animating=false;return;}
  animating=true;
  var faces=rollQueue.shift();
  for(var i=0;i<DICE;i++)drawDie(diceCanvases[i],0,false);
  var idx=0;
  function reveal(){
    if(idx>0)drawDie(diceCanvases[idx-1],faces[idx-1],false);
    if(idx>=DICE){
      var row=document.createElement("div");
      row.textContent=faces.join(" ");
      historyEl.prepend(row);
      if(historyEl.children.length>20)historyEl.lastChild.remove();
      animateNext();
      return;
    }
    drawDie(diceCanvases[idx],faces[idx],true);
    idx++;
    setTimeout(reveal,150);
  }
  reveal();
}
    `,
  },
  {
    name: "clock",
    title: "synced clock (clock)",
    hint: "A timer ticks every second, calling <code>Date.now()</code>. The <code>ClockOp</code> carries the exact timestamp. The follower's <code>Date.now()</code> returns the queued value — both displays match exactly.",
    recorderFlags: { events: false, timers: false, network: false, random: false, clock: true, storage: false },
    extraInspectorUI: `<label><input type="checkbox" id="rc" checked /> replicate clock</label>`,
    extraParentJS: `
// Clock toggle: when unchecked, drop ClockOps before forwarding
var $rc=document.getElementById("rc");
var _origAddOp=addOp;
addOp=function(o){
  if(o.type==="clock"&&!$rc.checked)return; // drop clock ops
  _origAddOp(o);
};
    `,
    formatOp: `function formatOp(o){
      if(o.type==="clock")return o.source+" = "+o.value;
      return JSON.stringify(o).slice(0,40);
    }`,
    appCode: `
var container=document.createElement("div");
container.style.cssText="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:12px;font-family:ui-monospace,monospace";
document.body.appendChild(container);

var tsEl=document.createElement("div");
tsEl.style.cssText="font-size:2em;font-weight:700;color:#f0c040";
container.appendChild(tsEl);

var timeEl=document.createElement("div");
timeEl.style.cssText="font-size:1.4em;color:#e6edf3";
container.appendChild(timeEl);

var elapsedEl=document.createElement("div");
elapsedEl.style.cssText="font-size:.9em;color:#8b949e";
container.appendChild(elapsedEl);

var startTs=Date.now();

function tick(){
  var now=Date.now();
  tsEl.textContent=now;
  var d=new Date(now);
  timeEl.textContent=d.toLocaleTimeString();
  elapsedEl.textContent="elapsed: "+((now-startTs)/1000).toFixed(1)+"s";
}

tick();
setInterval(tick,1000);
// Follower: also re-render when clock ops arrive (so we don't lag behind our own timer)
window.addEventListener("remjs:applied",tick);
    `,
  },
  {
    name: "fetch",
    title: "fetch mirror (network)",
    hint: "Click <strong>Fetch Quote</strong>. The source's <code>fetch()</code> response is captured as a <code>NetworkOp</code>. The follower's <code>fetch()</code> is intercepted by the player — same quote appears without hitting the server.",
    recorderFlags: { events: true, timers: false, network: true, random: false, clock: false, storage: false },
    formatOp: `function formatOp(o){
      if(o.type==="network")return o.status+" "+o.url.split("/").pop()+" — "+(o.body||"").slice(0,30);
      if(o.type==="event")return o.eventType;
      return JSON.stringify(o).slice(0,40);
    }`,
    // Source gets a fetch mock installed BEFORE the recorder starts
    sourcePreamble: `
// Mock /api/quote — no server needed
var QUOTES=[
  {text:"The best way to predict the future is to invent it.",author:"Alan Kay"},
  {text:"Talk is cheap. Show me the code.",author:"Linus Torvalds"},
  {text:"Programs must be written for people to read.",author:"Abelson & Sussman"},
  {text:"Simplicity is prerequisite for reliability.",author:"Dijkstra"},
  {text:"First, solve the problem. Then, write the code.",author:"John Johnson"},
  {text:"Any fool can write code that a computer can understand.",author:"Martin Fowler"},
  {text:"Code is like humor. When you have to explain it, it's bad.",author:"Cory House"},
  {text:"Fix the cause, not the symptom.",author:"Steve Maguire"}
];
var _qi=0;
var _origFetch=globalThis.fetch;
globalThis.fetch=function(url,opts){
  if(typeof url==="string"&&url.indexOf("/api/quote")!==-1){
    var q=QUOTES[_qi%QUOTES.length];_qi++;
    return Promise.resolve(new Response(JSON.stringify(q),{status:200,headers:{"content-type":"application/json"}}));
  }
  return _origFetch.apply(this,arguments);
};
    `,
    appCode: `
var container=document.createElement("div");
container.style.cssText="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;padding:24px";
document.body.appendChild(container);

var quoteEl=document.createElement("blockquote");
quoteEl.style.cssText="font-size:1.1em;color:#e6edf3;max-width:400px;text-align:center;line-height:1.5;min-height:60px;font-style:italic";
quoteEl.textContent="Click to fetch a quote...";
container.appendChild(quoteEl);

var authorEl=document.createElement("div");
authorEl.style.cssText="font-size:.85em;color:#8b949e";
container.appendChild(authorEl);

var btn=document.createElement("button");
btn.textContent="Fetch Quote";
btn.id="fetch-btn";
btn.style.cssText="font-size:1.1em;padding:8px 24px;cursor:pointer;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px";
container.appendChild(btn);

var countEl=document.createElement("div");
countEl.style.cssText="font-size:.75em;color:#8b949e;font-family:ui-monospace,monospace";
container.appendChild(countEl);
var fetchCount=0;

btn.addEventListener("click",function(){
  fetch("/api/quote").then(function(r){return r.json()}).then(function(q){
    fetchCount++;
    quoteEl.textContent='"'+q.text+'"';
    authorEl.textContent="— "+q.author;
    countEl.textContent="fetch #"+fetchCount;
  });
});
    `,
  },
  {
    name: "prefs",
    title: "preferences (storage)",
    hint: "Change theme, font size, or accent color. Each change writes to <code>sessionStorage</code> — the <code>StorageOp</code> carries key + value. The follower applies it, producing identical settings without shared storage.",
    recorderFlags: { events: true, timers: false, network: false, random: false, clock: false, storage: true },
    formatOp: `function formatOp(o){
      if(o.type==="storage"){if(o.action==="get")return null;return o.action+" "+o.key+" = "+(o.value||"null");}
      if(o.type==="event")return o.eventType;
      return JSON.stringify(o).slice(0,40);
    }`,
    appCode: `
var container=document.createElement("div");
container.id="app";
container.style.cssText="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;padding:24px;transition:background .3s,color .3s";
document.body.appendChild(container);

var title=document.createElement("h2");
title.textContent="Settings";
title.style.cssText="font-family:system-ui,sans-serif;margin-bottom:8px";
container.appendChild(title);

function makeRow(label,id,html){
  var row=document.createElement("div");
  row.style.cssText="display:flex;align-items:center;gap:12px;font-family:system-ui,sans-serif;font-size:.9em;width:200px;justify-content:space-between";
  row.innerHTML='<span>'+label+'</span><span id="'+id+'">'+html+'</span>';
  container.appendChild(row);
  return row;
}

makeRow("Theme","theme-ctl",'<button id="theme-btn" style="padding:4px 12px;cursor:pointer;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:4px">dark</button>');
makeRow("Font size","size-ctl",'<select id="size-sel" style="padding:4px;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:4px"><option value="small">small</option><option value="medium" selected>medium</option><option value="large">large</option></select>');
makeRow("Accent","accent-ctl",'<input type="color" id="accent-inp" value="#58a6ff" style="width:32px;height:24px;border:none;cursor:pointer;background:transparent" />');

var preview=document.createElement("div");
preview.id="preview";
preview.style.cssText="margin-top:16px;padding:16px;border-radius:8px;border:2px solid #58a6ff;font-family:system-ui,sans-serif;text-align:center;width:200px";
preview.textContent="Preview text";
container.appendChild(preview);

var SIZES={small:"12px",medium:"16px",large:"20px"};

function applyPrefs(){
  var theme=sessionStorage.getItem("theme")||"dark";
  var size=sessionStorage.getItem("fontSize")||"medium";
  var accent=sessionStorage.getItem("accent")||"#58a6ff";

  container.style.background=theme==="dark"?"#06080d":"#f0f0f0";
  container.style.color=theme==="dark"?"#e6edf3":"#222";
  document.body.style.background=container.style.background;
  preview.style.fontSize=SIZES[size]||"16px";
  preview.style.borderColor=accent;
  preview.textContent="Preview ("+theme+", "+size+")";

  // Sync controls to match state
  var btn=document.getElementById("theme-btn");if(btn)btn.textContent=theme;
  var sel=document.getElementById("size-sel");if(sel)sel.value=size;
  var inp=document.getElementById("accent-inp");if(inp)inp.value=accent;
}

document.body.addEventListener("click",function(e){
  if(e.target.id==="theme-btn"){
    var cur=sessionStorage.getItem("theme")||"dark";
    sessionStorage.setItem("theme",cur==="dark"?"light":"dark");
    applyPrefs();
  }
});

document.body.addEventListener("change",function(e){
  if(e.target.id==="size-sel"){
    sessionStorage.setItem("fontSize",e.target.value);
    applyPrefs();
  }
  if(e.target.id==="accent-inp"){
    sessionStorage.setItem("accent",e.target.value);
    applyPrefs();
  }
});

// Re-render when ops arrive from the player
window.addEventListener("remjs:applied",applyPrefs);

applyPrefs();
    `,
  },
];

// ── Build ──────────────────────────────────────────────────────────

async function main() {
  const bundle = await buildBundle();

  for (const demo of DEMOS) {
    // Build source iframe content
    let srcContent;
    if (demo.sourcePreamble) {
      // For fetch demo: inject mock before recorder
      const flags = Object.entries(demo.recorderFlags)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");

      srcContent = `<!doctype html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#06080d;color:#e6edf3;font-family:system-ui,sans-serif;overflow:hidden}</style>
</head><body>
<script>${safe(bundle)}<\/script>
<script>
(function(){
${demo.sourcePreamble}
var remjs=window.remjs;
var _buf=[],_batchPending=false;
var recorder=remjs.createRecorder({
  onOps:function(ops){
    _buf.push.apply(_buf,ops);
    if(!_batchPending){
      _batchPending=true;
      setTimeout(function(){
        _batchPending=false;
        var batch=_buf;_buf=[];
        window.parent.postMessage({type:"ops",ops:batch},"*");
      },0);
    }
  },
  batchMode:"sync",
  ${flags}
});
recorder.start();
})();
<\/script>
<script>
(function(){
${demo.appCode}
})();
<\/script>
</body></html>`;
    } else {
      srcContent = sourceFrame({
        bundle,
        appCode: demo.appCode,
        recorderFlags: demo.recorderFlags,
      });
    }

    const folContent = followerFrame({
      bundle,
      appCode: demo.appCode,
    });

    // Build the parent page with the formatOp function
    const page = parentPage({
      title: demo.title,
      hint: demo.hint,
      sourceSrcdoc: srcContent,
      followerSrcdoc: folContent,
      extraInspectorUI: demo.extraInspectorUI || "",
      extraParentJS: `${demo.formatOp}\n${demo.extraParentJS || ""}`,
    });

    const outDir = path.join(ROOT, "examples", demo.name);
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, "index.html");
    await fs.writeFile(outPath, page, "utf8");
    console.log(`wrote examples/${demo.name}/index.html — ${(Buffer.byteLength(page) / 1024).toFixed(1)} KB`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
