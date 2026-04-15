/**
 * Build the standalone mirror demo HTML — v0.4 event loop replication.
 *
 * Single HTML file with two canvases + op inspector panel.
 * Both canvases run identical physics code. Source captures pointer
 * events + Math.random() via createRecorder. Follower replays via
 * createPlayer. Same inputs → same physics → identical output.
 *
 *   node scripts/build-mirror.mjs
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
  parts.push(`window.remjs = { createRecorder, createPlayer, jsonCodec };`);
  return `(function(){"use strict";\n${parts.join("\n")}\n})();`;
}

// ── Shared game code (runs on BOTH source and follower) ──

const GAME_CODE = `
var W=560,H=420,LX=W/2,LY=H-34,TX=W/2,TY=70;
var ZN=[{r:22,p:5,c:"#f0c040"},{r:46,p:3,c:"#6fa8dc"},{r:74,p:1,c:"#3e5978"}];
var PR=14,FR=.985,RS=.2,BN=.9;

var pk=[],nid=1,sc=0;
function launch(ax,ay,hue){
  var dx=ax-LX,dy=ay-LY,ln=Math.hypot(dx,dy),pw=Math.min(14,ln/14);
  if(pw<.5)return;var nx=dx/(ln||1),ny=dy/(ln||1),id=nid++;
  pk.push({id:id,x:LX,y:LY,vx:nx*pw,vy:ny*pw,cl:"hsl("+hue+",80%,60%)",st:false,pt:0});
}
function step(){
  var i,j,p,a,b,dx,dy,ds,md,d,nx,ny,ov,rv,im;
  for(i=0;i<pk.length;i++){p=pk[i];if(p.st)continue;
    p.x+=p.vx;p.y+=p.vy;p.vx*=FR;p.vy*=FR;
    if(p.x<PR){p.x=PR;p.vx*=-.85}else if(p.x>W-PR){p.x=W-PR;p.vx*=-.85}
    if(p.y<PR){p.y=PR;p.vy*=-.85}else if(p.y>H-PR){p.y=H-PR;p.vy*=-.85}}
  for(i=0;i<pk.length;i++){a=pk[i];for(j=i+1;j<pk.length;j++){b=pk[j];
    dx=b.x-a.x;dy=b.y-a.y;ds=dx*dx+dy*dy;md=PR*2;
    if(ds>=md*md||ds===0)continue;d=Math.sqrt(ds);
    nx=dx/d;ny=dy/d;ov=(md-d)/2;
    a.x-=nx*ov;a.y-=ny*ov;b.x+=nx*ov;b.y+=ny*ov;
    rv=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;if(rv>0)continue;
    im=-(1+BN)*rv/2;a.vx-=im*nx;a.vy-=im*ny;b.vx+=im*nx;b.vy+=im*ny;
    if(a.st){a.st=false;a.pt=0}if(b.st){b.st=false;b.pt=0}}}
  sc=0;for(i=0;i<pk.length;i++){p=pk[i];
    if(!p.st&&Math.hypot(p.vx,p.vy)<RS){p.st=true;p.vx=0;p.vy=0;
      d=Math.hypot(p.x-TX,p.y-TY);for(j=0;j<ZN.length;j++)if(d<=ZN[j].r){p.pt=ZN[j].p;break}}
    if(p.st)sc+=p.pt}
}
function draw(cx,isSource){
  cx.fillStyle="#06080d";cx.fillRect(0,0,W,H);
  var i,z,p;
  for(i=ZN.length-1;i>=0;i--){z=ZN[i];cx.fillStyle=z.c;cx.globalAlpha=.18;
    cx.beginPath();cx.arc(TX,TY,z.r,0,Math.PI*2);cx.fill();
    cx.globalAlpha=1;cx.strokeStyle=z.c;cx.lineWidth=1;
    cx.beginPath();cx.arc(TX,TY,z.r,0,Math.PI*2);cx.stroke()}
  cx.fillStyle="#8b949e";cx.beginPath();cx.moveTo(LX-12,LY+10);cx.lineTo(LX+12,LY+10);cx.lineTo(LX,LY-10);cx.closePath();cx.fill();
  for(i=0;i<pk.length;i++){p=pk[i];cx.fillStyle=p.cl;cx.globalAlpha=p.st?.9:1;
    cx.beginPath();cx.arc(p.x,p.y,PR,0,Math.PI*2);cx.fill();
    cx.globalAlpha=1;cx.fillStyle="#fff";cx.font="bold 11px sans-serif";cx.textAlign="center";cx.textBaseline="middle";
    cx.fillText(String(p.id),p.x,p.y)}
  cx.fillStyle=isSource?"#58a6ff":"#bc8cff";cx.font="bold 18px sans-serif";cx.textAlign="right";cx.textBaseline="top";
  cx.fillText(String(sc),W-8,6);cx.font="9px sans-serif";cx.fillStyle="#8b949e";cx.fillText("score",W-8,26);
}

// Pointer handling — generates launch on pointerup
var cv=document.getElementById("C"),dg=null;
function xy(e){var r=cv.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*W,y:(e.clientY-r.top)/r.height*H}}
cv.addEventListener("pointerdown",function(e){dg=xy(e);cv.setPointerCapture(e.pointerId)});
cv.addEventListener("pointermove",function(e){if(dg)dg=xy(e)});
cv.addEventListener("pointerup",function(){if(!dg)return;var a=dg;dg=null;
  var hue=Math.floor(Math.random()*360);launch(a.x,a.y,hue);
});
cv.addEventListener("pointercancel",function(){dg=null});

// Animation loop
var cx=cv.getContext("2d");
function loop(){step();draw(cx,window.__remjs_source);requestAnimationFrame(loop)}
requestAnimationFrame(loop);
`;

// ── Escape </script> in embedded strings ──
function safe(s) { return s.replace(/<\//g, "<\\/"); }
function safeJson(s) { return JSON.stringify(s).replace(/<\//g, "\\u003c/"); }

// ── Full page template ──

function buildFullPage(bundle) {
  // Source iframe: recorder captures pointer events + random
  const sourceSrcdoc = `<!doctype html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#06080d;overflow:hidden}</style>
</head><body><canvas id="C" width="560" height="420" style="display:block;width:100%;height:100%;cursor:crosshair;background:#06080d"></canvas>
<script>${safe(bundle)}<\/script>
<script>
(function(){
window.__remjs_source=true;
var remjs=window.remjs;
var _buf=[],_pending=false;
var recorder=remjs.createRecorder({
  onOps:function(ops){
    _buf.push.apply(_buf,ops);
    if(!_pending){_pending=true;setTimeout(function(){
      _pending=false;var b=_buf;_buf=[];
      window.parent.postMessage({type:"ops",ops:b},"*");
    },0);}
  },
  batchMode:"sync",
  events:true, random:true,
  timers:false, network:false, clock:false, storage:false
});
recorder.start();
})();
<\/script>
<script>(function(){${GAME_CODE}})();<\/script>
</body></html>`;

  // Follower iframe: player replays events + random values
  const followerSrcdoc = `<!doctype html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#06080d;overflow:hidden}</style>
</head><body><canvas id="C" width="560" height="420" style="display:block;width:100%;height:100%;background:#06080d"></canvas>
<script>${safe(bundle)}<\/script>
<script>
(function(){
window.__remjs_source=false;
var remjs=window.remjs;
var player=remjs.createPlayer({mode:"instant"});
player.apply([]);
window.addEventListener("message",function(ev){
  if(ev.data&&ev.data.type==="ops"&&Array.isArray(ev.data.ops)){
    player.apply(ev.data.ops);
  }
});
window.parent.postMessage({type:"follower-ready"},"*");
})();
<\/script>
<script>(function(){${GAME_CODE}})();<\/script>
</body></html>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>remjs mirror — shuffleboard</title>
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
.source .plbl{color:#58a6ff}.mirror .plbl{color:#bc8cff}
iframe{display:block;width:100%;height:100%;border:none;background:#06080d}
.opp{display:flex;flex-direction:column;border:1px solid #30363d;border-radius:6px;background:#161b22;overflow:hidden;min-height:0}
.oph{padding:5px 8px;border-bottom:1px solid #30363d;display:flex;align-items:center;justify-content:space-between;font-size:.6em;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;background:#0d1117;border-radius:6px 6px 0 0}
.oph .t{font-weight:700;color:#e6edf3}
.opc{display:flex;gap:3px}
.opc button{background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:3px;padding:1px 7px;font-size:1em;cursor:pointer;font-family:var(--m)}
.opc button:hover{background:#30363d}
.opc button.on{background:#1f6feb;border-color:#58a6ff}
.olog{flex:1;overflow-y:auto;font-family:var(--m);font-size:.58rem;line-height:1.5;padding:0;min-height:0}
.orow{padding:1px 16px 1px 18px;border-bottom:1px solid rgba(48,54,61,.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative}
.orow .ot{display:inline-block;min-width:5em;font-weight:600}
.orow .pc{position:absolute;top:50%;transform:translateY(-50%);font-size:.7em;line-height:1}
.orow .pc.src{color:#58a6ff;left:2px}.orow .pc.fol{color:#bc8cff;right:4px}
.ot.event{color:#58a6ff}.ot.random{color:#bc8cff}
.opf{padding:4px 8px;border-top:1px solid #30363d;font-family:var(--m);font-size:.55rem;color:#8b949e;display:flex;justify-content:space-between;background:#0d1117;border-radius:0 0 6px 6px}
@media(max-width:900px){.layout{grid-template-columns:1fr 1fr;grid-template-rows:1fr 200px}.opp{grid-column:1/-1}}
@media(max-width:500px){.layout{grid-template-columns:1fr;grid-template-rows:1fr 160px 1fr;height:auto;min-height:0}}
</style></head><body>
<h1>remjs mirror — shuffleboard</h1>
<p class="hint">Click left canvas to launch pucks. Each click captures a <code>random</code> op (color) and <code>event</code> ops (pointer). Both canvases run identical physics — the follower replays inputs via <code>createPlayer</code>.</p>
<div class="layout">
<div class="panel source"><span class="plbl">source</span><iframe id="src" sandbox="allow-scripts allow-same-origin"></iframe></div>
<div class="opp">
<div class="oph"><span class="t">op stream</span><div class="opc"><button id="pp" title="pause / play">| |</button><button id="st">step</button><button id="rs">reset</button></div></div>
<div class="olog" id="ol"></div>
<div class="opf"><span><span style="color:#58a6ff">S</span>: <span id="sc">0</span></span><span><span style="color:#bc8cff">F</span>: <span id="ac">0</span></span></div>
</div>
<div class="panel mirror"><span class="plbl">follower</span><iframe id="fol" sandbox="allow-scripts allow-same-origin"></iframe></div>
</div>
<script>
(function(){
var sourceFrame=document.getElementById("src");
var followerFrame=document.getElementById("fol");
var srcDoc=${safeJson(sourceSrcdoc)};
var folDoc=${safeJson(followerSrcdoc)};
sourceFrame.srcdoc=srcDoc;
followerFrame.srcdoc=folDoc;

var followerReady=false;

function formatOp(o){
  if(o.type==="event"){
    if(o.eventType==="pointerup")return "launch";
    if(o.eventType==="pointerdown"||o.eventType==="pointermove")return o.eventType;
    return o.eventType;
  }
  if(o.type==="random")return "hue = "+Math.floor(o.values[0]*360);
  return o.type;
}

window.addEventListener("message",function(ev){
  if(ev.source===followerFrame.contentWindow&&ev.data&&ev.data.type==="follower-ready"){
    followerReady=true;return;
  }
  if(ev.source===sourceFrame.contentWindow&&ev.data&&ev.data.type==="ops"&&Array.isArray(ev.data.ops)){
    for(var i=0;i<ev.data.ops.length;i++)addOp(ev.data.ops[i]);
  }
});

function onReset(){
  sourceFrame.srcdoc=srcDoc;
  followerFrame.srcdoc=folDoc;
  followerReady=false;
}

// ── Inspector state ──
var $ol=document.getElementById("ol"),$sc=document.getElementById("sc"),$ac=document.getElementById("ac");
var $pp=document.getElementById("pp");
var allOps=[],ac=0,paused=false,flushScheduled=false;
var rowEls=[];
var EVENT_TYPES={"event":1,"snapshot":1};

function addOp(o){
  var idx=allOps.length;
  allOps.push(o);
  // Skip pointermove and pointerdown from log (noisy), only show pointerup (launch) and random
  var show=o.type==="random"||(o.type==="event"&&o.eventType==="pointerup");
  if(show){
    var desc=formatOp(o);
    var r=document.createElement("div");r.className="orow";
    r.innerHTML='<span class="ot '+(o.type||"")+'">'+o.type+'</span> '+desc;
    $ol.appendChild(r);$ol.scrollTop=$ol.scrollHeight;
    rowEls[idx]=r;
  } else {
    rowEls[idx]=null;
  }
  updPC();
  if(!paused&&!flushScheduled){
    flushScheduled=true;
    queueMicrotask(flushToFollower);
  }
}

function sendBatch(from,to){
  if(from>=to)return;
  if(!followerReady){
    ac=from;setTimeout(function(){sendBatch(from,to);updPC();},50);return;
  }
  followerFrame.contentWindow.postMessage({type:"ops",ops:allOps.slice(from,to)},"*");
}

function flushToFollower(){
  flushScheduled=false;
  if(paused)return;
  var from=ac;ac=allOps.length;
  sendBatch(from,ac);updPC();
}

function applyOne(){
  if(ac>=allOps.length)return false;
  var from=ac,to=ac;
  while(to<allOps.length&&!EVENT_TYPES[allOps[to].type])to++;
  if(to<allOps.length)to++;
  while(to<allOps.length&&!EVENT_TYPES[allOps[to].type])to++;
  if(to===from)to=from+1;
  ac=to;sendBatch(from,to);updPC();
  return true;
}

function updPC(){
  $sc.textContent=allOps.length;$ac.textContent=ac;
  for(var i=0;i<rowEls.length;i++){var r=rowEls[i];if(!r)continue;r.style.opacity=i<ac?"1":"0.35";}
  var oldSrc=$ol.querySelector(".pc.src");if(oldSrc)oldSrc.remove();
  var oldFol=$ol.querySelector(".pc.fol");if(oldFol)oldFol.remove();
  if(allOps.length>0){var lr=findRow(allOps.length-1);if(lr){var s=document.createElement("span");s.className="pc src";s.textContent="\\u25B6";lr.prepend(s);}}
  if(ac>0){var fr=findRow(ac-1);if(fr){var f=document.createElement("span");f.className="pc fol";f.textContent="\\u25C0";fr.appendChild(f);}}
}
function findRow(idx){for(var i=idx;i>=0;i--){if(rowEls[i])return rowEls[i];}return null;}

var drainTimers=[];
function cancelDrain(){for(var t of drainTimers)clearTimeout(t);drainTimers=[];}

// Temporal drain: replay queued groups at their original cadence using ts fields
function drainTemporal(from,to){
  if(from>=to)return;
  // Find group boundaries (each group = seeds + event)
  var groups=[];
  var i=from;
  while(i<to){
    var gStart=i;
    // Skip non-event ops (seeds)
    while(i<to&&!EVENT_TYPES[allOps[i].type])i++;
    // Include the event
    if(i<to)i++;
    // Include trailing non-event ops
    while(i<to&&!EVENT_TYPES[allOps[i].type])i++;
    if(i===gStart)i=gStart+1; // safety: advance at least one
    groups.push({from:gStart,to:i,ts:allOps[gStart].ts||0});
  }
  if(!groups.length)return;
  var baseTs=groups[0].ts;
  for(var g=0;g<groups.length;g++){
    (function(grp){
      var delay=grp.ts-baseTs;
      var t=setTimeout(function(){
        ac=grp.to;
        sendBatch(grp.from,grp.to);
        updPC();
      },Math.max(0,delay));
      drainTimers.push(t);
    })(groups[g]);
  }
}

$pp.onclick=function(){
  paused=!paused;$pp.textContent=paused?"play":"| |";$pp.classList.toggle("on",paused);
  if(!paused){
    flushScheduled=false;
    cancelDrain();
    if(ac<allOps.length){
      drainTemporal(ac,allOps.length);
    }
  } else {
    cancelDrain();
  }
};
document.getElementById("st").onclick=function(){
  if(!paused){paused=true;$pp.textContent="play";$pp.classList.add("on");cancelDrain();}
  applyOne();
};
document.getElementById("rs").onclick=function(){
  cancelDrain();allOps=[];rowEls=[];ac=0;flushScheduled=false;$ol.innerHTML="";updPC();onReset();
};
})();
<\/script></body></html>`;
}

// ── Embed variant (for landing page) ──

function buildEmbedPage(bundle) {
  // Same architecture as full page but compact layout, no reset button
  const sourceSrcdoc = `<!doctype html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#06080d;overflow:hidden}</style>
</head><body><canvas id="C" width="520" height="400" style="display:block;width:100%;height:100%;cursor:crosshair;background:#06080d"></canvas>
<script>${safe(bundle)}<\/script>
<script>
(function(){
window.__remjs_source=true;
var remjs=window.remjs;
var _buf=[],_pending=false;
var recorder=remjs.createRecorder({
  onOps:function(ops){
    _buf.push.apply(_buf,ops);
    if(!_pending){_pending=true;setTimeout(function(){
      _pending=false;var b=_buf;_buf=[];
      window.parent.postMessage({type:"ops",ops:b},"*");
    },0);}
  },
  batchMode:"sync",
  events:true, random:true,
  timers:false, network:false, clock:false, storage:false
});
recorder.start();
})();
<\/script>
<script>(function(){
var W=520,H=400,LX=W/2,LY=H-32,TX=W/2,TY=60;
var ZN=[{r:20,p:5,c:"#f0c040"},{r:42,p:3,c:"#6fa8dc"},{r:68,p:1,c:"#3e5978"}];
var PR=12,FR=.985,RS=.2,BN=.9;
var pk=[],nid=1,sc=0;
function launch(ax,ay,hue){var dx=ax-LX,dy=ay-LY,ln=Math.hypot(dx,dy),pw=Math.min(13,ln/13);
  if(pw<.5)return;var id=nid++;pk.push({id:id,x:LX,y:LY,vx:dx/(ln||1)*pw,vy:dy/(ln||1)*pw,cl:"hsl("+hue+",80%,60%)",st:false,pt:0})}
function step(){var i,j,p,a,b,dx,dy,ds,md,d,nx,ny,ov,rv,im;
  for(i=0;i<pk.length;i++){p=pk[i];if(p.st)continue;p.x+=p.vx;p.y+=p.vy;p.vx*=FR;p.vy*=FR;
    if(p.x<PR){p.x=PR;p.vx*=-.85}else if(p.x>W-PR){p.x=W-PR;p.vx*=-.85}
    if(p.y<PR){p.y=PR;p.vy*=-.85}else if(p.y>H-PR){p.y=H-PR;p.vy*=-.85}}
  for(i=0;i<pk.length;i++){a=pk[i];for(j=i+1;j<pk.length;j++){b=pk[j];
    dx=b.x-a.x;dy=b.y-a.y;ds=dx*dx+dy*dy;md=PR*2;if(ds>=md*md||ds===0)continue;d=Math.sqrt(ds);
    nx=dx/d;ny=dy/d;ov=(md-d)/2;a.x-=nx*ov;a.y-=ny*ov;b.x+=nx*ov;b.y+=ny*ov;
    rv=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;if(rv>0)continue;im=-(1+BN)*rv/2;
    a.vx-=im*nx;a.vy-=im*ny;b.vx+=im*nx;b.vy+=im*ny;
    if(a.st){a.st=false;a.pt=0}if(b.st){b.st=false;b.pt=0}}}
  sc=0;for(i=0;i<pk.length;i++){p=pk[i];
    if(!p.st&&Math.hypot(p.vx,p.vy)<RS){p.st=true;p.vx=0;p.vy=0;
      d=Math.hypot(p.x-TX,p.y-TY);for(j=0;j<ZN.length;j++)if(d<=ZN[j].r){p.pt=ZN[j].p;break}}
    if(p.st)sc+=p.pt}}
function draw(cx,isSource){cx.fillStyle="#06080d";cx.fillRect(0,0,W,H);var i,z,p;
  for(i=ZN.length-1;i>=0;i--){z=ZN[i];cx.fillStyle=z.c;cx.globalAlpha=.18;cx.beginPath();cx.arc(TX,TY,z.r,0,Math.PI*2);cx.fill();
    cx.globalAlpha=1;cx.strokeStyle=z.c;cx.lineWidth=1;cx.beginPath();cx.arc(TX,TY,z.r,0,Math.PI*2);cx.stroke()}
  cx.fillStyle="#8b949e";cx.beginPath();cx.moveTo(LX-10,LY+8);cx.lineTo(LX+10,LY+8);cx.lineTo(LX,LY-8);cx.closePath();cx.fill();
  for(i=0;i<pk.length;i++){p=pk[i];cx.fillStyle=p.cl;cx.globalAlpha=p.st?.9:1;cx.beginPath();cx.arc(p.x,p.y,PR,0,Math.PI*2);cx.fill();
    cx.globalAlpha=1;cx.fillStyle="#fff";cx.font="bold 10px sans-serif";cx.textAlign="center";cx.textBaseline="middle";cx.fillText(String(p.id),p.x,p.y)}
  cx.fillStyle=isSource?"#58a6ff":"#bc8cff";cx.font="bold 16px sans-serif";cx.textAlign="right";cx.textBaseline="top";cx.fillText(String(sc),W-6,4)}
var cv=document.getElementById("C"),dg=null;
function xy(e){var r=cv.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*W,y:(e.clientY-r.top)/r.height*H}}
cv.addEventListener("pointerdown",function(e){dg=xy(e);cv.setPointerCapture(e.pointerId)});
cv.addEventListener("pointermove",function(e){if(dg)dg=xy(e)});
cv.addEventListener("pointerup",function(){if(!dg)return;var a=dg;dg=null;var hue=Math.floor(Math.random()*360);launch(a.x,a.y,hue)});
cv.addEventListener("pointercancel",function(){dg=null});
var cx=cv.getContext("2d");
function loop(){step();draw(cx,window.__remjs_source);requestAnimationFrame(loop)}
requestAnimationFrame(loop);
})();<\/script>
</body></html>`;

  const followerSrcdoc = `<!doctype html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#06080d;overflow:hidden}</style>
</head><body><canvas id="C" width="520" height="400" style="display:block;width:100%;height:100%;background:#06080d"></canvas>
<script>${safe(bundle)}<\/script>
<script>
(function(){
window.__remjs_source=false;
var remjs=window.remjs;
var player=remjs.createPlayer({mode:"instant"});
player.apply([]);
window.addEventListener("message",function(ev){
  if(ev.data&&ev.data.type==="ops"&&Array.isArray(ev.data.ops)){
    player.apply(ev.data.ops);
  }
});
window.parent.postMessage({type:"follower-ready"},"*");
})();
<\/script>
<script>(function(){
var W=520,H=400,LX=W/2,LY=H-32,TX=W/2,TY=60;
var ZN=[{r:20,p:5,c:"#f0c040"},{r:42,p:3,c:"#6fa8dc"},{r:68,p:1,c:"#3e5978"}];
var PR=12,FR=.985,RS=.2,BN=.9;
var pk=[],nid=1,sc=0;
function launch(ax,ay,hue){var dx=ax-LX,dy=ay-LY,ln=Math.hypot(dx,dy),pw=Math.min(13,ln/13);
  if(pw<.5)return;var id=nid++;pk.push({id:id,x:LX,y:LY,vx:dx/(ln||1)*pw,vy:dy/(ln||1)*pw,cl:"hsl("+hue+",80%,60%)",st:false,pt:0})}
function step(){var i,j,p,a,b,dx,dy,ds,md,d,nx,ny,ov,rv,im;
  for(i=0;i<pk.length;i++){p=pk[i];if(p.st)continue;p.x+=p.vx;p.y+=p.vy;p.vx*=FR;p.vy*=FR;
    if(p.x<PR){p.x=PR;p.vx*=-.85}else if(p.x>W-PR){p.x=W-PR;p.vx*=-.85}
    if(p.y<PR){p.y=PR;p.vy*=-.85}else if(p.y>H-PR){p.y=H-PR;p.vy*=-.85}}
  for(i=0;i<pk.length;i++){a=pk[i];for(j=i+1;j<pk.length;j++){b=pk[j];
    dx=b.x-a.x;dy=b.y-a.y;ds=dx*dx+dy*dy;md=PR*2;if(ds>=md*md||ds===0)continue;d=Math.sqrt(ds);
    nx=dx/d;ny=dy/d;ov=(md-d)/2;a.x-=nx*ov;a.y-=ny*ov;b.x+=nx*ov;b.y+=ny*ov;
    rv=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;if(rv>0)continue;im=-(1+BN)*rv/2;
    a.vx-=im*nx;a.vy-=im*ny;b.vx+=im*nx;b.vy+=im*ny;
    if(a.st){a.st=false;a.pt=0}if(b.st){b.st=false;b.pt=0}}}
  sc=0;for(i=0;i<pk.length;i++){p=pk[i];
    if(!p.st&&Math.hypot(p.vx,p.vy)<RS){p.st=true;p.vx=0;p.vy=0;
      d=Math.hypot(p.x-TX,p.y-TY);for(j=0;j<ZN.length;j++)if(d<=ZN[j].r){p.pt=ZN[j].p;break}}
    if(p.st)sc+=p.pt}}
function draw(cx,isSource){cx.fillStyle="#06080d";cx.fillRect(0,0,W,H);var i,z,p;
  for(i=ZN.length-1;i>=0;i--){z=ZN[i];cx.fillStyle=z.c;cx.globalAlpha=.18;cx.beginPath();cx.arc(TX,TY,z.r,0,Math.PI*2);cx.fill();
    cx.globalAlpha=1;cx.strokeStyle=z.c;cx.lineWidth=1;cx.beginPath();cx.arc(TX,TY,z.r,0,Math.PI*2);cx.stroke()}
  cx.fillStyle="#8b949e";cx.beginPath();cx.moveTo(LX-10,LY+8);cx.lineTo(LX+10,LY+8);cx.lineTo(LX,LY-8);cx.closePath();cx.fill();
  for(i=0;i<pk.length;i++){p=pk[i];cx.fillStyle=p.cl;cx.globalAlpha=p.st?.9:1;cx.beginPath();cx.arc(p.x,p.y,PR,0,Math.PI*2);cx.fill();
    cx.globalAlpha=1;cx.fillStyle="#fff";cx.font="bold 10px sans-serif";cx.textAlign="center";cx.textBaseline="middle";cx.fillText(String(p.id),p.x,p.y)}
  cx.fillStyle=isSource?"#58a6ff":"#bc8cff";cx.font="bold 16px sans-serif";cx.textAlign="right";cx.textBaseline="top";cx.fillText(String(sc),W-6,4)}
var cv=document.getElementById("C"),dg=null;
function xy(e){var r=cv.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*W,y:(e.clientY-r.top)/r.height*H}}
cv.addEventListener("pointerdown",function(e){dg=xy(e);cv.setPointerCapture(e.pointerId)});
cv.addEventListener("pointermove",function(e){if(dg)dg=xy(e)});
cv.addEventListener("pointerup",function(){if(!dg)return;var a=dg;dg=null;var hue=Math.floor(Math.random()*360);launch(a.x,a.y,hue)});
cv.addEventListener("pointercancel",function(){dg=null});
var cx=cv.getContext("2d");
function loop(){step();draw(cx,window.__remjs_source);requestAnimationFrame(loop)}
requestAnimationFrame(loop);
})();<\/script>
</body></html>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>remjs embed</title>
<style>
:root{color-scheme:dark;--m:ui-monospace,'SF Mono',monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;overflow:hidden;font-family:system-ui,sans-serif;color:#e6edf3}
.ly{display:grid;grid-template-columns:1fr 180px 1fr;height:100vh;gap:2px}
.pn{position:relative;overflow:hidden;min-height:0}
.lb{position:absolute;top:3px;left:6px;z-index:1;font-size:.5em;text-transform:uppercase;letter-spacing:.06em;font-weight:700;pointer-events:none;opacity:.8}
.s .lb{color:#58a6ff}.m .lb{color:#bc8cff}
iframe{display:block;width:100%;height:100%;border:none;background:#06080d}
.opp{display:flex;flex-direction:column;background:#161b22;border-left:1px solid #30363d;border-right:1px solid #30363d;min-height:0;overflow:hidden}
.oph{padding:3px 6px;border-bottom:1px solid #30363d;font-size:.5em;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;background:#0d1117;display:flex;justify-content:space-between;align-items:center}
.oph .t{font-weight:700;color:#e6edf3}
.opc{display:flex;gap:2px}
.opc button{background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:3px;padding:0 5px;font-size:1em;cursor:pointer;font-family:var(--m);line-height:1.4}
.opc button:hover{background:#30363d}.opc button.on{background:#1f6feb;border-color:#58a6ff}
.olog{flex:1;overflow-y:auto;font-family:var(--m);font-size:.5rem;line-height:1.4;padding:0;min-height:0}
.orow{padding:1px 14px 1px 14px;border-bottom:1px solid rgba(48,54,61,.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative}
.ot{display:inline-block;min-width:3.5em;font-weight:600}
.ot.event{color:#58a6ff}.ot.random{color:#bc8cff}
.orow .pc{position:absolute;top:50%;transform:translateY(-50%);font-size:.6em;line-height:1}
.orow .pc.src{color:#58a6ff;left:1px}.orow .pc.fol{color:#bc8cff;right:2px}
.opf{padding:2px 6px;border-top:1px solid #30363d;font-family:var(--m);font-size:.45rem;color:#8b949e;display:flex;justify-content:space-between;background:#0d1117}
@media(max-width:600px){.ly{grid-template-columns:1fr;grid-template-rows:1fr 120px 1fr;height:100vh}
  .opp{border-left:0;border-right:0;border-top:1px solid #30363d;border-bottom:1px solid #30363d}}
</style></head><body>
<div class="ly">
<div class="pn s"><span class="lb">source</span><iframe id="src" sandbox="allow-scripts allow-same-origin"></iframe></div>
<div class="opp">
<div class="oph"><span class="t">ops</span><div class="opc"><button id="pp">||</button><button id="st">step</button></div></div>
<div class="olog" id="ol"></div>
<div class="opf"><span><span style="color:#58a6ff">S</span>:<span id="sc">0</span></span><span><span style="color:#bc8cff">F</span>:<span id="ac">0</span></span></div>
</div>
<div class="pn m"><span class="lb">follower</span><iframe id="fol" sandbox="allow-scripts allow-same-origin"></iframe></div>
</div>
<script>
(function(){
var sourceFrame=document.getElementById("src");
var followerFrame=document.getElementById("fol");
var srcDoc=${safeJson(sourceSrcdoc)};
var folDoc=${safeJson(followerSrcdoc)};
sourceFrame.srcdoc=srcDoc;followerFrame.srcdoc=folDoc;
var followerReady=false;

window.addEventListener("message",function(ev){
  if(ev.source===followerFrame.contentWindow&&ev.data&&ev.data.type==="follower-ready"){followerReady=true;return;}
  if(ev.source===sourceFrame.contentWindow&&ev.data&&ev.data.type==="ops"&&Array.isArray(ev.data.ops)){
    for(var i=0;i<ev.data.ops.length;i++)addOp(ev.data.ops[i]);
  }
});

var $ol=document.getElementById("ol"),$sc=document.getElementById("sc"),$ac=document.getElementById("ac"),$pp=document.getElementById("pp");
var allOps=[],ac=0,paused=false,flushScheduled=false,rowEls=[];
var EVENT_TYPES={"event":1};

function addOp(o){
  var idx=allOps.length;allOps.push(o);
  var show=o.type==="random"||(o.type==="event"&&o.eventType==="pointerup");
  if(show){
    var r=document.createElement("div");r.className="orow";
    var desc=o.type==="random"?"hue="+Math.floor(o.values[0]*360):"launch";
    r.innerHTML='<span class="ot '+o.type+'">'+o.type+'</span> '+desc;
    $ol.appendChild(r);$ol.scrollTop=$ol.scrollHeight;rowEls[idx]=r;
  } else {rowEls[idx]=null;}
  updPC();
  if(!paused&&!flushScheduled){flushScheduled=true;queueMicrotask(flushToFollower);}
}
function sendBatch(from,to){
  if(from>=to)return;
  if(!followerReady){ac=from;setTimeout(function(){sendBatch(from,to);updPC();},50);return;}
  followerFrame.contentWindow.postMessage({type:"ops",ops:allOps.slice(from,to)},"*");
}
function flushToFollower(){flushScheduled=false;if(paused)return;var from=ac;ac=allOps.length;sendBatch(from,ac);updPC();}
function applyOne(){
  if(ac>=allOps.length)return;
  var from=ac,to=ac;
  while(to<allOps.length&&!EVENT_TYPES[allOps[to].type])to++;
  if(to<allOps.length)to++;
  while(to<allOps.length&&!EVENT_TYPES[allOps[to].type])to++;
  if(to===from)to=from+1;
  ac=to;sendBatch(from,to);updPC();
}
function updPC(){
  $sc.textContent=allOps.length;$ac.textContent=ac;
  for(var i=0;i<rowEls.length;i++){var r=rowEls[i];if(!r)continue;r.style.opacity=i<ac?"1":"0.35";}
  var old1=$ol.querySelector(".pc.src");if(old1)old1.remove();
  var old2=$ol.querySelector(".pc.fol");if(old2)old2.remove();
  if(allOps.length>0){var lr=findRow(allOps.length-1);if(lr){var s=document.createElement("span");s.className="pc src";s.textContent="\\u25B6";lr.prepend(s);}}
  if(ac>0){var fr=findRow(ac-1);if(fr){var f=document.createElement("span");f.className="pc fol";f.textContent="\\u25C0";fr.appendChild(f);}}
}
function findRow(idx){for(var i=idx;i>=0;i--){if(rowEls[i])return rowEls[i];}return null;}

var drainTimers=[];
function cancelDrain(){for(var t of drainTimers)clearTimeout(t);drainTimers=[];}
function drainTemporal(from,to){
  if(from>=to)return;
  var groups=[];var i=from;
  while(i<to){var gS=i;while(i<to&&!EVENT_TYPES[allOps[i].type])i++;if(i<to)i++;while(i<to&&!EVENT_TYPES[allOps[i].type])i++;if(i===gS)i=gS+1;groups.push({from:gS,to:i,ts:allOps[gS].ts||0});}
  if(!groups.length)return;var baseTs=groups[0].ts;
  for(var g=0;g<groups.length;g++){(function(grp){var delay=grp.ts-baseTs;
    drainTimers.push(setTimeout(function(){ac=grp.to;sendBatch(grp.from,grp.to);updPC();},Math.max(0,delay)));})(groups[g]);}
}
$pp.onclick=function(){paused=!paused;$pp.textContent=paused?"play":"||";$pp.classList.toggle("on",paused);
  if(!paused){flushScheduled=false;cancelDrain();if(ac<allOps.length)drainTemporal(ac,allOps.length);}else{cancelDrain();}};
document.getElementById("st").onclick=function(){if(!paused){paused=true;$pp.textContent="play";$pp.classList.add("on");cancelDrain();}applyOne();};
})();
<\/script></body></html>`;
}

// ── Build ──

async function main() {
  const bundle = await buildBundle();
  const outputs = [
    { p: path.join(ROOT, "examples", "mirror", "index.html"), fn: buildFullPage },
    { p: path.join(ROOT, "docs", "mirror.html"), fn: buildFullPage },
    { p: path.join(ROOT, "docs", "mirror-embed.html"), fn: buildEmbedPage },
  ];
  for (const { p, fn } of outputs) {
    const content = fn(bundle);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
    console.log(`wrote ${path.relative(ROOT, p)} — ${(Buffer.byteLength(content) / 1024).toFixed(1)} KB`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
