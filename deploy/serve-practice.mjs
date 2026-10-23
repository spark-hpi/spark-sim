// Static server for a SPARK Sim build (default directory: ./dist-practice), sending the cross-origin
// isolation headers (COOP/COEP) the simulator needs. Zero dependencies: needs only Node.js (v18+).
//
//   node serve-practice.mjs            # serves ./dist-practice on http://localhost:8099
//   node serve-practice.mjs 9000 ./x   # custom port and directory
//
// It sends the cross-origin-isolation headers (COOP/COEP) that the simulator needs for
// SharedArrayBuffer, which is why opening index.html directly (file://) does NOT work.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";

const port = Number(process.argv[2]) || 8099;
const root = normalize(join(process.cwd(), process.argv[3] || "dist-practice"));
// Binds to loopback by default. To expose on the LAN, set SPARK_HOST=0.0.0.0 explicitly.
const host = process.env.SPARK_HOST || "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  // applied to every response incl. the robot workers, so a robot program cannot reach the network
  "Content-Security-Policy": "connect-src 'self'; object-src 'none'; base-uri 'self'",
  "X-Robots-Tag": "noindex, nofollow",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes("\0") || decoded.includes("\\")) {
      res.writeHead(400).end("Bad request");
      return;
    }
    let path = normalize(join(root, decoded));
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    if (url.pathname.endsWith("/")) path = join(path, "index.html");

    let body;
    try {
      body = await readFile(path);
    } catch {
      // SPA fallback: unknown paths get index.html
      path = join(root, "index.html");
      body = await readFile(path);
    }
    res.writeHead(200, { ...ISOLATION, "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end("Server error: " + e.message);
  }
});

server.listen(port, host, () => {
  console.log(`\n  ★ SPARK Sim (practice) — http://localhost:${port}\n  serving ${root} (bound to ${host})\n  Ctrl+C to stop.\n`);
});
