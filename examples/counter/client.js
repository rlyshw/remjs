import { connect } from "/_shared/client.js";

const $count = document.getElementById("count");
const $history = document.getElementById("history");

function render(state) {
  $count.textContent = state.count;
  $history.innerHTML = state.history
    .slice(-20)
    .reverse()
    .map((h) => `<div>${h.time} — ${h.action} (→ ${h.value})</div>`)
    .join("");
}

connect({ onChange: render }).then(({ state }) => {
  const stamp = () => new Date().toISOString().slice(11, 19);
  const push = (action, value) => {
    state.history.push({ time: stamp(), action, value });
    if (state.history.length > 50) state.history.shift();
  };

  document.getElementById("inc").addEventListener("click", () => {
    state.count++;
    push("inc", state.count);
  });
  document.getElementById("dec").addEventListener("click", () => {
    state.count--;
    push("dec", state.count);
  });
  document.getElementById("reset").addEventListener("click", () => {
    state.count = 0;
    push("reset", 0);
  });
});
