import { createStaticServer } from "../_shared/static-server.js";
import { createSession } from "../_shared/session.js";

const server = createStaticServer(import.meta.url);

const state = { count: 0, history: [] };
createSession(state, server);

const PORT = 7401;
server.listen(PORT, () => {
  console.log(`remjs counter demo → http://localhost:${PORT}`);
});
