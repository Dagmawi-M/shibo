import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rig } from './helpers/rig.ts';
import { Electrical, Spice, findNgspice } from '../src/electrical/index.ts';
import { ohms } from '../src/electrical/ratings.ts';
import { e12Up } from '../src/electrical/checks.ts';
import { library } from '../src/parts/index.ts';
import type { PartDef } from '../src/part.ts';

// Tests find ngspice the same way the editor does: $SHIBO_NGSPICE, Shibo's own copy, or the PATH.
const BIN = findNgspice() ?? 'ngspice';
const hasSpice = (() => { try { execFileSync(BIN, ['-v'], { stdio: 'ignore', timeout: 5000, env: { ...process.env, LD_LIBRARY_PATH: path.join(path.dirname(path.dirname(BIN)), 'lib') } }); return true; } catch { return false; } })();
const spice = new Spice(BIN);
after(() => spice.close());
const needs = { skip: hasSpice ? false : 'ngspice is not installed' };

async function solve(parts: Parameters<typeof rig>[0], wires: [string, string][], pins: Record<string, 0 | 1 | 'pullup'> = {}, lib?: Record<string, PartDef>) {
  const r = rig(parts, wires);
  for (const [p, l] of Object.entries(pins)) r.set(p, l);
  const e = new Electrical({ spice, lib });
  return e.check(r.circuit.picture());
}
const has = (ws: string[], re: RegExp) => ws.some((w) => re.test(w));

test('resistance values are read the way they are written on parts lists', () => {
  assert.equal(ohms('220', 0), 220); assert.equal(ohms('1k', 0), 1000); assert.equal(ohms('4k7', 0), 4700);
  assert.equal(ohms('4.7K', 0), 4700); assert.equal(ohms('1M', 0), 1e6); assert.equal(ohms('220Ω', 0), 220);
  assert.equal(ohms(undefined, 1000), 1000); assert.ok(Number.isNaN(ohms('blue', 0)));
  assert.equal(e12Up(300), 330); assert.equal(e12Up(150), 150); assert.equal(e12Up(151), 180);
});

test('an LED with 220 Ω on a pin draws about 13 mA, and nothing is wrong', needs, async () => {
  const r = await solve([{ id: 'r1', type: 'resistor', attrs: { value: '220' } }, { id: 'led1', type: 'led', attrs: { color: 'red' } }],
    [['u:13', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'u:GND']], { 13: 1 });
  assert.equal(r.state, 'ok');
  const led = r.leds.find((l) => l.part === 'led1')!;
  assert.ok(led.ma > 11 && led.ma < 15, `led current ${led.ma} mA`);
  const pin = r.pins.find((p) => p.pin === '13')!;
  assert.ok(Math.abs(pin.ma - led.ma) < 0.1, 'the pin supplies what the LED takes');
  assert.deepEqual(r.warnings, []);
  assert.equal(r.parts.led1, 'ok'); assert.equal(r.parts.r1, 'ok');
  // The meter: the wire from the pin is at nearly 5 V and carries the LED current; the one to GND is at 0 V.
  assert.ok(r.wires[0]!.volts > 4.6 && r.wires[0]!.volts <= 5, `pin wire at ${r.wires[0]!.volts} V`);
  assert.ok(Math.abs(r.wires[0]!.amps! * 1000 - led.ma) < 0.05);
  assert.ok(Math.abs(r.wires[2]!.volts) < 0.01);
  assert.ok(r.wires[1]!.volts > 1.7 && r.wires[1]!.volts < 2.3, `the LED's anode sits at its forward voltage: ${r.wires[1]!.volts}`);
});

