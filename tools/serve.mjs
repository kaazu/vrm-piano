#!/usr/bin/env node
// Tiny static file server for the viewer and tools (no dependencies).
//   node tools/serve.mjs [port] [root]     default: 8001, the repository root
// ES modules and fetch() do not work from file://, so open the pages through this server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || process.env.PORT || 8001);
const root = path.resolve(process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.vrm': 'model/gltf-binary', '.glb': 'model/gltf-binary', '.mid': 'audio/midi', '.midi': 'audio/midi',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (rel === '/' && !fs.existsSync(path.join(root, 'index.html'))) { res.writeHead(302, { Location: '/viewer/' }).end(); return; }
  let file = path.join(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!rel.endsWith('/')) { res.writeHead(301, { Location: rel + '/' }).end(); return; }
      file = path.join(file, 'index.html');
    }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + rel); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  });
}).listen(port, () => {
  console.log(`vrm-piano: serving ${root}`);
  console.log(`  viewer:   http://localhost:${port}/viewer/`);
  console.log(`  auto-fit: http://localhost:${port}/tools/autofit.html`);
  console.log(`  roll:     http://localhost:${port}/fingering/roll.html`);
});
