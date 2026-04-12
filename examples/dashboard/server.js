/**
 * Dashboard demo — v0.3 event loop replication.
 *
 * The server is just a WebSocket relay. The first client that connects
 * runs the metric simulation locally; its timer/random/clock ops are
 * recorded and broadcast. Other tabs replay those ops to produce
 * identical metrics.
 */

import { createStaticServer } from "../_shared/static-server.js";
import { createSession } from "../_shared/session.js";

const server = createStaticServer(import.meta.url);

createSession(server);

const PORT = 7403;
server.listen(PORT, () => {
  console.log(`remjs dashboard demo → http://localhost:${PORT}`);
});
