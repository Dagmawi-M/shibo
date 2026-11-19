import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UnoBackend } from '../src/backends/avr.ts';

const hex = (n: string) => readFileSync(new URL(`./fixtures/${n}.hex`, import.meta.url), 'utf8');
const MS = 1e6;
const pin = (u: UnoBackend, p: string) => u.drives().find((d) => d.pin === p);

/** Run in 1 ms steps, returning the times (ms) at which pin 13's level changes. */
function changes(u: UnoBackend, fromMs: number, toMs: number): number[] {
  const out: number[] = []; let last = pin(u, '13')?.level ?? null;
  for (let t = fromMs + 1; t <= toMs; t++) {
    u.runUntil(t * MS);
    const l = pin(u, '13')?.level ?? null;
    if (l !== last) { out.push(t); last = l; }
  }
  return out;
}

test('blink toggles pin 13 once a second', () => {
  const u = new UnoBackend('uno', hex('blink'));
  const c = changes(u, 0, 3000);
  assert.equal(c.length, 3);
  [0, 1000, 2000].forEach((want, i) => assert.ok(Math.abs(c[i] - want) <= 5, `change ${i} at ${c[i]} ms`));
});

test('power pins are driven and a pull-up input is reported', () => {
  const u = new UnoBackend('uno', hex('echo'));
  u.runUntil(50 * MS);
  assert.equal(pin(u, '5V')!.level, 1);
  assert.equal(pin(u, 'GND')!.level, 0);
  assert.deepEqual(pin(u, '2'), { pin: '2', level: null, pull: 'up' });
});

test('echo returns serial bytes', () => {
  const u = new UnoBackend('uno', hex('echo'));
  const got: [number, number][] = []; let now = 0;
  u.onSerial((b) => got.push([b, now]));
  for (now = 1; now <= 100; now++) u.runUntil(now * MS);
  u.serialWrite(65);
  for (now = 101; now <= 200; now++) u.runUntil(now * MS);
  assert.equal(got.length, 1);
  assert.equal(got[0][0], 65);
  assert.ok(got[0][1] < 200);
});

test('restore replays identically', () => {
  const u = new UnoBackend('uno', hex('blink'));
  u.runUntil(500 * MS);
  const snap = u.saveState();
  const first = changes(u, 500, 2500);
  u.restoreState(snap);
  const second = changes(u, 500, 2500);
  assert.deepEqual(second, first);
  assert.equal(first.length, 2);
});

test('a snapshot survives later runs unchanged', () => {
  const u = new UnoBackend('uno', hex('blink'));
  u.runUntil(500 * MS);
  const snap = u.saveState();
  changes(u, 500, 2500);
  u.restoreState(snap); const a = changes(u, 500, 1500);
  u.restoreState(snap); const b = changes(u, 500, 1500);
  assert.deepEqual(a, b);
  assert.equal(a.length, 1);
});
