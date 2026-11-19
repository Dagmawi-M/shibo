import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import type { ChipBackend } from '../src/types.ts';

function fake(id = 'f') {
  const calls: number[] = [];
  let t = 0;
  const b: ChipBackend = {
    id,
    runUntil(x) { calls.push(x); t = x; },
    drives: () => [], setInput() {}, setAnalog() {}, onChange() {}, onSerial() {}, serialWrite() {},
    saveState: () => t, restoreState(s) { t = s as number; },
  };
  return { b, calls, time: () => t };
}

test('advances backends in quanta', () => {
  const e = new Engine({ quantumNs: 100_000 }); const f = fake(); e.addBackend(f.b);
  e.runUntil(350_000);
  assert.deepEqual(f.calls, [100000, 200000, 300000, 350000]);
  assert.equal(e.now, 350000);
});

test('scheduled events fire at their time, in order', () => {
  const e = new Engine({ quantumNs: 100_000 }); const f = fake(); e.addBackend(f.b);
  const seen: [string, number, number][] = [];
  e.at(250_000, () => seen.push(['b', e.now, f.time()]));
  e.at(120_000, () => seen.push(['a', e.now, f.time()]));
  e.runUntil(300_000);
  assert.deepEqual(seen, [['a', 120000, 120000], ['b', 250000, 250000]]);
});

test('rejects an event in the past', () => {
  const e = new Engine(); e.runUntil(500);
  assert.throws(() => e.at(100, () => {}), /100/);
});

test('snapshot then restore replays identically', () => {
  const e = new Engine({ quantumNs: 100_000 }); const f = fake(); e.addBackend(f.b);
  for (const t of [50_000, 150_000, 250_000, 350_000]) e.at(t, () => e.record(`tick backend=${f.time()}`));
  e.runUntil(200_000);
  const snap = e.snapshot();
  e.runUntil(400_000);
  const first = [...e.log];
  e.restore(snap);
  assert.equal(e.now, 200000);
  assert.equal(e.log.length, 2);
  e.runUntil(400_000);
  assert.deepEqual(e.log, first);
  assert.equal(e.log.length, 4);
  assert.equal(e.now, 400000);
});
