// LEDs and light modules: colour and size variants, bi-colour and RGB, the
// traffic light, laser and IR LEDs, chained WS2812 strips, and the two
// display drivers that sketches talk to through real libraries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers/rig.ts';
import { fw, power } from './helpers/fw.ts';
import { catalog } from '../src/edit.ts';
import { library } from '../src/parts/index.ts';
import { generateSketch } from '../src/sketchgen.ts';

const COLOURS = ['red', 'green', 'blue', 'yellow', 'white', 'orange', 'pink', 'purple'];
const NEW = ['led-3mm', 'led-10mm', ...COLOURS.filter((c) => c !== 'red').map((c) => `led-${c}`), 'led-bicolor', 'rgb-led-anode', 'traffic-light', 'laser-module', 'ir-led', 'led-resistor', 'led-strip', 'max7219-matrix', 'tm1637'];

test('every light is in the catalogue with a label, a drawing and a group', () => {
  for (const type of NEW) {
    const c = catalog.find((e) => e.type === type);
    assert.ok(c, `${type} is in the catalogue`);
    assert.ok(c.label && c.tag.includes('-') && c.group, `${type} has a label, a drawing tag and a group`);
  }
  assert.equal(new Set(catalog.map((c) => c.label)).size, catalog.length, 'no two entries share a name');
  assert.match(catalog.find((c) => c.type === 'rgb-led')!.label, /cathode/);
  assert.match(catalog.find((c) => c.type === 'rgb-led-anode')!.label, /anode/);
});

test('LED variants light like an LED, and only the one with a resistor inside is spared the warning', () => {
  for (const type of ['led-green', 'led-10mm', 'ir-led', 'led-resistor']) {
    const r = rig([{ id: 'd', type }], [['u:9', 'd:A'], ['d:C', 'u:GND']]);
    r.set('9', 1); r.run(2);
    assert.equal(r.out('d').lit, true, `${type} lights`);
    assert.equal(r.show('d').brightness, 1);
    const warned = r.circuit.warnings().some((w) => /resistor/.test(w));
    assert.equal(warned, type !== 'led-resistor', `${type} ${type === 'led-resistor' ? 'needs no' : 'needs a'} resistor`);
    r.set('9', 0); r.run(4); assert.equal(r.out('d').lit, false);
  }
  // Wrong way round it stays dark.
  const r = rig([{ id: 'd', type: 'led-yellow' }], [['u:9', 'd:C'], ['d:A', 'u:GND']]);
  r.set('9', 1); r.run(1); assert.equal(r.out('d').lit, false);
});

test('a PWM-dimmed LED variant is drawn at its duty', () => {
  const r = rig([{ id: 'd', type: 'led-blue' }, { id: 'res', type: 'resistor' }], [['u:9', 'res:1'], ['res:2', 'd:A'], ['d:C', 'u:GND']]);
  for (let t = 0; t < 10e6; t += 2e6) { r.at(t, '9', 1); r.at(t + 500e3, '9', 0); }
  r.run(4); r.show('d'); r.run(10);
  const b = r.show('d').brightness as number;
  assert.ok(b > 0.2 && b < 0.3, `a quarter duty is drawn about a quarter bright, got ${b}`);
});

test('bi-colour LED: each leg lights its colour, both make yellow', () => {
  const r = rig([{ id: 'b', type: 'led-bicolor' }], [['u:5', 'b:R'], ['u:6', 'b:G'], ['b:C', 'u:GND']]);
  r.set('5', 1); r.set('6', 0); r.run(1);
  assert.deepEqual([r.out('b').red, r.out('b').green], [true, false]);
  r.set('6', 1); r.run(2);
  assert.deepEqual([r.out('b').red, r.out('b').green], [true, true]);
  r.set('5', 0); r.run(3);
  assert.deepEqual([r.out('b').red, r.out('b').green], [false, true]);
});

test('RGB LED, common anode: a colour lights when its pin is pulled low', () => {
  const r = rig([{ id: 'c', type: 'rgb-led-anode' }], [['c:COM', 'u:5V'], ['u:9', 'c:R'], ['u:10', 'c:G'], ['u:11', 'c:B']]);
  r.set('9', 0); r.set('10', 1); r.set('11', 1); r.run(1);
  assert.deepEqual([r.out('c').r, r.out('c').g, r.out('c').b], [true, false, false]);
  r.set('9', 1); r.set('11', 0); r.run(2);
  assert.deepEqual([r.out('c').r, r.out('c').g, r.out('c').b], [false, false, true]);
});

