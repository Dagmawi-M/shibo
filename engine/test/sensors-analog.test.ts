// Analog and comparator sensor modules, read by a real compiled sketch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fw, power } from './helpers/fw.ts';
import { rig } from './helpers/rig.ts';

const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
const counts = (v: number) => Math.round((v / 5) * 1023);

// Prints A0..A3 then pins 2..5, five times a second.
const PROBE = `
  void setup() { Serial.begin(115200); for (int p = 2; p <= 5; p++) pinMode(p, INPUT); }
  void loop() { for (int a = A0; a <= A3; a++) { Serial.print(analogRead(a)); Serial.print(' '); }
    for (int p = 2; p <= 5; p++) { Serial.print(digitalRead(p)); Serial.print(' '); } Serial.println(); delay(20); }`;
const last = (s: { lines(): string[] }) => s.lines().at(-1)!.trim().split(' ').map(Number);

test('LM35, TMP36, UV and capacitive soil sensors put the expected voltage on an analog pin', async () => {
  const s = await fw(PROBE, [{ id: 'lm', type: 'lm35' }, { id: 'tmp', type: 'tmp36' }, { id: 'uv', type: 'uv-sensor' }, { id: 'soil', type: 'soil-moisture-capacitive' }],
    [...power('lm'), ...power('tmp'), ...power('uv'), ...power('soil'), ['lm:OUT', 'u:A0'], ['tmp:OUT', 'u:A1'], ['uv:SIG', 'u:A2'], ['soil:AOUT', 'u:A3']]);
  s.run(100);
  let [a0, a1, a2, a3] = last(s);
  near(a0, counts(0.25), 1, 'LM35 25 °C'); near(a1, counts(0.75), 1, 'TMP36 25 °C'); near(a2, 0, 0, 'UV 0'); near(a3, counts(2.55), 1, 'soil dry');
  s.control('lm', 'temperature', 100); s.control('tmp', 'temperature', -10); s.control('uv', 'uv', 8); s.control('soil', 'moisture', 100);
  s.run(100); [a0, a1, a2, a3] = last(s);
  // A sketch converting the usual way gets the temperature back.
  near((a0 * 500) / 1024, 100, 0.6, 'LM35 100 °C'); near(((a1 * 5) / 1024 - 0.5) * 100, -10, 0.6, 'TMP36 -10 °C');
  near((a2 * 5) / 1023 / 0.1, 8, 0.1, 'UV index'); near(a3, counts(1.25), 1, 'soil wet');
});

test('rain, soil and line sensors: AO follows the slider, DO flips at the threshold knob', async () => {
  const s = await fw(PROBE, [{ id: 'rain', type: 'rain-sensor' }, { id: 'soil', type: 'soil-moisture' }, { id: 'line', type: 'line-sensor' }],
    [...power('rain'), ...power('soil'), ...power('line'), ['rain:AO', 'u:A0'], ['soil:AO', 'u:A1'], ['line:AO', 'u:A2'], ['rain:DO', 'u:2'], ['soil:DO', 'u:3'], ['line:DO', 'u:4']]);
  s.run(100);
  let v = last(s);
  assert.ok(v[0] > 1000 && v[1] > 1000, 'dry plates read near the top');
  assert.ok(v[2] < 100, 'white surface reflects, AO low');
  assert.deepEqual(v.slice(4, 7), [1, 1, 0], 'dry: DO high; white surface: DO low');
  s.control('rain', 'wet', 90); s.control('soil', 'moisture', 80); s.control('line', 'reflect', 0);
  s.run(100); v = last(s);
  assert.ok(v[0] < 450 && v[1] < 500, `wet plates read low: ${v}`);
  assert.ok(v[2] > 950, 'black line: AO high');
  assert.deepEqual(v.slice(4, 7), [0, 0, 1], 'wet: DO low; black line: DO high');
  // Turning the rain sensor's knob right down means it takes a lot more water to trip.
  s.control('rain', 'threshold', 10); s.run(100); assert.equal(last(s)[4], 1);
});

