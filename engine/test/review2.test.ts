// Regression tests for the findings of the stage 1c review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session, type OutMsg } from '../src/session.ts';
import { parseProject, importWokwi } from '../src/project.ts';
import { addPart, pruneWires } from '../src/edit.ts';
import { startServer } from '../../server/standalone.ts';

const hex = readFileSync(new URL('./fixtures/toggle.hex', import.meta.url), 'utf8');
const UNO = { type: 'wokwi-arduino-uno', id: 'uno', top: 0, left: 0 };
const LED = { type: 'wokwi-led', id: 'led1', top: -90, left: 120 };
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-r-'));
  for (const [n, c] of Object.entries(files)) writeFileSync(path.join(dir, n), c);
  return dir;
}
const diagram = (parts: any[], connections: any[] = []) => JSON.stringify({ version: 1, parts, connections });
function session(build: any = async () => ({ ok: true, log: '', hex })) {
  const s = new Session({ build }); const out: OutMsg[] = [];
  s.onMessage((m) => out.push(m));
  const last = <T extends OutMsg['t']>(t: T) => out.filter((m) => m.t === t).at(-1) as Extract<OutMsg, { t: T }> | undefined;
  return { s, out, last };
}
const good = () => ({ version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'd', type: 'led', x: 5, y: 5, attrs: { color: 'blue' } }], wires: [{ from: 'u:13', to: 'd:A', color: 'green' }], boards: [{ part: 'u', firmware: '' }] });

test('a project keeps only attributes its part type is known to take', () => {
  const raw = good();
  (raw.parts[1] as any).attrs = { color: 'blue', onfocus: 'alert(1)', onpointerdown: 'x()', id: 'problems', style: 'display:none', tabindex: '0', autofocus: '' };
  assert.deepEqual(parseProject(raw, 'test').parts[1].attrs, { color: 'blue' });
  (raw.parts[1] as any).attrs = { color: 'red" onmouseover="x' };
  assert.equal(parseProject(raw, 'test').parts[1].attrs, undefined);
  const imported = importWokwi({ parts: [UNO, { ...LED, attrs: { color: 'red', onfocus: 'x', id: 'problems' } }], connections: [] });
  assert.deepEqual(imported.project.parts[1].attrs, { color: 'red' });
});

test('a malformed project file is refused with a message that names the trouble', () => {
  const cases: [any, RegExp][] = [
    [{ version: 1, parts: [null], wires: [], boards: [] }, /part 1/],
    [{ version: 1, parts: [{ id: 'a:b', type: 'led', x: 0, y: 0 }], wires: [], boards: [] }, /a:b/],
    [{ version: 1, parts: [{ id: 'a', type: 'led', x: 'no', y: 0 }], wires: [], boards: [] }, /position/],
    [{ version: 1, parts: [{ id: 'a', type: 'led', x: 0, y: 0 }, { id: 'a', type: 'led', x: 0, y: 0 }], wires: [], boards: [] }, /twice/],
    [{ version: 1, parts: [], wires: [null], boards: [] }, /wire 1/],
    [{ version: 1, parts: [], wires: [{ from: 3, to: 'a:1' }], boards: [] }, /wire 1/],
    [{ version: 2, parts: [], wires: [], boards: [] }, /version/],
    ['nope', /project/],
  ];
  for (const [raw, re] of cases) assert.throws(() => parseProject(raw, 'file.json'), re, JSON.stringify(raw));
  assert.throws(() => importWokwi({ parts: [{ type: 'wokwi-led', id: 'a:b' }], connections: [] }), /a:b/);
  assert.equal(parseProject(good(), 'x').parts.length, 2);
});

test('names borrowed from Object are not part types or edits', async () => {
  assert.throws(() => addPart({ version: 1, parts: [], wires: [], boards: [] }, 'constructor', 0, 0), /constructor/);
  assert.throws(() => addPart({ version: 1, parts: [], wires: [], boards: [] }, 'led', 'abc' as any, {} as any), /number/);
  const dir = folder({ 'diagram.json': diagram([UNO]) }); const { s, last, out } = session();
  await s.handle({ t: 'open', dir });
  const n = out.filter((m) => m.t === 'project').length;
  for (const op of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    await s.handle({ t: 'edit', op, args: [] });
    assert.match(last('error')!.message, /unknown edit/, op);
  }
  await s.handle({ t: 'edit', op: 'addPart', args: 'led' as any });
  assert.equal(out.filter((m) => m.t === 'project').length, n);
  assert.equal(last('project')!.project.parts.length, 1);
});

test('a project file that cannot be read is reported, stays reported, and is never overwritten', async () => {
  const dir = folder({ 'shibo.json': '{ not json' }); const { s, last } = session();
  await s.handle({ t: 'open', dir });
  assert.ok(last('problems')!.items.some((x) => /shibo\.json/.test(x)), JSON.stringify(last('problems')));
  await s.handle({ t: 'hello' });
  assert.ok(last('problems')!.items.some((x) => /shibo\.json/.test(x)));
  assert.equal(last('project')!.dir, dir);
  await s.handle({ t: 'edit', op: 'addPart', args: ['led', 0, 0] });
  assert.match(last('error')!.message, /shibo\.json/);
  await s.handle({ t: 'save' });
  assert.equal(readFileSync(path.join(dir, 'shibo.json'), 'utf8'), '{ not json');
});

