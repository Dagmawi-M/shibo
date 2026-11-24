import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, standaloneToolchain } from '../../server/standalone.ts';
import { makeRig, chain } from './helpers/setup-rig.ts';
import { ownCompiler } from '../src/compiler.ts';
import { createProject } from '../src/templates.ts';

const hex = readFileSync(new URL('./fixtures/toggle.hex', import.meta.url), 'utf8');
function folder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-h-'));
  writeFileSync(path.join(dir, 'diagram.json'), JSON.stringify({ version: 1,
    parts: [{ type: 'wokwi-arduino-uno', id: 'uno', top: 0, left: 0 }, { type: 'wokwi-led', id: 'led1', top: -90, left: 120 }],
    connections: [['uno:13', 'led1:A', 'green', []], ['led1:C', 'uno:GND.1', 'black', []]] }));
  return dir;
}
function request(port: number, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; type: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = ''; res.on('data', (d) => { text += d; }); res.on('end', () => resolve({ status: res.statusCode!, text, type: String(res.headers['content-type']) }));
    });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
}
/** Open the event stream and collect messages until `want` of them have arrived. */
function events(port: number) {
  const msgs: any[] = []; let wake: (() => void) | null = null;
  const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith('data: ')) { msgs.push(JSON.parse(chunk.slice(6))); wake?.(); } }
    });
  });
  const until = async (pred: (m: any[]) => boolean) => {
    const deadline = Date.now() + 5000;
    while (!pred(msgs)) { if (Date.now() > deadline) throw new Error('timed out; got ' + msgs.map((m) => m.t).join(',')); await new Promise<void>((r) => { wake = r; setTimeout(r, 100); }); }
    return msgs;
  };
  return { msgs, until, close: () => req.destroy() };
}

test('serves the page, streams the project, applies edits, and runs', async () => {
  const srv = await startServer({ dir: folder(), port: 0, build: async () => ({ ok: true, log: '', hex }) });
  try {
    assert.equal(srv.host, '127.0.0.1');
    const page = await request(srv.port, 'GET', '/');
    assert.equal(page.status, 200); assert.match(page.type, /text\/html/); assert.match(page.text, /app\.js/);
    assert.equal((await request(srv.port, 'GET', '/app.js')).status, 200);
    assert.equal((await request(srv.port, 'GET', '/../package.json')).status, 404);

    const ev = events(srv.port);
    await ev.until((m) => m.some((x) => x.t === 'project'));
    assert.equal(ev.msgs.find((x) => x.t === 'project').project.parts.length, 2);

    assert.equal((await request(srv.port, 'POST', '/msg', { t: 'edit', op: 'addPart', args: ['buzzer', 1, 2] })).status, 204);
    await ev.until((m) => m.filter((x) => x.t === 'project').at(-1).project.parts.length === 3);

    await request(srv.port, 'POST', '/msg', { t: 'start' });
    await ev.until((m) => m.some((x) => x.t === 'serial' && /Ready/.test(x.text)));
    await ev.until((m) => m.filter((x) => x.t === 'status').at(-1).timeMs > 0);

    ev.close();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(srv.running(), false, 'the run stops when the last page disconnects');
  } finally { await srv.close(); }
});

test('refuses requests that did not come from this machine\'s own page', async () => {
  const srv = await startServer({ dir: folder(), port: 0, build: async () => ({ ok: true, log: '', hex }) });
  try {
    assert.equal((await request(srv.port, 'GET', '/', undefined, { host: 'evil.example' })).status, 403);
    assert.equal((await request(srv.port, 'POST', '/msg', { t: 'stop' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await request(srv.port, 'POST', '/msg', undefined, { 'content-type': 'application/json' })).status, 400);
  } finally { await srv.close(); }
});

test('the standalone app offers the same fix: with nothing installed, "fix" ends with the sketch running', { skip: process.platform === 'win32' }, async () => {
  const rig = await makeRig();
  const srv = await startServer({ dir: createProject(rig.dir, 'blink', 'blink'), port: 0, toolchain: chain(rig) });
  try {
    const ev = events(srv.port);
    await ev.until((m) => m.some((x) => x.t === 'project'));
    await request(srv.port, 'POST', '/msg', { t: 'start' });
    await ev.until((m) => m.some((x) => x.t === 'error'));
    assert.equal(ev.msgs.find((x) => x.t === 'error').fix, 'Download the Arduino compiler (about 80 MB, one time)');
    await request(srv.port, 'POST', '/msg', { t: 'fix' });
    await ev.until((m) => m.some((x) => x.t === 'setup' && x.state === 'done'));
    await ev.until((m) => m.filter((x) => x.t === 'status').at(-1).state === 'running');
    ev.close();
  } finally { await srv.close(); await rig.close(); }
});

test('run from the command line, the app keeps its downloaded compiler under .build in the repository', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'shibo-root-'));
  const where = { env: { PATH: '' }, home: path.join(root, 'no-home'), platform: 'linux' as const };
  assert.equal(standaloneToolchain(root, where).find(), null);
  const own = ownCompiler(path.join(root, '.build', 'compiler'), 'linux');
  mkdirSync(path.dirname(own.cli), { recursive: true }); writeFileSync(own.cli, '#!/bin/sh\n', { mode: 0o755 }); writeFileSync(path.join(root, '.build', 'compiler', 'ready'), '{}');
  assert.deepEqual([standaloneToolchain(root, where).find()?.origin, standaloneToolchain(root, where).find()?.cli], ['own', own.cli]);
});