test('MQ-135: clean air reads low, CO2 raises AOUT, DOUT drops past the knob', () => {
  const r = rig([{ id: 'g', type: 'mq135' }], [...power('g'), ['g:AOUT', 'u:A0'], ['g:DOUT', 'u:2']]);
  r.run(1);
  near(r.analog.A0, 0.846, 0.02, 'about 0.85 V at 400 ppm');
  assert.equal(r.inputs['2'], 1);
  // A sketch using the MQ135 library's formula gets the ppm back.
  const ppm = (volts: number) => { const rs = ((5 - volts) / volts) * 10; return 116.6020682 * Math.pow(rs / 76.63, -2.769034857); };
  near(ppm(r.analog.A0), 400, 1);
  r.control('g', 'ppm', 5000); r.run(2);
  near(ppm(r.analog.A0), 5000, 10);
  assert.equal(r.inputs['2'], 0);
});

test('water level, FSR, flex, Hall and voltage sensors', () => {
  const r = rig([{ id: 'w', type: 'water-level' }, { id: 'f', type: 'force-sensor' }, { id: 'x', type: 'flex-sensor' }, { id: 'h', type: 'hall-analog' }, { id: 'v', type: 'voltage-sensor' }, { id: 'k', type: 'hall-sensor' }],
    [...power('w'), ...power('f'), ...power('x'), ...power('h'), ['v:-', 'u:GND'], ...power('k'),
      ['w:SIG', 'u:A0'], ['f:SIG', 'u:A1'], ['x:SIG', 'u:A2'], ['h:SIG', 'u:A3'], ['v:S', 'u:A4'], ['k:S', 'u:2']]);
  r.run(1);
  assert.equal(r.analog.A0, 0, 'dry strip'); assert.equal(r.analog.A1, 0, 'no force');
  near(r.analog.A2, (5 * 47) / 72, 0.01, 'flat flex sensor: 25 k over 47 k'); near(r.analog.A3, 2.5, 0.001, 'no field: half supply');
  assert.equal(r.analog.A4, 0); assert.equal(r.inputs['2'], 1);
  r.control('w', 'depth', 40); r.control('f', 'force', 100); r.control('x', 'bend', 90); r.control('h', 'field', -50); r.control('v', 'volts', 12); r.control('k', 'field', 40);
  r.run(2);
  near(r.analog.A0, 3.4, 0.01); near(r.analog.A1, 5 * 10 / 16, 0.01, '6 k over 10 k at 100 g');
  near(r.analog.A2, (5 * 47) / 147, 0.01, '100 k at 90 degrees'); near(r.analog.A3, 1.8, 0.001, 'north pole: below half');
  near(r.analog.A4, 2.4, 0.001, 'a fifth of 12 V'); assert.equal(r.inputs['2'], 0, 'KY-003 pulls low near a south pole');
});

test('IR obstacle sensor goes low inside its range; reed and tilt-ball switches are contacts', () => {
  const r = rig([{ id: 'o', type: 'ir-obstacle' }, { id: 'reed', type: 'reed-switch' }, { id: 'tb', type: 'tilt-ball-switch' }],
    [...power('o'), ['o:OUT', 'u:2'], ['reed:1', 'u:3'], ['reed:2', 'u:GND'], ['tb:1', 'u:4'], ['tb:2', 'u:GND']]);
  r.set('3', 'pullup'); r.set('4', 'pullup'); r.run(1);
  assert.deepEqual([r.inputs['2'], r.inputs['3'], r.inputs['4']], [1, 1, 0], 'nothing near, no magnet, upright');
  r.control('o', 'distance', 8); r.control('reed', 'magnet', 1); r.control('tb', 'tilted', 1); r.run(2);
  assert.deepEqual([r.inputs['2'], r.inputs['3'], r.inputs['4']], [0, 0, 1]);
  r.control('o', 'reach', 5); r.run(3); assert.equal(r.inputs['2'], 1, 'knob turned down: 8 cm is out of range');
});

test('an unpowered module puts nothing on its pins', () => {
  const r = rig([{ id: 't', type: 'tmp36' }], [['t:OUT', 'u:A0']]);
  r.run(1); assert.equal(r.analog.A0, undefined);
});
