// Indicators, inputs and simple sensors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers/rig.ts';
import { library } from '../src/parts/index.ts';
import { catalog } from '../src/edit.ts';
import { validate, canonicalPin } from '../src/project.ts';

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('every library part is in the catalog with a drawing and a label', () => {
  for (const type of Object.keys(library)) {
    const c = catalog.find((x) => x.type === type);
    assert.ok(c, type); assert.match(c!.tag, /^wokwi-/); assert.ok(c!.label.length > 1); assert.ok(c!.group);
  }
  assert.ok(catalog.some((c) => c.type === 'nano' && c.board));
});

test('LED: dimmed by PWM, the page is told how bright', () => {
  const r = rig([{ id: 'd', type: 'led' }], [['u:9', 'd:A'], ['d:C', 'u:GND']]);
  for (let t = 0; t < 40; t++) { r.at(t * 1e6, '9', 1); r.at(t * 1e6 + 250_000, '9', 0); }   // 25 % duty at 1 kHz
  r.run(20); r.show('d');
  r.run(40);
  near(r.show('d').brightness as number, 0.25, 0.03);
  assert.equal(r.show('d').lit, true);
  r.run(80); r.show('d'); r.run(120);
  assert.equal(r.show('d').lit, false);
});

test('RGB LED: common cathode by default, common anode by setting', () => {
  const k = rig([{ id: 'l', type: 'rgb-led' }], [['u:3', 'l:R'], ['u:5', 'l:G'], ['u:6', 'l:B'], ['l:COM', 'u:GND']]);
  k.set('3', 1); k.set('5', 0); k.set('6', 1);
  assert.deepEqual(k.out('l'), { r: true, g: false, b: true });
  const a = rig([{ id: 'l', type: 'rgb-led', attrs: { common: 'anode' } }], [['u:3', 'l:R'], ['u:5', 'l:G'], ['u:6', 'l:B'], ['l:COM', 'u:5V']]);
  a.set('3', 1); a.set('5', 0); a.set('6', 1);
  assert.deepEqual(a.out('l'), { r: false, g: true, b: false });
});

