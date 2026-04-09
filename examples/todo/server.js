import { createStaticServer } from "../_shared/static-server.js";
import { createSession } from "../_shared/session.js";

const server = createStaticServer(import.meta.url);

const state = {
  todos: [
    { id: 1, text: "Try remjs", done: false },
    { id: 2, text: "Open this in two tabs", done: false },
  ],
  nextId: 3,
  filter: "all", // "all" | "active" | "done"
};

createSession(state, server);

const PORT = 7402;
server.listen(PORT, () => {
  console.log(`remjs todo demo → http://localhost:${PORT}`);
});