test('a build that throws leaves the session stopped, with the reason', async () => {
  const { s, last } = session(async () => { throw new Error('EISDIR: illegal operation on a directory'); });
  await s.handle({ t: 'open', dir: folder({ 'diagram.json': diagram([UNO]) }) });
  await s.handle({ t: 'start' });
  assert.equal(last('status')!.state, 'idle');
  assert.match(last('error')!.message, /EISDIR/);
});

test('saving during a run does not redraw the circuit or stop the run', async () => {
  const dir = folder({ 'diagram.json': diagram([UNO]) }); const { s, out, last } = session();
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'edit', op: 'addPart', args: ['led', 0, 0] });
  await s.handle({ t: 'start' }); s.tick(50);
  const mark = out.length;
  await s.handle({ t: 'save' });
  const kinds = out.slice(mark).map((m) => m.t);
  assert.deepEqual(kinds, ['dirty']);
  assert.equal(last('dirty')!.dirty, false);
  assert.equal(existsSync(path.join(dir, 'shibo.json')), true);
  const n = out.length; s.tick(50); s.tick(50); s.tick(50); s.tick(50); s.tick(50);
  assert.ok(out.length > n, 'still running');
  s.dispose();
});

test('a second board is called out, since only one runs', async () => {
  const { s, last } = session();
  await s.handle({ t: 'open', dir: folder({ 'diagram.json': diagram([UNO, { ...UNO, id: 'uno2' }]) }) });
  assert.ok(last('problems')!.items.some((x) => /uno2/.test(x) && /only one board/i.test(x)), JSON.stringify(last('problems')));
});

test('stop during a build cancels the start', async () => {
  let release: (v: any) => void = () => {};
  const { s, last } = session(() => new Promise((r) => { release = r; }));
  await s.handle({ t: 'open', dir: folder({ 'diagram.json': diagram([UNO]) }) });
  const starting = s.handle({ t: 'start' });
  await s.handle({ t: 'stop' });
  release({ ok: true, log: '', hex }); await starting;
  assert.equal(last('status')!.state, 'idle');
});

test('serial input is capped', async () => {
  const { s, last } = session();
  await s.handle({ t: 'open', dir: folder({ 'diagram.json': diagram([UNO]) }) });
  await s.handle({ t: 'start' });
  await s.handle({ t: 'serial', text: 'x'.repeat(100_000) });
  assert.match(last('error')!.message, /too long/);
  await s.handle({ t: 'control', part: 'ghost', name: 'pressed', value: 1 });
  assert.match(last('error')!.message, /ghost/);
  s.dispose();
});

test('pruneWires removes wires that point at missing parts or pins', () => {
  const p = parseProject(good(), 'x');
  p.wires.push({ from: 'gone:1', to: 'd:A' }, { from: 'd:X', to: 'u:13' });
  const q = pruneWires(p);
  assert.deepEqual(q.wires, [{ from: 'u:13', to: 'd:A', color: 'green' }]);
  assert.equal(p.wires.length, 3);
});

// ---- standalone server ----
function request(port: number, method: string, url: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers })); });
    r.on('error', reject); r.end(body);
  });
}
test('server: odd paths, wrong content types and bad files do not bring it down', async () => {
  const dir = folder({ 'shibo.json': JSON.stringify({ version: 1, parts: [null], wires: [], boards: [] }) });
  const srv = await startServer({ dir, port: 0, build: async () => ({ ok: true, log: '', hex }) });
  try {
    for (const p of ['/..', '/.', '/%2e%2e', '/nope.js']) assert.equal((await request(srv.port, 'GET', p)).status, 404, p);
    assert.equal((await request(srv.port, 'POST', '/msg', '{"t":"stop"}', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await request(srv.port, 'POST', '/msg', '{"t":"stop"}', { 'content-type': 'application/json' })).status, 204);
    const page = await request(srv.port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
    assert.doesNotMatch(String(page.headers['content-security-policy']), /script-src[^;]*unsafe-inline/);
    const ev = http.get({ host: '127.0.0.1', port: srv.port, path: '/events' }); ev.on('error', () => {});
    await new Promise((r) => setTimeout(r, 150)); ev.destroy();
    assert.equal((await request(srv.port, 'GET', '/')).status, 200, 'still serving after a page connected to a bad project');
  } finally { await srv.close(); }
});

test('a running sensor with no power is listed as a problem, and dimmed LEDs report brightness', async () => {
  const dir = folder({ 'diagram.json': diagram([UNO, { type: 'wokwi-pir-motion-sensor', id: 'pir1', top: 0, left: 0 }, LED], [['pir1:OUT', 'uno:2', 'green', []], ['uno:13', 'led1:A', 'green', []], ['led1:C', 'uno:GND.1', 'black', []]]) });
  const { s, last } = session();
  await s.handle({ t: 'open', dir });
  assert.deepEqual(last('problems')!.items, []);
  await s.handle({ t: 'start' }); s.tick(20); s.tick(20);
  assert.ok(last('problems')!.items.some((x) => /pir1/.test(x) && /no power/.test(x)), JSON.stringify(last('problems')));
  assert.equal(typeof last('outputs')!.outputs.led1.brightness, 'number');
  s.dispose();
});
