/**
 * Shared inspector panel — CSS + HTML + JS for the op stream panel
 * used across per-subsystem demos.
 *
 * The parent page hosts two iframes (source + follower) and relays
 * ops between them through this inspector, which provides:
 *   - pause / step / reset controls
 *   - scrolling op log with type-colored badges
 *   - program counter arrows: source (blue) at latest, follower (purple) at applied
 *   - click any op row to jump the follower to that point
 */

/**
 * Returns the inspector CSS block (goes inside <style>).
 */
export function inspectorCSS() {
  return `
.opp{display:flex;flex-direction:column;border:1px solid #30363d;border-radius:6px;background:#161b22;overflow:hidden;min-height:0}
.oph{padding:5px 8px;border-bottom:1px solid #30363d;display:flex;align-items:center;justify-content:space-between;font-size:.6em;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;background:#0d1117;border-radius:6px 6px 0 0}
.oph .t{font-weight:700;color:#e6edf3}
.opc{display:flex;gap:3px}
.opc button{background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:3px;padding:1px 7px;font-size:1em;cursor:pointer;font-family:var(--m)}
.opc button:hover{background:#30363d}
.opc button.on{background:#1f6feb;border-color:#58a6ff}
.extra-ui{padding:4px 8px;border-bottom:1px solid #30363d;font-size:.6em;color:#8b949e;display:flex;align-items:center;gap:6px}
.extra-ui label{display:flex;align-items:center;gap:4px;cursor:pointer}
.olog{flex:1;overflow-y:auto;font-family:var(--m);font-size:.58rem;line-height:1.5;padding:0;min-height:0}
.orow{padding:1px 16px 1px 18px;border-bottom:1px solid rgba(48,54,61,.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative}
.orow .ot{display:inline-block;min-width:5em;font-weight:600}
.orow .pc{position:absolute;top:50%;transform:translateY(-50%);font-size:.7em;line-height:1}
.orow .pc.src{color:#58a6ff;left:2px}.orow .pc.fol{color:#bc8cff;right:4px}
.ot.event{color:#58a6ff}.ot.random{color:#bc8cff}.ot.clock{color:#f0c040}
.ot.network{color:#3fb950}.ot.storage{color:#f78166}.ot.timer{color:#8b949e}
.opf{padding:4px 8px;border-top:1px solid #30363d;font-family:var(--m);font-size:.55rem;color:#8b949e;display:flex;justify-content:space-between;background:#0d1117;border-radius:0 0 6px 6px}
`;
}

/**
 * Returns the inspector HTML block (goes inside the layout div).
 * @param {string} [extraUI] — optional extra HTML for the inspector (e.g. toggle switches)
 */
export function inspectorHTML(extraUI = "") {
  const extraBlock = extraUI ? `<div class="extra-ui">${extraUI}</div>` : "";
  return `
<div class="opp">
<div class="oph"><span class="t">op stream</span><div class="opc"><button id="pp" title="pause / play">| |</button><button id="st">step</button><button id="rs">reset</button></div></div>
${extraBlock}
<div class="olog" id="ol"></div>
<div class="opf"><span><span style="color:#58a6ff">S</span>ource: <span id="sc">0</span></span><span><span style="color:#bc8cff">F</span>ollower: <span id="ac">0</span></span></div>
</div>`;
}

/**
 * Returns the inspector JS block (goes inside <script>).
 * Expects `formatOp(op)` to be defined before this runs.
 * Expects `sourceFrame` and `followerFrame` to be iframe elements.
 * Expects `onReset()` to be defined for the reset button.
 */
