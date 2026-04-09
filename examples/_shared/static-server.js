/**
 * Minimal static file server shared by the demos.
 *
 * Serves files from a `demoDir` at the root, and serves the compiled remjs
 * library from `dist/` at `/lib/*`. Returns an `http.Server` you can call
 * `.listen(port)` on — or layer a WebSocketServer on top of.
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createStaticServer(demoUrl) {
  const demoDir = path.dirname(fileURLToPath(demoUrl));
  const libDir = path.resolve(demoDir, "..", "..", "dist");
  const sharedDir = path.resolve(demoDir, "..", "_shared");

  return http.createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      let filePath;
      if (url === "/" || url === "/index.html") {
        filePath = path.join(demoDir, "index.html");
      } else if (url.startsWith("/lib/")) {
        filePath = path.join(libDir, url.slice(5));
      } else if (url.startsWith("/_shared/")) {
        filePath = path.join(sharedDir, url.slice(9));
      } else {
        filePath = path.join(demoDir, url.slice(1));
      }

      // Prevent path traversal.
      const resolved = path.resolve(filePath);
      if (
        !resolved.startsWith(demoDir) &&
        !resolved.startsWith(libDir) &&
        !resolved.startsWith(sharedDir)
      ) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }

      const content = await fs.readFile(resolved);
      const mime = MIME[path.extname(resolved)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": mime });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
}
