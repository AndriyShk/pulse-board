// Local preview: serves the site on http://localhost:8772 and re-runs the indexer every 5 minutes,
// so the data stays fresh the way the GitHub workflow keeps it in production.
// Usage: node dev.mjs        (NO_REFRESH=1 to serve only)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 8772;
const EVERY = 5 * 6e4;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, path.endsWith("/") ? path + "index.html" : path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    // never cached, so an edit or fresh data shows on the next reload
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
  } catch { res.writeHead(404).end("Not found"); }
}).listen(PORT, () => console.log(`Pulse Board on http://localhost:${PORT}`));

let running = false;
function refresh() {
  if (running) return; // a slow run must not overlap the next one
  running = true;
  const run = spawn(process.execPath, ["scripts/build-board.mjs"], { cwd: ROOT });
  let out = "";
  run.stdout.on("data", (d) => (out += d));
  run.stderr.on("data", (d) => (out += d));
  run.on("close", (code) => { running = false; console.log(`[board ${new Date().toLocaleTimeString()}] ${code ? "FAILED: " : ""}${out.trim().split("\n").pop()}`); });
}
if (!process.env.NO_REFRESH) { refresh(); setInterval(refresh, EVERY); }
