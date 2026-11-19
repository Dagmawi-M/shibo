import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session, type OutMsg } from '../src/session.ts';

const hex = readFileSync(new URL('./fixtures/toggle.hex', import.meta.url), 'utf8');
const DIAGRAM = {
  version: 1, parts: [
    { type: 'wokwi-arduino-uno', id: 'uno', top: 0, left: 0 },
    { type: 'wokwi-led', id: 'led1', top: -90, left: 120 },
    { type: 'wokwi-resistor', id: 'r1', top: -40, left: 160 },
    { type: 'wokwi-pushbutton', id: 'btn1', top: -100, left: 260 },
  ],
  connections: [['uno:13', 'r1:2', 'green', []], ['r1:1', 'led1:A', 'green', []], ['led1:C', 'uno:GND.1', 'black', []], ['btn1:1.l', 'uno:2', 'blue', []], ['btn1:2.r', 'uno:GND.2', 'black', []]],
};
function folder(withDiagram = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-s-'));
  if (withDiagram) writeFileSync(path.join(dir, 'diagram.json'), JSON.stringify(DIAGRAM));
  return dir;
}
function session(build = async () => ({ ok: true, log: '', hex })) {
  const s = new Session({ build }); const out: OutMsg[] = [];
  s.onMessage((m) => out.push(m));
  const last = <T extends OutMsg['t']>(t: T) => out.filter((m) => m.t === t).at(-1) as Extract<OutMsg, { t: T }> | undefined;
  return { s, out, last };
}
const ticks = (s: Session, n: number) => { for (let i = 0; i < n; i++) s.tick(50); };

test('opening a Wokwi folder gives the project and the catalog', async () => {
  const { s, last } = session();
  await s.handle({ t: 'open', dir: folder() });
  const p = last('project')!;
  assert.equal(p.project.parts.length, 4);
  assert.equal(p.dirty, false);
  assert.ok(p.catalog.length >= 7);
  assert.deepEqual(last('problems')!.items, []);
  assert.equal(last('status')!.state, 'idle');
});

test('an empty folder opens as an empty circuit', async () => {
  const { s, last, out } = session();
  await s.handle({ t: 'open', dir: folder(false) });
  assert.equal(last('project')!.project.parts.length, 0);
  assert.equal(out.filter((m) => m.t === 'error').length, 0);
});

test('running: a button press lights the LED and reports on serial', async () => {
  const { s, out, last } = session();
  await s.handle({ t: 'open', dir: folder() });
  await s.handle({ t: 'start' });
  assert.equal(last('status')!.state, 'running');
  ticks(s, 6);
  await s.handle({ t: 'control', part: 'btn1', name: 'pressed', value: 1 });
  ticks(s, 2);
  await s.handle({ t: 'control', part: 'btn1', name: 'pressed', value: 0 });
  ticks(s, 2);
  assert.equal(last('outputs')!.outputs.led1.lit, true);
  const serial = out.filter((m) => m.t === 'serial').map((m) => (m as any).text).join('');
  assert.match(serial, /Ready\r?\nLED ON/);
  assert.ok(last('status')!.timeMs >= 400);   // status is sent every 200 ms of simulated time
  s.dispose();
});

test('a tick never advances more than 50 ms, however long the host stalled', async () => {
  const { s, last } = session();
  await s.handle({ t: 'open', dir: folder() });
  await s.handle({ t: 'start' });
  s.tick(60_000);
  await s.handle({ t: 'stop' });
  assert.equal(last('status')!.state, 'idle');
  assert.ok(last('status')!.timeMs <= 50);
});

test('an edit while running stops the run before the project changes', async () => {
  const { s, out } = session();
  await s.handle({ t: 'open', dir: folder() });
  await s.handle({ t: 'start' }); ticks(s, 2);
  const mark = out.length;
  await s.handle({ t: 'edit', op: 'addPart', args: ['led', 5, 5] });
  const after = out.slice(mark).map((m) => m.t === 'status' ? `status:${m.state}` : m.t);
  assert.ok(after.indexOf('status:idle') >= 0 && after.indexOf('status:idle') < after.indexOf('project'), after.join(','));
  const before = out.length; ticks(s, 3);
  assert.equal(out.length, before);
});

test('a bad edit reports an error and leaves the project unchanged', async () => {
  const { s, last, out } = session();
  await s.handle({ t: 'open', dir: folder() });
  const n = out.filter((m) => m.t === 'project').length;
  await s.handle({ t: 'edit', op: 'addWire', args: ['uno:13', 'uno:13'] });
  assert.match(last('error')!.message, /same pin/);
  assert.equal(out.filter((m) => m.t === 'project').length, n);
  await s.handle({ t: 'edit', op: 'formatDisk', args: [] });
  assert.match(last('error')!.message, /formatDisk/);
});

test('save writes shibo.json only, and reopening reads it back', async () => {
  const dir = folder(); const { s, last } = session();
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'edit', op: 'addPart', args: ['buzzer', 7, 9] });
  assert.equal(last('project')!.dirty, true);
  assert.equal(existsSync(path.join(dir, 'shibo.json')), false);
  const diagramBefore = readFileSync(path.join(dir, 'diagram.json'), 'utf8');
  await s.handle({ t: 'save' });
  assert.equal(last('dirty')!.dirty, false);
  assert.equal(readFileSync(path.join(dir, 'diagram.json'), 'utf8'), diagramBefore);
  const again = session();
  await again.s.handle({ t: 'open', dir });
  assert.equal(again.last('project')!.project.parts.length, 5);
});

test('start is refused with a reason when there is no board or the build fails', async () => {
  const a = session();
  await a.s.handle({ t: 'open', dir: folder(false) });
  await a.s.handle({ t: 'start' });
  assert.match(a.last('error')!.message, /board/);
  const b = session(async () => ({ ok: false, log: 'sketch.ino:3: error: nope' }));
  await b.s.handle({ t: 'open', dir: folder() });
  await b.s.handle({ t: 'start' });
  assert.match(b.last('error')!.message, /error: nope/);
  assert.equal(b.last('status')!.state, 'idle');
});

test('a short is listed as a problem while running', async () => {
  const dir = folder(); const { s, last } = session();
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'edit', op: 'addWire', args: ['uno:5V', 'uno:GND.3'] });
  await s.handle({ t: 'start' }); ticks(s, 1);
  assert.ok(last('problems')!.items.some((x) => /short/i.test(x)), JSON.stringify(last('problems')));
  s.dispose();
});

test('dispose stops the run', async () => {
  const { s, out } = session();
  await s.handle({ t: 'open', dir: folder() });
  await s.handle({ t: 'start' });
  s.dispose();
  const n = out.length; ticks(s, 3);
  assert.equal(out.length, n);
});

test('hello resends everything a newly opened page needs', async () => {
  const { s, out } = session();
  await s.handle({ t: 'open', dir: folder() });
  const mark = out.length;
  await s.handle({ t: 'hello' });
  assert.deepEqual(out.slice(mark).map((m) => m.t), ['project', 'problems', 'status']);
});
