import { createStaticServer } from "../_shared/static-server.js";
import { createSession } from "../_shared/session.js";

const server = createStaticServer(import.meta.url);

createSession(server);

const PORT = 7402;
server.listen(PORT, () => {
  console.log(`remjs todo demo → http://localhost:${PORT}`);
});