test('LED bar graph: ten independent LEDs', () => {
  const r = rig([{ id: 'g', type: 'led-bar-graph' }], [['u:2', 'g:A1'], ['g:C1', 'u:GND'], ['u:3', 'g:A10'], ['g:C10', 'u:GND'], ['u:4', 'g:A5']]);
  r.set('2', 1); r.set('3', 1); r.set('4', 1);
  assert.deepEqual(r.out('g').values, [1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test('7-segment: one digit, common anode lights a segment pulled low', () => {
  const r = rig([{ id: 's', type: '7segment' }], [['s:COM.1', 'u:5V'], ['u:2', 's:A'], ['u:3', 's:B'], ['u:4', 's:DP']]);
  r.set('2', 0); r.set('3', 1); r.set('4', 0);
  assert.deepEqual(r.out('s').values, [1, 0, 0, 0, 0, 0, 0, 1]);
});

test('7-segment: multiplexed digits both show on the page', () => {
  const r = rig([{ id: 's', type: '7segment', attrs: { digits: '2', common: 'cathode' } }], [['u:2', 's:A'], ['u:3', 's:B'], ['u:10', 's:DIG1'], ['u:11', 's:DIG2']]);
  for (let i = 0; i < 10; i++) {          // digit 1 shows A, digit 2 shows B, 2 ms each
    const t = i * 4e6;
    r.at(t, '11', 1); r.at(t, '2', 1); r.at(t, '3', 0); r.at(t, '10', 0);
    r.at(t + 2e6, '10', 1); r.at(t + 2e6, '2', 0); r.at(t + 2e6, '3', 1); r.at(t + 2e6, '11', 0);
  }
  r.run(38);
  const v = r.show('s').values as number[];
  assert.deepEqual([v[0], v[1], v[8], v[9]], [1, 0, 0, 1]);
});

test('buttons, DIP switch and keypad close the right contacts', () => {
  const r = rig([{ id: 'b', type: 'pushbutton-6mm' }, { id: 'sw', type: 'dip-switch-8' }, { id: 'k', type: 'membrane-keypad' }],
    [['u:2', 'b:1.l'], ['b:2.r', 'u:GND'], ['u:3', 'sw:3a'], ['sw:3b', 'u:GND'], ['u:4', 'k:R2'], ['k:C3', 'u:GND']]);
  for (const p of ['2', '3', '4']) r.set(p, 'pullup');
  assert.deepEqual([r.inputs['2'], r.inputs['3'], r.inputs['4']], [1, 1, 1]);
  r.control('b', 'pressed', 1); r.control('sw', 'sw3', 1); r.control('k', 'key', 7);   // row 2, column 3 on a 4x4 pad
  assert.deepEqual([r.inputs['2'], r.inputs['3'], r.inputs['4']], [0, 0, 0]);
  r.control('k', 'key', 6);
  assert.equal(r.inputs['4'], 1);
  assert.throws(() => r.control('sw', 'sw9', 1), /sw9/);
});

test('relay switches its contacts when the coil is driven', () => {
  const r = rig([{ id: 'k', type: 'ks2e-m-dc5' }], [['u:7', 'k:COIL1'], ['k:COIL2', 'u:GND'], ['u:5V', 'k:P1'], ['k:NO1', 'u:8'], ['k:NC1', 'u:9']]);
  r.set('7', 0);
  assert.deepEqual([r.inputs['8'], r.inputs['9']], [null, 1]);
  r.set('7', 1);
  assert.deepEqual([r.inputs['8'], r.inputs['9']], [1, null]);
  assert.equal(r.out('k').on, true);
});

test('joystick and slide potentiometer give voltages; the joystick button pulls SEL low', () => {
  const r = rig([{ id: 'j', type: 'analog-joystick' }, { id: 'p', type: 'slide-potentiometer' }],
    [['j:VCC', 'u:5V'], ['j:GND', 'u:GND'], ['j:HORZ', 'u:A0'], ['j:VERT', 'u:A1'], ['j:SEL', 'u:2'], ['p:VCC', 'u:5V'], ['p:GND', 'u:GND'], ['p:SIG', 'u:A2']]);
  r.set('2', 'pullup');
  near(r.analog.A0, 2.5, 0.01); near(r.analog.A1, 2.5, 0.01);
  r.control('j', 'x', 1); r.control('j', 'y', -1); r.control('j', 'pressed', 1); r.control('p', 'value', 1023);
  near(r.analog.A0, 5, 0.01); near(r.analog.A1, 0, 0.01); near(r.analog.A2, 5, 0.01);
  assert.equal(r.inputs['2'], 0);
});

test('rotary encoder: a clockwise click has CLK fall while DT is still high, and the other way round', () => {
  const r = rig([{ id: 'e', type: 'ky-040' }], [['e:CLK', 'u:2'], ['e:DT', 'u:3'], ['e:SW', 'u:4'], ['e:VCC', 'u:5V'], ['e:GND', 'u:GND']]);
  r.run(1);
  assert.deepEqual([r.inputs['2'], r.inputs['3'], r.inputs['4']], [1, 1, 1]);
  r.control('e', 'position', 1); r.run(20);
  const clkFall = r.edgesOf('2').find(([l]) => l === 0)![1], dtFall = r.edgesOf('3').find(([l]) => l === 0)![1];
  assert.ok(clkFall < dtFall, 'clockwise');
  assert.deepEqual([r.inputs['2'], r.inputs['3']], [1, 1]);
  const mark = r.edges.length;
  r.control('e', 'position', 0); r.run(40);
  const later = r.edges.slice(mark);
  assert.ok(later.find(([p, l]) => p === '3' && l === 0)![2] < later.find(([p, l]) => p === '2' && l === 0)![2], 'counter-clockwise');
  r.control('e', 'pressed', 1);
  assert.equal(r.inputs['4'], 0);
});

test('analog sensors follow their control, and only when powered', () => {
  const r = rig([{ id: 't', type: 'ntc-temperature-sensor' }, { id: 'l', type: 'photoresistor-sensor' }, { id: 'off', type: 'ntc-temperature-sensor' }],
    [['t:VCC', 'u:5V'], ['t:GND', 'u:GND'], ['t:OUT', 'u:A0'], ['l:VCC', 'u:5V'], ['l:GND', 'u:GND'], ['l:AO', 'u:A1'], ['l:DO', 'u:2'], ['off:OUT', 'u:A2']]);
  near(r.analog.A0, 2.5, 0.05);                       // 25 C: the thermistor equals its 10k partner
  r.control('t', 'temperature', 60);
  const a = Math.round(r.analog.A0 / 5 * 1023);
  near(1 / (Math.log(1 / (1023 / a - 1)) / 3950 + 1 / 298.15) - 273.15, 60, 0.5);   // the usual sketch formula recovers it
  r.control('l', 'lux', 10000); const bright = r.analog.A1; assert.equal(r.inputs['2'], 0);
  r.control('l', 'lux', 1); assert.ok(r.analog.A1 > bright + 2); assert.equal(r.inputs['2'], 1);
  assert.equal(r.analog.A2 ?? 0, 0);
  assert.equal(r.out('off').powered, false);
  assert.equal(r.out('t').powered, true);
});

test('digital sensors: motion, tilt, flame, gas, sound and heartbeat', () => {
  const r = rig([{ id: 'm', type: 'pir-motion-sensor' }, { id: 'ti', type: 'tilt-switch' }, { id: 'f', type: 'flame-sensor' }, { id: 'g', type: 'gas-sensor' }, { id: 's', type: 'big-sound-sensor' }, { id: 'h', type: 'heart-beat-sensor' }],
    [...['m', 'ti', 'f', 'g', 's', 'h'].flatMap((id) => [[`${id}:VCC`, 'u:5V'], [`${id}:GND`, 'u:GND']] as [string, string][]),
      ['m:OUT', 'u:2'], ['ti:OUT', 'u:3'], ['f:DOUT', 'u:4'], ['g:AOUT', 'u:A0'], ['s:DOUT', 'u:5'], ['s:AOUT', 'u:A1'], ['h:OUT', 'u:6']]);
  assert.deepEqual([r.inputs['2'], r.inputs['3'], r.inputs['4'], r.inputs['5']], [0, 0, 1, 0]);
  r.control('m', 'motion', 1); r.control('ti', 'tilted', 1); r.control('f', 'flame', 1); r.control('s', 'level', 900); r.control('g', 'ppm', 5000);
  assert.deepEqual([r.inputs['2'], r.inputs['3'], r.inputs['4'], r.inputs['5']], [1, 1, 0, 1]);
  near(r.analog.A1, 900 / 1023 * 5, 0.01); assert.ok(r.analog.A0 > 2);
  r.control('h', 'bpm', 120); r.run(2100);
  const beats = r.edgesOf('6').filter(([l]) => l === 1).length;
  assert.ok(beats >= 3 && beats <= 5, `${beats} beats in 2.1 s at 120 bpm`);
});

test('the Nano is a board with its extra analog pins', () => {
  assert.equal(canonicalPin('nano', 'A7'), 'A7');
  assert.equal(canonicalPin('nano', '12.2'), '12');
  assert.deepEqual(validate({ version: 1, parts: [{ id: 'n', type: 'nano', x: 0, y: 0 }, { id: 'd', type: 'led', x: 0, y: 0 }], wires: [{ from: 'n:13', to: 'd:A' }, { from: 'd:C', to: 'n:GND.1' }], boards: [{ part: 'n', firmware: '' }] }), []);
});
