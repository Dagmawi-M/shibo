// Regression tests for the second batch of review findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fw, power } from './helpers/fw.ts';
import { rig } from './helpers/rig.ts';
import { buildSketch } from '../src/build.ts';
import { createBackend } from '../src/backends/index.ts';
import { Probe } from '../src/instruments/probe.ts';
import { schedule } from '../src/instruments/envscript.ts';
import type { Engine } from '../src/engine.ts';
import type { Circuit } from '../src/circuit.ts';

const MS = 1e6;
const bits = (v: number) => Array.from({ length: 8 }, (_, i) => (v >> i) & 1);

test('74HC595: two chips daisy-chained on hardware SPI each latch their own byte', async () => {
  const s = await fw(`
    #include <SPI.h>
    void setup() { pinMode(10, OUTPUT); SPI.begin();
      digitalWrite(10, LOW); SPI.transfer(0x3C); SPI.transfer(0xA5); digitalWrite(10, HIGH); }
    void loop() {}`,
  [{ id: 'a', type: '74hc595' }, { id: 'b', type: '74hc595' }],
  [...power('a'), ...power('b'), ['a:MR', 'u:5V'], ['a:OE', 'u:GND'], ['b:MR', 'u:5V'], ['b:OE', 'u:GND'],
    ['a:DS', 'u:11'], ['a:SHCP', 'u:13'], ['a:STCP', 'u:10'], ['a:Q7S', 'b:DS'], ['b:SHCP', 'u:13'], ['b:STCP', 'u:10']]);
  s.run(50);
  assert.deepEqual(s.out('a').values, bits(0xA5), 'first chip holds the last byte');
  assert.deepEqual(s.out('b').values, bits(0x3C), 'second chip holds the byte pushed through Q7S');
});

test('Mega: a pin wired high on A12 reads full scale with analogRead(A12)', async () => {
  const s = await fw(`
    void setup() { Serial.begin(115200); delay(5); Serial.println(analogRead(A12)); }
    void loop() {}`, [], [['u:A12', 'u:5V']], 'mega');
  s.run(100);
  assert.deepEqual(s.lines(), ['1023']);
});

test('Mega: the bandgap channel (MUX 0x1E) reads about 1.1 V', async () => {
  const s = await fw(`
    void setup() { Serial.begin(115200);
      ADCSRA |= _BV(ADEN); ADCSRB &= ~_BV(MUX5); ADMUX = _BV(REFS0) | 0x1E; delay(5);
      ADCSRA |= _BV(ADSC); while (ADCSRA & _BV(ADSC)); Serial.println(ADC); }
    void loop() {}`, [], [], 'mega');
  s.run(100);
  const v = Number(s.lines()[0]);
  assert.ok(Math.abs(v - 1.1 / 5 * 1023) < 5, `bandgap read ${v}`);
});

test('ATtiny85 soft serial: a single "0" at 9600 decodes as "0"', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-fw-'));
  writeFileSync(path.join(dir, 'fw.ino'), 'void setup() { Serial.begin(9600); Serial.print("0"); }\nvoid loop() {}');
  const built = await buildSketch(dir, 'attiny85');
  assert.ok(built.ok, built.log);
  const t = createBackend('attiny85', 't', built.hex!);
  let s = ''; t.onSerial((b) => { s += String.fromCharCode(b); });
  for (let ms = 10; ms <= 200; ms += 10) t.runUntil(ms * MS);
  assert.equal(s, '0');
});

test('two batteries in series are not a short, and the far + reads high', () => {
  const r = rig([{ id: 'b1', type: 'lipo' }, { id: 'b2', type: 'lipo' }, { id: 'led', type: 'led' }, { id: 'res', type: 'resistor' }],
    [['b2:-', 'u:GND'], ['b2:+', 'b1:-'], ['b1:+', 'res:1'], ['res:2', 'led:A'], ['led:C', 'u:GND']]);
  r.run(1);
  assert.deepEqual(r.circuit.contended(), [], 'no contended net');
  assert.equal(r.circuit.levelAt('b1:+'), 1);
});

test('probe: a pin toggling every microsecond for 2 s of simulated time records quickly with bounded memory', () => {
  let t = 0, lvl: 0 | 1 = 0; let settle = () => {};
  const engine = { time: () => t, get now() { return t; } } as unknown as Engine;
  const circuit = { levelAt: (n: string) => (n.endsWith(':1') ? lvl : 0), onSettle(cb: () => void) { settle = cb; } } as unknown as Circuit;
  const probe = new Probe(engine, circuit, { version: 1, parts: [{ id: 'bz', type: 'buzzer', x: 0, y: 0 }], wires: [], boards: [] });
  const start = Date.now();
  for (let i = 0; i < 2_000_000; i++) { t += 1000; lvl = lvl ? 0 : 1; settle(); }
  const wall = Date.now() - start;
  assert.ok(wall < 5000, `took ${wall} ms of wall time`);
  const e = probe.edges('bz');
  assert.ok(e.times.length <= 500_000 && e.times.length >= 400_000, `kept ${e.times.length} edges`);
  assert.equal(e.times[e.times.length - 1], t, 'the newest edge is kept');
});

test('envscript: a ramp resumed from a rewind keeps its own start value after the control was changed by hand', () => {
  const r = rig([{ id: 'ntc1', type: 'ntc-temperature-sensor' }], [...power('ntc1'), ['ntc1:OUT', 'u:A0']]);
  schedule(r.engine, r.circuit, [{ at: 20, part: 'ntc1', control: 'temperature', value: 60, over: 100 }], () => assert.fail('no step should fail'));
  const temp = () => r.circuit.controlValues().ntc1.temperature;
  r.run(10); const before = r.engine.snapshot();
  r.run(60); assert.equal(temp(), 39); const mid = r.engine.snapshot();
  // Another timeline: rewind to before the ramp and change the control by hand.
  r.engine.restore(before); r.control('ntc1', 'temperature', 45); r.run(60); assert.equal(temp(), 51);
  // Back to the first timeline, mid-ramp: the ramp carries on from 25.
  r.engine.restore(mid); assert.equal(temp(), 39);
  r.run(80); assert.equal(temp(), 46);
});