test('an LED straight on a pin overloads the pin and burns out', needs, async () => {
  const r = await solve([{ id: 'led1', type: 'led' }], [['u:13', 'led1:A'], ['led1:C', 'u:GND']], { 13: 1 });
  assert.ok(has(r.warnings, /u pin 13 is supplying \d+ mA: over the ATmega328P's 40 mA absolute limit/), r.warnings.join('\n'));
  assert.ok(has(r.warnings, /led1 has \d+ mA through it: over its 30 mA limit.*330 Ω/), r.warnings.join('\n'));
  assert.equal(r.parts.led1, 'warn'); assert.equal(r.parts.u, 'warn');
});

test('an LED with too small a resistor is over its rating; too large and it barely glows', needs, async () => {
  const wires: [string, string][] = [['u:13', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'u:GND']];
  const small = await solve([{ id: 'r1', type: 'resistor', attrs: { value: '82' } }, { id: 'led1', type: 'led' }], wires, { 13: 1 });
  assert.ok(has(small.warnings, /led1 has 2\d mA through it: more than the 20 mA it is rated for/), small.warnings.join('\n'));
  assert.ok(has(small.warnings, /u pin 13 is supplying 2\d mA: more than the 20 mA recommended/), small.warnings.join('\n'));
  const big = await solve([{ id: 'r1', type: 'resistor', attrs: { value: '47k' } }, { id: 'led1', type: 'led' }], wires, { 13: 1 });
  assert.ok(has(big.warnings, /led1 has only 0\.\d mA through it, so it will barely glow/), big.warnings.join('\n'));
  // Pin low: the LED is off, and that is not a problem.
  const off = await solve([{ id: 'r1', type: 'resistor', attrs: { value: '47k' } }, { id: 'led1', type: 'led' }], wires, { 13: 0 });
  assert.deepEqual(off.warnings, []);
});

test('a blue LED drops more voltage than a red one', needs, async () => {
  const wires: [string, string][] = [['u:13', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'u:GND']];
  const red = await solve([{ id: 'r1', type: 'resistor', attrs: { value: '220' } }, { id: 'led1', type: 'led', attrs: { color: 'red' } }], wires, { 13: 1 });
  const blue = await solve([{ id: 'r1', type: 'resistor', attrs: { value: '220' } }, { id: 'led1', type: 'led', attrs: { color: 'blue' } }], wires, { 13: 1 });
  assert.ok(blue.wires[1]!.volts - red.wires[1]!.volts > 0.8);
  assert.ok(blue.leds[0].ma < red.leds[0].ma - 3);
});

test('a 5 V-only part on the 3.3 V pin is underpowered; a 3.3 V part on 5 V is over its limit', needs, async () => {
  const rtc = await solve([{ id: 'rtc', type: 'ds1307' }], [['rtc:5V', 'u:3.3V'], ['rtc:GND', 'u:GND']]);
  assert.ok(has(rtc.warnings, /rtc gets only 3\.3 V on 5V, but it needs 4\.5 to 5\.5 V.*Power it from 5V/), rtc.warnings.join('\n'));
  const sonar = await solve([{ id: 'us', type: 'hc-sr04' }], [['us:VCC', 'u:3.3V'], ['us:GND', 'u:GND']]);
  assert.ok(has(sonar.warnings, /us gets only 3\.3 V/));
  const lib = { ...library, 'test-3v3': { type: 'test-3v3', pins: ['VCC', 'GND', 'SDA'], links: () => [], electrical: { elements: () => [{ kind: 'load', vcc: 'VCC', gnd: 'GND', ma: 1, volts: 3.3 }], supplies: [{ vcc: 'VCC', gnd: 'GND', min: 3, max: 3.6 }], logicMax: 3.6 } } as PartDef };
  const over = await solve([{ id: 's', type: 'test-3v3' }], [['s:VCC', 'u:5V'], ['s:GND', 'u:GND']], {}, lib);
  assert.ok(has(over.warnings, /s gets 5\.0 V on VCC, but it takes at most 3\.6 V.*Power it from 3\.3V/), over.warnings.join('\n'));
});

test('a 5 V pin into a 3.3 V part\'s signal is caught; through a divider it is fine', needs, async () => {
  const part = { type: 'test-3v3', pins: ['VCC', 'GND', 'SDA'], links: () => [], electrical: { elements: () => [{ kind: 'load', vcc: 'VCC', gnd: 'GND', ma: 1, volts: 3.3 }], supplies: [{ vcc: 'VCC', gnd: 'GND', min: 3, max: 3.6 }], logicMax: 3.6 } } as PartDef;
  const lib = { ...library, 'test-3v3': part };
  const power: [string, string][] = [['s:VCC', 'u:3.3V'], ['s:GND', 'u:GND']];
  const direct = await solve([{ id: 's', type: 'test-3v3' }], [...power, ['u:7', 's:SDA']], { 7: 1 }, lib);
  assert.ok(has(direct.warnings, /s pin SDA sees 5\.0 V, but it is a 3\.3 V part/), direct.warnings.join('\n'));
  const divided = await solve([{ id: 's', type: 'test-3v3' }, { id: 'r1', type: 'resistor', attrs: { value: '1k' } }, { id: 'r2', type: 'resistor', attrs: { value: '2k' } }],
    [...power, ['u:7', 'r1:1'], ['r1:2', 's:SDA'], ['s:SDA', 'r2:1'], ['r2:2', 'u:GND']], { 7: 1 }, lib);
  assert.deepEqual(divided.warnings, []);
});

test('the 5 V supply budget: four servos and a gas sensor are more than USB gives', needs, async () => {
  const parts = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, type: 'servo' }));
  const wires: [string, string][] = parts.flatMap((p) => [[`${p.id}:V+`, 'u:5V'], [`${p.id}:GND`, 'u:GND']] as [string, string][]);
  const r = await solve([...parts, { id: 'gas', type: 'gas-sensor' }], [...wires, ['gas:VCC', 'u:5V'], ['gas:GND', 'u:GND']]);
  const rail = r.rails.find((x) => x.pin === '5V')!;
  assert.ok(rail.ma > 700 && rail.ma < 800, `5V draws ${rail.ma} mA`);
  assert.ok(has(r.warnings, /u's 5V supply is asked for \d+ mA, more than USB/), r.warnings.join('\n'));
  const one = await solve([parts[0]], wires.slice(0, 2));
  assert.deepEqual(one.warnings, []);
});

test('the 3.3 V pin has its own, smaller budget, and it comes out of the 5 V one', needs, async () => {
  const parts = [1, 2, 3].map((n) => ({ id: `m${n}`, type: 'gas-sensor' }));
  const wires = parts.flatMap((p) => [[`${p.id}:VCC`, 'u:3.3V'], [`${p.id}:GND`, 'u:GND']] as [string, string][]);
  const r = await solve(parts, wires);
  assert.ok(has(r.warnings, /u's 3\.3V supply is asked for \d+ mA, more than the 3\.3 V regulator/), r.warnings.join('\n'));
  const r33 = r.rails.find((x) => x.pin === '3.3V')!, r5 = r.rails.find((x) => x.pin === '5V')!;
  assert.ok(r5.ma >= r33.ma);
});

test('5V wired to GND is a short circuit', needs, async () => {
  const r = await solve([], [['u:5V', 'u:GND.1']]);
  assert.ok(has(r.warnings, /Short circuit: u's 5V pin is wired straight to GND/), r.warnings.join('\n'));
});

test('a pressed button from a pull-up pin to GND carries the pull-up current', needs, async () => {
  const rg = rig([{ id: 'b1', type: 'pushbutton' }], [['u:2', 'b1:1.l'], ['b1:2.l', 'u:GND']]);
  rg.set('2', 'pullup');
  const e = new Electrical({ spice });
  const open = await e.check(rg.circuit.picture());
  assert.ok(open.wires[0]!.volts > 4.9, 'released: the pin sits high');
  rg.control('b1', 'pressed', 1);
  const shut = await e.check(rg.circuit.picture());
  assert.ok(shut.wires[0]!.volts < 0.01, 'pressed: the pin is pulled to GND');
  const ua = shut.wires[0]!.amps! * 1e6;
  assert.ok(ua > 100 && ua < 200, `about 5 V / 35 kΩ: ${ua} µA`);
  assert.deepEqual(shut.warnings, []);
});

test('a potentiometer is a real divider: its wiper voltage follows the knob', needs, async () => {
  const rg = rig([{ id: 'p', type: 'potentiometer' }], [['p:VCC', 'u:5V'], ['p:GND', 'u:GND'], ['p:SIG', 'u:A0']]);
  rg.control('p', 'value', 512);
  const r = await new Electrical({ spice }).check(rg.circuit.picture());
  assert.ok(Math.abs(r.wires[2]!.volts - 2.5) < 0.05, `${r.wires[2]!.volts}`);
  assert.ok(Math.abs(-r.wires[0]!.amps! * 1000 - 0.5) < 0.05, '5 V across 10 kΩ, flowing from the 5V pin into VCC: against the way the wire was drawn');
});

test('without ngspice nothing breaks: parts show unchecked and say why', async () => {
  const rg = rig([{ id: 'led1', type: 'led' }], [['u:13', 'led1:A'], ['led1:C', 'u:GND']]);
  rg.set('13', 1);
  const e = new Electrical({ ngspice: '/nowhere/ngspice' });
  const r = await e.check(rg.circuit.picture());
  assert.equal(r.state, 'unchecked');
  assert.match(r.reason!, /ngspice was not found/);
  assert.equal(r.parts.led1, 'unchecked');
  assert.deepEqual(r.wires, [null, null]);
  e.close();
  // A command that does not exist on the PATH also degrades, once the spawn fails.
  const e2 = new Electrical({ spice: new Spice('shibo-no-such-ngspice') });
  const r2 = await e2.check(rg.circuit.picture());
  assert.equal(r2.state, 'unchecked');
  assert.equal(findNgspice('/nowhere/ngspice'), null);
});

test('the live monitor solves in the background and keeps each problem once, with its latest numbers', needs, async () => {
  const rg = rig([{ id: 'r1', type: 'resistor', attrs: { value: '82' } }, { id: 'led1', type: 'led' }], [['u:13', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'u:GND']]);
  const e = new Electrical({ spice });
  const seen: number[] = [];
  e.onReport((r) => seen.push(r.leds[0].ma));
  rg.set('13', 1); e.update(rg.circuit.picture());
  rg.set('13', 0); e.update(rg.circuit.picture());
  rg.set('13', 1); e.update(rg.circuit.picture());
  await e.settled();
  // The first picture is solved; of the two that came in meanwhile only the latest counts, and it is the same as the first.
  assert.equal(seen.length, 1);
  assert.ok(seen[0] > 20);
  rg.set('13', 0); e.update(rg.circuit.picture()); await e.settled();
  assert.equal(seen.length, 2); assert.equal(seen[1], 0);
  e.update(rg.circuit.picture()); await e.settled();
  assert.equal(seen.length, 2, 'an unchanged circuit is not solved again');
  assert.equal(e.warnings().filter((w) => /led1 has/.test(w)).length, 1);
});

test('the wire meter reads volts and the way current flows', async () => {
  const { meterText } = await import('../../app/src/meter.ts');
  const m = { state: 'ok' as const, parts: {}, wires: [{ volts: 4.71, amps: 0.0131 }, { volts: 2.5, amps: -0.0005 }, { volts: 0, amps: null }, null] };
  assert.equal(meterText(m, 0, 'u:13', 'r1:1'), '4.71 V, 13.1 mA from u:13 to r1:1');
  assert.equal(meterText(m, 1, 'p:VCC', 'u:5V'), '2.50 V, 500 µA from u:5V to p:VCC');
  assert.match(meterText(m, 2, 'a', 'b'), /closes a loop/);
  assert.equal(meterText(m, 3, 'a', 'b'), 'Not measured');
  assert.match(meterText({ state: 'unchecked', reason: 'ngspice was not found', wires: [], parts: {} }, 0, 'a', 'b'), /ngspice was not found/);
  assert.equal(meterText(null, 0, 'a', 'b'), '');
});