test('traffic-light module: each pin lights its lamp, with resistors on the board', () => {
  const r = rig([{ id: 't', type: 'traffic-light' }], [['u:2', 't:R'], ['u:3', 't:Y'], ['u:4', 't:G'], ['t:GND', 'u:GND']]);
  r.set('2', 1); r.set('3', 0); r.set('4', 0); r.run(1);
  assert.deepEqual([r.out('t').red, r.out('t').yellow, r.out('t').green], [true, false, false]);
  r.set('2', 0); r.set('4', 1); r.run(2);
  assert.deepEqual([r.out('t').red, r.out('t').yellow, r.out('t').green], [false, false, true]);
  assert.deepEqual(r.circuit.warnings(), []);
  // Without ground nothing lights.
  const loose = rig([{ id: 't', type: 'traffic-light' }], [['u:2', 't:R']]);
  loose.set('2', 1); loose.run(1); assert.equal(loose.out('t').red, false);
});

test('laser module: on while S is high and it has ground', () => {
  const r = rig([{ id: 'l', type: 'laser-module' }], [['u:7', 'l:S'], ['l:GND', 'u:GND']]);
  r.set('7', 0); r.run(1); assert.equal(r.out('l').on, false);
  r.set('7', 1); r.run(2); assert.equal(r.out('l').on, true);
});

test('starter sketch names the pins of the new lights', () => {
  const sketch = generateSketch({ version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 't', type: 'traffic-light', x: 0, y: 0 }, { id: 'g', type: 'led-green', x: 0, y: 0 }, { id: 'm', type: 'max7219-matrix', x: 0, y: 0 }],
    wires: [{ from: 'u:2', to: 't:R' }, { from: 'u:3', to: 't:Y' }, { from: 'u:4', to: 't:G' }, { from: 'u:5', to: 'g:A' }, { from: 'u:11', to: 'm:DIN' }], boards: [{ part: 'u', firmware: '' }] });
  for (const name of ['T_R = 2', 'T_Y = 3', 'T_G = 4', 'G = 5', 'M_DIN = 11']) assert.ok(sketch.includes(`const int ${name};`), `${name} in\n${sketch}`);
});

// ---------- WS2812 strip ----------
const sendBits = (r: ReturnType<typeof rig>, pin: string, start: number, bytes: number[]): number => {
  let t = start;
  for (const b of bytes) for (let i = 7; i >= 0; i--) { const one = (b >> i) & 1; r.at(t, pin, 1); r.at(t + (one ? 812 : 312), pin, 0); t += 1250; }
  return t;
};

test('WS2812 strip: a strip keeps its own pixels and passes the rest on through DOUT', () => {
  const r = rig([{ id: 's', type: 'led-strip', attrs: { pixels: '2' } }, { id: 'n', type: 'neopixel' }, { id: 'ring', type: 'led-ring', attrs: { pixels: '2' } }],
    [...power('s'), ['u:6', 's:DIN'], ['s:DOUT', 'n:DIN'], ['n:VDD', 'u:5V'], ['n:VSS', 'u:GND'], ['n:DOUT', 'ring:DIN'], ...power('ring')]);
  sendBits(r, '6', 1e6, [0, 255, 0, 255, 0, 0, /* strip: red, green */ 0, 0, 200, /* neopixel: blue */ 10, 20, 30, 40, 50, 60 /* ring */]);
  r.run(3);
  assert.deepEqual(r.out('s').pixels, [255, 0, 0, 0, 255, 0]);
  assert.equal(r.out('n').b, 200 / 255);
  assert.deepEqual(r.out('ring').pixels, [20, 10, 30, 50, 40, 60]);
  // A new frame after the reset gap starts again at the first pixel.
  sendBits(r, '6', 4e6, [0, 0, 255]); r.run(6);
  assert.deepEqual(r.out('s').pixels, [0, 0, 255, 0, 255, 0]);
  assert.equal(r.out('n').b, 200 / 255, 'the next one keeps its colour');
});

// ---------- MAX7219 ----------
test('MAX7219: LedControl draws on two chained 8x8 matrices', async () => {
  const s = await fw(`#include <LedControl.h>
    LedControl lc(12, 11, 10, 2);      // DIN, CLK, CS, two modules
    void setup() { Serial.begin(9600);
      for (int d = 0; d < 2; d++) { lc.shutdown(d, false); lc.setIntensity(d, 8); lc.clearDisplay(d); }
      lc.setRow(0, 0, B10100001); lc.setLed(0, 7, 7, true); lc.setColumn(1, 2, 0xFF); Serial.println("done"); }
    void loop() { if (Serial.available()) { char c = Serial.read(); if (c == 's') lc.shutdown(0, true); if (c == 'i') lc.setIntensity(1, 15); } }`,
    [{ id: 'm1', type: 'max7219-matrix' }, { id: 'm2', type: 'max7219-matrix' }],
    [...power('m1'), ...power('m2'), ['u:12', 'm1:DIN'], ['u:11', 'm1:CLK'], ['u:10', 'm1:CS'], ['m1:DOUT', 'm2:DIN'], ['u:11', 'm2:CLK'], ['u:10', 'm2:CS']]);
  s.run(300);
  assert.deepEqual(s.lines(), ['done']);
  assert.deepEqual(s.out('m1').rows, [0b10100001, 0, 0, 0, 0, 0, 0, 0b00000001]);
  assert.deepEqual(s.out('m2').rows, Array(8).fill(0b00100000), 'column 2 of the second module is lit top to bottom');
  assert.equal(s.out('m1').on, true); assert.equal(s.out('m1').intensity, 8);
  const v = s.show('m1').values as number[];
  assert.equal(v.length, 64); assert.deepEqual(v.slice(0, 8), [1, 0, 1, 0, 0, 0, 0, 1]); assert.equal(v[63], 1);
});

