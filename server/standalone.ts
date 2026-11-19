#!/usr/bin/env node
// The standalone app: serves the editor page to a browser on this machine and
// carries its messages to a Session.   node server/standalone.ts <projectDir> [--port N]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Session, type InMsg, type OutMsg } from '../engine/src/session.ts';
import { buildSketch } from '../engine/src/build.ts';

const HOST = '127.0.0.1';
const TICK_MS = 16;
/** The only files the page is made of. Nothing else is ever served. */
const FILES: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface Server { host: string; port: number; running(): boolean; close(): Promise<void> }

export function startServer(opts: { dir: string; port: number; build?: (dir: string) => Promise<{ ok: boolean; log: string; hex?: string }>; appDir?: string }): Promise<Server> {
  const appDir = opts.appDir ?? path.resolve(import.meta.dirname, '..', 'dist', 'app');
  const session = new Session({ build: opts.build ?? ((d, b) => buildSketch(d, b)), watch: true });
  const clients = new Set<http.ServerResponse>();
  let state = 'idle';
  let timer: NodeJS.Timeout | null = null, last = 0;

  session.onMessage((m) => {
    if (m.t === 'status') state = m.state;
    const line = `data: ${JSON.stringify(m)}\n\n`;
    for (const c of clients) c.write(line);
  });
  // Tick only while a page is watching, so a closed tab never leaves a core busy.
  const setTicking = (on: boolean) => {
    if (on && !timer) { last = performance.now(); timer = setInterval(() => { const now = performance.now(); session.tick(now - last); last = now; }, TICK_MS); }
    if (!on && timer) { clearInterval(timer); timer = null; }
  };

  const server = http.createServer((req, res) => {
    // No request may take the server down: unsaved work lives in this process.
    try { serve(req, res); } catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error'); }
  });
  const serve = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const port = (server.address() as { port: number }).port;
    const ours = [`${HOST}:${port}`, `localhost:${port}`];
    const deny = (code: number, text: string) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(text); };
    // Only this machine's own page may talk to the simulator (guards against other sites and DNS rebinding).
    if (!ours.includes(req.headers.host ?? '')) return deny(403, 'forbidden');
    const origin = req.headers.origin;
    if (origin && !ours.some((h) => origin === `http://${h}`)) return deny(403, 'forbidden');
    const url = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(res); setTicking(true);
      void session.handle({ t: 'hello' });
      req.on('close', () => {
        clients.delete(res);
        if (clients.size === 0) { setTicking(false); void session.handle({ t: 'stop' }); }
      });
      return;
    }
    if (req.method === 'POST' && url === '/msg') {
      // Only our own page sends JSON; a form on another site cannot.
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return deny(415, 'send application/json');
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1 << 20) req.destroy(); });
      req.on('end', () => {
        let msg: InMsg;
        try { msg = JSON.parse(body); if (!msg || typeof msg.t !== 'string') throw new Error('no type'); } catch { return deny(400, 'bad message'); }
        if (msg.t === 'open') return deny(400, 'the folder is chosen when the server starts');
        void session.handle(msg).then(() => { res.writeHead(204); res.end(); });
      });
      return;
    }
    if (req.method === 'GET') {
      const name = url === '/' ? 'index.html' : url.slice(1);
      if (!Object.hasOwn(FILES, name)) return deny(404, 'not found');
      const body = fs.readFileSync(path.join(appDir, name));
      res.writeHead(200, { 'content-type': FILES[name], 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
      res.end(body);
      return;
    }
    deny(405, 'method not allowed');
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, HOST, async () => {
      await session.handle({ t: 'open', dir: opts.dir });
      resolve({
        host: HOST, port: (server.address() as { port: number }).port,
        running: () => state === 'running',
        close: () => new Promise((done) => { setTicking(false); session.dispose(); for (const c of clients) c.end(); server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--port');
  const port = i >= 0 ? Number(args[i + 1]) : 8190;
  const dir = args.filter((_a, n) => i < 0 || (n !== i && n !== i + 1))[0];
  if (!dir || !Number.isInteger(port) || port < 0 || port > 65535) { console.error('usage: node server/standalone.ts <projectDir> [--port N]'); process.exit(2); }
  const full = path.resolve(dir);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) { console.error(`not a folder: ${full}`); process.exit(2); }
  if (!fs.existsSync(path.resolve(import.meta.dirname, '..', 'dist', 'app', 'app.js'))) { console.error('the page is not built yet: run "npm run build" first'); process.exit(2); }
  startServer({ dir: full, port }).then(
    (s) => console.log(`shibo: ${full}\nopen http://${s.host}:${s.port}`),
    (err) => { console.error(err.code === 'EADDRINUSE' ? `port ${port} is already in use; pick another with --port` : err.message); process.exit(1); },
  );
}
