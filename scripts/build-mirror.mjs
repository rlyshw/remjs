/**
 * Build the standalone mirror demo HTML — v0.3 event loop replication.
 *
 * Single HTML file with two canvases + op inspector panel.
 * Source runs with real inputs, mirror replays recorded ops.
 * Play/pause/step controls let you inspect each op.
 *
 *   node scripts/build-mirror.mjs
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

// ── The demo HTML (template built as a function, NOT a template literal) ──

function buildFullPage(bundle) {
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
canvas{display:block;width:100%;height:100%;cursor:crosshair;background:#06080d}
.opp{display:flex;flex-direction:column;border:1px solid #30363d;border-radius:6px;background:#161b22}
.oph{padding:5px 8px;border-bottom:1px solid #30363d;display:flex;align-items:center;justify-content:space-between;font-size:.6em;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;background:#0d1117;border-radius:6px 6px 0 0}
.oph .t{font-weight:700;color:#e6edf3}
.opc{display:flex;gap:3px}
.opc button{background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:3px;padding:1px 7px;font-size:1em;cursor:pointer;font-family:var(--m)}
.opc button:hover{background:#30363d}
.opc button.on{background:#1f6feb;border-color:#58a6ff}
.olog{flex:1;overflow-y:auto;font-family:var(--m);font-size:.58rem;line-height:1.5;padding:0}
.orow{padding:1px 8px;border-bottom:1px solid rgba(48,54,61,.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.orow.pend{opacity:.35}.orow.done{opacity:1}
.orow .ot{display:inline-block;min-width:4.2em;font-weight:600}
.ot.launch{color:#f0c040}.ot.random{color:#bc8cff}
.opf{padding:4px 8px;border-top:1px solid #30363d;font-family:var(--m);font-size:.55rem;color:#8b949e;display:flex;justify-content:space-between;background:#0d1117;border-radius:0 0 6px 6px}
.ig{font-weight:700}.ig.ok{color:#3fb950}.ig.bad{color:#f85149}
@media(max-width:900px){.layout{grid-template-columns:1fr 1fr;grid-template-rows:1fr 200px}.opp{grid-column:1/-1}}
@media(max-width:500px){.layout{grid-template-columns:1fr;grid-template-rows:auto 160px auto;height:auto;min-height:0}
  canvas{aspect-ratio:4/3;height:auto}}
</style></head><body>
<h1>remjs mirror — shuffleboard</h1>
<p class="hint">Click left canvas to launch. Each click emits a <code>random</code> op (puck color) + <code>launch</code> op (aim). Ops flow to the right canvas. <strong>Pause</strong> to queue them, <strong>Step</strong> to replay one at a time.</p>
<div class="layout">
<div class="panel source"><span class="plbl">source</span><canvas id="S" width="560" height="420"></canvas></div>
<div class="opp">
<div class="oph"><span class="t">op stream</span><div class="opc"><button id="pp" title="pause / play">| |</button><button id="st">step</button><button id="rs">reset</button></div></div>
<div class="olog" id="ol"></div>
<div class="opf"><span>queued: <span id="qc">0</span></span><span>applied: <span id="ac">0</span></span><span class="ig ok" id="ig">in sync</span></div>
</div>
<div class="panel mirror"><span class="plbl">follower</span><canvas id="M" width="560" height="420"></canvas></div>
</div>
<script>${bundle}<\/script>
<script>
(function(){
var W=560,H=420,LX=W/2,LY=H-34,TX=W/2,TY=70;
var ZN=[{r:22,p:5,c:"#f0c040"},{r:46,p:3,c:"#6fa8dc"},{r:74,p:1,c:"#3e5978"}];
var PR=14,FR=.985,RS=.2,BN=.9;

function mk(){
  var pk=[],nid=1,sc=0;
  return{pk:pk,sc:function(){return sc},
    launch:function(ax,ay,hue){
      var dx=ax-LX,dy=ay-LY,ln=Math.hypot(dx,dy),pw=Math.min(14,ln/14);
      if(pw<.5)return;var nx=dx/(ln||1),ny=dy/(ln||1),id=nid++;
      pk.push({id:id,x:LX,y:LY,vx:nx*pw,vy:ny*pw,cl:"hsl("+hue+",80%,60%)",st:false,pt:0});
    },
    step:function(){
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
    }};
}

function dr(cx,g,src){
  cx.fillStyle="#06080d";cx.fillRect(0,0,W,H);
  var i,z,p;
  for(i=ZN.length-1;i>=0;i--){z=ZN[i];cx.fillStyle=z.c;cx.globalAlpha=.18;
    cx.beginPath();cx.arc(TX,TY,z.r,0,Math.PI*2);cx.fill();
    cx.globalAlpha=1;cx.strokeStyle=z.c;cx.lineWidth=1;
    cx.beginPath();cx.arc(TX,TY,z.r,0,Math.PI*2);cx.stroke()}
  cx.fillStyle="#8b949e";cx.beginPath();cx.moveTo(LX-12,LY+10);cx.lineTo(LX+12,LY+10);cx.lineTo(LX,LY-10);cx.closePath();cx.fill();
  for(i=0;i<g.pk.length;i++){p=g.pk[i];cx.fillStyle=p.cl;cx.globalAlpha=p.st?.9:1;
    cx.beginPath();cx.arc(p.x,p.y,PR,0,Math.PI*2);cx.fill();
    cx.globalAlpha=1;cx.fillStyle="#fff";cx.font="bold 11px sans-serif";cx.textAlign="center";cx.textBaseline="middle";
    cx.fillText(String(p.id),p.x,p.y)}
  cx.fillStyle=src?"#58a6ff":"#bc8cff";cx.font="bold 18px sans-serif";cx.textAlign="right";cx.textBaseline="top";
  cx.fillText(String(g.sc()),W-8,6);cx.font="9px sans-serif";cx.fillStyle="#8b949e";cx.fillText("score",W-8,26);
}

var S=mk(),M=mk();
var sc=document.getElementById("S").getContext("2d"),mc=document.getElementById("M").getContext("2d");
var $ol=document.getElementById("ol"),$qc=document.getElementById("qc"),$ac=document.getElementById("ac"),$ig=document.getElementById("ig");
var $pp=document.getElementById("pp");

var ops=[],pend=[],ac=0,paused=false;

function addOp(o){
  ops.push(o);pend.push(o);
  var r=document.createElement("div");r.className="orow pend";
  var tc=o.type==="launch"?"launch":"random";
  var dt=o.type==="launch"?"x:"+Math.round(o.x)+" y:"+Math.round(o.y)+" hue:"+o.hue:"hue = "+o.value;
  r.innerHTML='<span class="ot '+tc+'">'+o.type+"</span> "+dt;
  r.id="o"+ops.length;$ol.appendChild(r);$ol.scrollTop=$ol.scrollHeight;upd();
}
function applyOne(){
  if(!pend.length)return false;var o=pend.shift();
  if(o.type==="launch")M.launch(o.x,o.y,o.hue);
  ac++;var r=document.getElementById("o"+ac);if(r)r.className="orow done";upd();return true;
}
function applyAll(){while(pend.length)applyOne()}
function upd(){$qc.textContent=pend.length;$ac.textContent=ac}

$pp.onclick=function(){paused=!paused;$pp.textContent=paused?"play":"| |";$pp.classList.toggle("on",paused)};
document.getElementById("st").onclick=function(){if(!paused){paused=true;$pp.textContent="play";$pp.classList.add("on")}applyOne()};
document.getElementById("rs").onclick=function(){S=mk();M=mk();ops=[];pend=[];ac=0;$ol.innerHTML="";upd()};

var cv=document.getElementById("S"),dg=null;
function xy(e){var r=cv.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*W,y:(e.clientY-r.top)/r.height*H}}
cv.addEventListener("pointerdown",function(e){dg=xy(e);cv.setPointerCapture(e.pointerId)});
cv.addEventListener("pointermove",function(e){if(dg)dg=xy(e)});
cv.addEventListener("pointerup",function(){if(!dg)return;var a=dg;dg=null;
  var hue=Math.floor(Math.random()*360);S.launch(a.x,a.y,hue);
  addOp({type:"random",value:hue});addOp({type:"launch",x:a.x,y:a.y,hue:hue})});
cv.addEventListener("pointercancel",function(){dg=null});

function loop(){
  S.step();if(!paused)applyAll();M.step();
  dr(sc,S,true);dr(mc,M,false);
  var ok=S.pk.length===M.pk.length;
  if(ok)for(var i=0;i<S.pk.length;i++){var a=S.pk[i],b=M.pk[i];if(Math.abs(a.x-b.x)>.01||Math.abs(a.y-b.y)>.01){ok=false;break}}
  if(pend.length)ok=false;
  $ig.className="ig "+(ok?"ok":"bad");$ig.textContent=ok?"in sync":pend.length?"behind":"DESYNC";
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
})();
<\/script></body></html>`;
}

// ── Embed variant (for landing page) ──

function buildEmbedPage(bundle) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>remjs embed</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;overflow:hidden;font-family:system-ui,sans-serif;color:#e6edf3}
.p{display:flex;gap:2px;height:100vh}
.pn{flex:1;position:relative;overflow:hidden}
.lb{position:absolute;top:3px;left:6px;z-index:1;font-size:.5em;text-transform:uppercase;letter-spacing:.06em;font-weight:700;pointer-events:none;opacity:.8}
.s .lb{color:#58a6ff}.m .lb{color:#bc8cff}
canvas{display:block;width:100%;height:100%;cursor:crosshair;background:#06080d}
.ig{position:absolute;bottom:5px;right:8px;font-size:.5em;font-weight:700;font-family:ui-monospace,monospace}
.ig.ok{color:#3fb950}.ig.bad{color:#f85149}
.hn{position:absolute;bottom:5px;left:0;right:0;text-align:center;color:#8b949e;font-size:.5em;pointer-events:none;opacity:.7}
</style></head><body>
<div class="p">
<div class="pn s"><span class="lb">source</span><canvas id="S" width="520" height="400"></canvas></div>
<div class="pn m"><span class="lb">follower</span><canvas id="M" width="520" height="400"></canvas></div>
</div>
<span class="hn" id="hn">click left canvas to launch</span>
<span class="ig ok" id="ig">in sync</span>
<script>${bundle}<\/script>
<script>
(function(){
var W=520,H=400,LX=W/2,LY=H-32,TX=W/2,TY=60;
var ZN=[{r:20,p:5,c:"#f0c040"},{r:42,p:3,c:"#6fa8dc"},{r:68,p:1,c:"#3e5978"}];
var PR=12,FR=.985,RS=.2,BN=.9;
function mk(){
  var pk=[],nid=1,sc=0;
  return{pk:pk,sc:function(){return sc},
    launch:function(ax,ay,hue){var dx=ax-LX,dy=ay-LY,ln=Math.hypot(dx,dy),pw=Math.min(13,ln/13);
      if(pw<.5)return;var id=nid++;pk.push({id:id,x:LX,y:LY,vx:dx/(ln||1)*pw,vy:dy/(ln||1)*pw,cl:"hsl("+hue+",80%,60%)",st:false,pt:0})},
    step:function(){var i,j,p,a,b,dx,dy,ds,md,d,nx,ny,ov,rv,im;
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
        if(p.st)sc+=p.pt}}};
}
function dr(cx,g,src){cx.fillStyle="#06080d";cx.fillRect(0,0,W,H);var i,z,p;
  for(i=ZN.length-1;i>=0;i--){z=ZN[i];cx.fillStyle=z.c;cx.globalAlpha=.18;cx.beginPath();cx.arc(TX,TY,z.r,0,Math.PI*2);cx.fill();
    cx.globalAlpha=1;cx.strokeStyle=z.c;cx.lineWidth=1;cx.beginPath();cx.arc(TX,TY,z.r,0,Math.PI*2);cx.stroke()}
  cx.fillStyle="#8b949e";cx.beginPath();cx.moveTo(LX-10,LY+8);cx.lineTo(LX+10,LY+8);cx.lineTo(LX,LY-8);cx.closePath();cx.fill();
  for(i=0;i<g.pk.length;i++){p=g.pk[i];cx.fillStyle=p.cl;cx.globalAlpha=p.st?.9:1;cx.beginPath();cx.arc(p.x,p.y,PR,0,Math.PI*2);cx.fill();
    cx.globalAlpha=1;cx.fillStyle="#fff";cx.font="bold 10px sans-serif";cx.textAlign="center";cx.textBaseline="middle";cx.fillText(String(p.id),p.x,p.y)}
  cx.fillStyle=src?"#58a6ff":"#bc8cff";cx.font="bold 16px sans-serif";cx.textAlign="right";cx.textBaseline="top";cx.fillText(String(g.sc()),W-6,4)}
var S=mk(),M=mk(),sc=document.getElementById("S").getContext("2d"),mc=document.getElementById("M").getContext("2d");
var $ig=document.getElementById("ig"),$hn=document.getElementById("hn"),oq=[];
var cv=document.getElementById("S"),dg=null;
function xy(e){var r=cv.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*W,y:(e.clientY-r.top)/r.height*H}}
cv.addEventListener("pointerdown",function(e){dg=xy(e);cv.setPointerCapture(e.pointerId)});
cv.addEventListener("pointermove",function(e){if(dg)dg=xy(e)});
cv.addEventListener("pointerup",function(){if(!dg)return;var a=dg;dg=null;var h=Math.floor(Math.random()*360);
  S.launch(a.x,a.y,h);oq.push({x:a.x,y:a.y,h:h});$hn.style.opacity="0"});
cv.addEventListener("pointercancel",function(){dg=null});
function loop(){S.step();for(var o of oq)M.launch(o.x,o.y,o.h);oq=[];M.step();dr(sc,S,true);dr(mc,M,false);
  var ok=S.pk.length===M.pk.length;if(ok)for(var i=0;i<S.pk.length;i++){var a=S.pk[i],b=M.pk[i];if(Math.abs(a.x-b.x)>.01||Math.abs(a.y-b.y)>.01){ok=false;break}}
  $ig.className="ig "+(ok?"ok":"bad");$ig.textContent=ok?"in sync":"DESYNC";requestAnimationFrame(loop)}
requestAnimationFrame(loop);
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
