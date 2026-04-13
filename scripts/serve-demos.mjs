import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "examples");
const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split("?")[0]);
  let fp = path.resolve(ROOT, "." + url);
  try {
    if (fs.statSync(fp).isDirectory()) fp = path.join(fp, "index.html");
  } catch {}
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const data = fs.readFileSync(fp);
    res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(7500, "0.0.0.0", () => {
  console.log("Serving demos at http://0.0.0.0:7500");
  console.log("Root:", ROOT);
});