test('MAX7219: shutdown blanks the matrix, display test lights it all, scan limit hides rows', () => {
  const r = rig([{ id: 'm', type: 'max7219-matrix' }], [...power('m'), ['u:11', 'm:DIN'], ['u:13', 'm:CLK'], ['u:10', 'm:CS']]);
  let t = 1e6;
  const word = (reg: number, data: number) => {
    const w = (reg << 8) | data;
    r.at(t, '10', 0); t += 1000;
    for (let i = 15; i >= 0; i--) { r.at(t, '11', ((w >> i) & 1) as 0 | 1); r.at(t + 500, '13', 1); r.at(t + 1000, '13', 0); t += 1500; }
    r.at(t, '10', 1); t += 1000;
  };
  r.set('10', 1); r.set('13', 0);
  word(0x0f, 0); word(0x0b, 7); word(0x09, 0); word(0x01, 0xff); word(0x04, 0x81);
  r.run(t / 1e6 + 1);
  assert.equal(r.out('m').on, false, 'a MAX7219 wakes up in shutdown');
  assert.equal((r.show('m').values as number[]).filter(Boolean).length, 0);
  word(0x0c, 1); r.run(t / 1e6 + 1);
  assert.equal(r.out('m').on, true);
  assert.equal((r.show('m').values as number[]).filter(Boolean).length, 10);
  word(0x0b, 2); r.run(t / 1e6 + 1);
  assert.equal((r.show('m').values as number[]).filter(Boolean).length, 8, 'scan limit 2 shows rows 0 to 2 only');
  word(0x0f, 1); r.run(t / 1e6 + 1);
  assert.equal((r.show('m').values as number[]).filter(Boolean).length, 64, 'display test lights every dot');
});

// ---------- TM1637 ----------
test('TM1637: TM1637Display shows a number with the colon, and its brightness', async () => {
  const s = await fw(`#include <TM1637Display.h>
    TM1637Display d(2, 3);             // CLK, DIO
    void setup() { Serial.begin(9600); d.setBrightness(5); d.showNumberDecEx(1234, 0b01000000, false); Serial.println("shown"); }
    void loop() { if (Serial.available()) { char c = Serial.read();
      if (c == 'o') { d.setBrightness(7, false); d.showNumberDec(0); }
      if (c == 'n') { d.setBrightness(2); d.showNumberDec(-12, false); } } }`,
    [{ id: 't', type: 'tm1637' }], [...power('t'), ['u:2', 't:CLK'], ['u:3', 't:DIO']]);
  s.run(200);
  assert.deepEqual(s.lines(), ['shown']);
  assert.deepEqual(s.out('t').digits, [0x06, 0x5b | 0x80, 0x4f, 0x66]);
  assert.equal(s.out('t').on, true); assert.equal(s.out('t').brightness, 5);
  assert.equal(s.out('t').text, '12:34');
  const v = s.show('t').values as number[];
  assert.equal(v.length, 32); assert.deepEqual(v.slice(0, 8), [0, 1, 1, 0, 0, 0, 0, 0], 'digit 1 is segments B and C');
  assert.equal(s.show('t').colon, true);
});

test('TM1637: a display turned off is dark, and minus signs show', async () => {
  const s = await fw(`#include <TM1637Display.h>
    TM1637Display d(2, 3);
    void setup() { d.setBrightness(7, false); d.showNumberDec(8888); delay(300); d.setBrightness(2); d.showNumberDec(-12, false); }
    void loop() {}`,
    [{ id: 't', type: 'tm1637' }], [...power('t'), ['u:2', 't:CLK'], ['u:3', 't:DIO']]);
  s.run(150);
  assert.equal(s.out('t').on, false); assert.equal((s.show('t').values as number[]).filter(Boolean).length, 0);
  s.run(400);
  assert.equal(s.out('t').on, true); assert.equal(s.out('t').brightness, 2);
  assert.equal(s.out('t').text, ' -12');
});

test('library: the new lights all have pins and a model', () => {
  for (const type of NEW) { const d = library[type]; assert.ok(d.pins.length >= 2, type); assert.ok(d.device || d.outputs, `${type} has a model`); }
});