export function inspectorJS() {
  return `
var $ol=document.getElementById("ol"),$sc=document.getElementById("sc"),$ac=document.getElementById("ac");
var $pp=document.getElementById("pp");
var allOps=[],ac=0,paused=false,flushScheduled=false;
var rowEls=[];  // DOM rows parallel to allOps (null for filtered ops)

var EVENT_TYPES={"event":1,"snapshot":1};

function addOp(o){
  var idx=allOps.length;
  allOps.push(o);
  var desc=typeof formatOp==="function"?formatOp(o):(o.type||"?");
  if(desc!==null){
    var r=document.createElement("div");r.className="orow";
    r.setAttribute("data-idx",idx);
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
  if(typeof followerReady!=="undefined"&&!followerReady){
    // Follower not ready — defer
    ac=from;
    setTimeout(function(){sendBatch(from,to);updPC();},50);
    return;
  }
  var seeds=[],events=[];
  for(var i=from;i<to;i++){
    var o=allOps[i];
    if(EVENT_TYPES[o.type])events.push(o);
    else seeds.push(o);
  }
  var batch=seeds.concat(events);
  if(batch.length){
    followerFrame.contentWindow.postMessage({type:"ops",ops:batch},"*");
  }
}

function flushToFollower(){
  flushScheduled=false;
  if(paused)return;
  var from=ac;
  ac=allOps.length;
  sendBatch(from,ac);
  updPC();
}

function applyOne(){
  if(ac>=allOps.length)return false;
  // Step in logical groups: one event + all trailing seed ops that follow it.
  // Ops arrive as [event, random, random, ...] because the recorder emits
  // the EventOp first, then the handler runs and generates seed ops.
  // We need to send the event + all its seeds as one batch so the follower
  // has the values queued before the event handler consumes them.
  var from=ac;
  var to=ac;
  // Skip any leading seed ops (shouldn't happen, but defensive)
  while(to<allOps.length&&!EVENT_TYPES[allOps[to].type])to++;
  // Include the event
  if(to<allOps.length)to++;
  // Include all trailing seed ops until the next event
  while(to<allOps.length&&!EVENT_TYPES[allOps[to].type])to++;
  // If no event found, just advance one
  if(to===from)to=from+1;
  ac=to;
  sendBatch(from,to);
  updPC();
  return true;
}


function updPC(){
  $sc.textContent=allOps.length;
  $ac.textContent=ac;
  // Update row highlights
  for(var i=0;i<rowEls.length;i++){
    var r=rowEls[i];if(!r)continue;
    r.style.opacity=i<ac?"1":"0.35";
  }
  // Place arrows
  var oldSrc=$ol.querySelector(".pc.src");if(oldSrc)oldSrc.remove();
  var oldFol=$ol.querySelector(".pc.fol");if(oldFol)oldFol.remove();
  // Source arrow on latest op
  if(allOps.length>0){
    var lastRow=findRow(allOps.length-1);
    if(lastRow){var s=document.createElement("span");s.className="pc src";s.textContent="\\u25B6";lastRow.prepend(s);}
  }
  // Follower arrow on last applied op
  if(ac>0){
    var folRow=findRow(ac-1);
    if(folRow){var f=document.createElement("span");f.className="pc fol";f.textContent="\\u25C0";folRow.appendChild(f);}
  }
  // Scroll follower arrow into view
  var target=ac>0?findRow(ac-1):null;
  if(target)target.scrollIntoView({block:"nearest"});
}

function findRow(idx){
  // Find nearest visible row at or before idx
  for(var i=idx;i>=0;i--){if(rowEls[i])return rowEls[i];}
  return null;
}

$pp.onclick=function(){
  paused=!paused;$pp.textContent=paused?"play":"| |";$pp.classList.toggle("on",paused);
  if(!paused){
    flushScheduled=false;
    var from=ac;ac=allOps.length;
    sendBatch(from,ac);
    updPC();
  }
};
document.getElementById("st").onclick=function(){
  if(!paused){paused=true;$pp.textContent="play";$pp.classList.add("on");}
  applyOne();
};
document.getElementById("rs").onclick=function(){
  allOps=[];rowEls=[];ac=0;flushScheduled=false;$ol.innerHTML="";updPC();
  if(typeof onReset==="function")onReset();
};
`;
}
