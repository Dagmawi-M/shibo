// A button clicked very quickly (pressed and let go before the simulation has
// moved on at all) must still be seen by the sketch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session, type OutMsg } from '../src/session.ts';

const hex = readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'toggle.hex'), 'utf8');
const project = {
  version: 1,
  parts: [{ id: 'uno', type: 'uno', x: 0, y: 0 }, { id: 'btn1', type: 'pushbutton', x: 260, y: -100 }],
  wires: [{ from: 'btn1:1.l', to: 'uno:2' }, { from: 'btn1:2.r', to: 'uno:GND.2' }],
  boards: [{ part: 'uno', firmware: '' }],
};

const running = async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-press-'));
  writeFileSync(path.join(dir, 'shibo.json'), JSON.stringify(project)); writeFileSync(path.join(dir, 'sketch.ino'), '// toggle\n');
  const s = new Session({ build: async () => ({ ok: true, log: '', hex }), ngspice: '/nonexistent/ngspice' }); const out: OutMsg[] = [];
  s.onMessage((m) => out.push(m));
  await s.handle({ t: 'open', dir }); await s.handle({ t: 'start' });
  const serial = () => out.filter((m) => m.t === 'serial').map((m: any) => m.text).join('');
  const ticks = (n: number) => { for (let i = 0; i < n; i++) s.tick(16); };
  ticks(30); assert.match(serial(), /Ready/);
  return { s, serial, ticks, press: (value: number) => s.handle({ t: 'control', part: 'btn1', name: 'pressed', value }) };
};

test('a press and release with no time between them still reaches the sketch', async () => {
  const r = await running();
  try {
  await r.press(1); await r.press(0);                 // a click faster than one step of the simulation
  r.ticks(30);
  assert.match(r.serial(), /LED ON/);
  assert.ok(!/LED OFF/.test(r.serial()), 'one click is one press, and it ends');
  } finally { r.s.dispose(); }
});

test('a quick double click is two presses, and the button is up afterwards', async () => {
  const r = await running();
  try {
  await r.press(1); await r.press(0); r.ticks(40);     // the sketch waits 250 ms after each press
  await r.press(1); await r.press(0); r.ticks(40);
  assert.deepEqual(r.serial().match(/LED O\w+/g), ['LED ON', 'LED OFF']);
  r.ticks(60);
  assert.deepEqual(r.serial().match(/LED O\w+/g), ['LED ON', 'LED OFF'], 'nothing more: the button was let go');
  } finally { r.s.dispose(); }
});

test('a knob being turned ends on the last value it was given', async () => {
  const r = await running();
  try {
  for (const v of [1, 0, 1, 0, 1]) await r.press(v);   // many changes in one instant: the last one stands
  r.ticks(30);
  assert.match(r.serial(), /LED ON/);
  r.ticks(60);
  assert.ok((r.serial().match(/LED O\w+/g) ?? []).length >= 3, 'it stayed pressed, so the sketch kept toggling');
  } finally { r.s.dispose(); }
});
