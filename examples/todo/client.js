import { connect } from "/_shared/client.js";

const $list = document.getElementById("list");
const $stats = document.getElementById("stats");
const $form = document.getElementById("add-form");
const $input = document.getElementById("add-input");
const $filterButtons = document.querySelectorAll(".filters button");

/* ── App state (local, identical on every tab via event replay) ── */

const state = {
  todos: [
    { id: 1, text: "Try remjs", done: false },
    { id: 2, text: "Open this in two tabs", done: false },
  ],
  nextId: 3,
  filter: "all",
};

/* ── Render ──────────────────────────────────────────────────── */

function visibleTodos() {
  if (state.filter === "active") return state.todos.filter((t) => !t.done);
  if (state.filter === "done") return state.todos.filter((t) => t.done);
  return state.todos;
}

function render() {
  const visible = visibleTodos();
  $list.innerHTML = visible
    .map(
      (t) => `
      <li class="${t.done ? "done" : ""}" data-id="${t.id}">
        <input type="checkbox" ${t.done ? "checked" : ""} />
        <span class="text">${escapeHtml(t.text)}</span>
        <button class="remove" title="remove">\u00d7</button>
      </li>`,
    )
    .join("");

  const active = state.todos.filter((t) => !t.done).length;
  const total = state.todos.length;
  $stats.textContent = `${active} active / ${total} total`;

  for (const btn of $filterButtons) {
    btn.classList.toggle("active", btn.dataset.filter === state.filter);
  }
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/* ── Event handlers (same code runs on every tab) ────────────── */

$form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $input.value.trim();
  if (!text) return;
  state.todos.push({ id: state.nextId, text, done: false });
  state.nextId++;
  $input.value = "";
  render();
});

$list.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  const id = Number(li.dataset.id);
  const idx = state.todos.findIndex((t) => t.id === id);
  if (idx === -1) return;

  if (e.target.matches(".remove")) {
    state.todos.splice(idx, 1);
  } else if (e.target.matches('input[type="checkbox"]')) {
    state.todos[idx].done = e.target.checked;
  }
  render();
});

for (const btn of $filterButtons) {
  btn.addEventListener("click", () => {
    state.filter = btn.dataset.filter;
    render();
  });
}

/* ── Connect: recorder captures events, player replays them ── */

connect({
  onOps: () => render(),
  recorderOptions: {
    // Only capture DOM events — no timers/network/random needed for todo
    timers: false,
    network: false,
    random: false,
    clock: false,
    storage: false,
  },
});

render();
