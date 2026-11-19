// Every project in examples/ builds, is wired without mistakes, and does
// what its README says when its real sketch runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/engine.ts';
import { Circuit } from '../src/circuit.ts';
import { UnoBackend } from '../src/backends/avr.ts';
import { buildUno } from '../src/build.ts';
import { parseProject, validate } from '../src/project.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', 'examples');
const names = fs.readdirSync(ROOT).filter((n) => fs.existsSync(path.join(ROOT, n, 'shibo.json'))).sort();

async function example(name: string) {
  const dir = path.join(ROOT, name);
  const project = parseProject(JSON.parse(fs.readFileSync(path.join(dir, 'shibo.json'), 'utf8')), `${name}/shibo.json`);
  assert.deepEqual(validate(project), [], `${name}: every wire goes to a real pin`);
  const built = await buildUno(dir);
  if (!built.ok) throw new Error(`${name}: the sketch did not build:\n${built.log}`);
  const engine = new Engine();
  const board = project.boards[0].part;
  const uno = new UnoBackend(board, built.hex!);
  engine.addBackend(uno);
  const circuit = new Circuit(engine, project, { [board]: uno });
  let serial = ''; uno.onSerial((b) => { serial += String.fromCharCode(b); });
  const ex = {
    circuit,
    /** Run for this many milliseconds of simulated time. */
    run: (ms: number) => engine.runUntil(engine.now + Math.round(ms * 1e6)),
    /** Run until the serial monitor shows `re`, or fail after `ms`. */
    async until(re: RegExp, ms = 5000) {
      const end = engine.now + ms * 1e6;
      while (!re.test(serial)) { if (engine.now >= end) assert.fail(`${name}: ${re} not seen on serial within ${ms} ms; got:\n${serial}`); ex.run(20); }
    },
    serial: () => serial, lines: () => serial.split(/\r?\n/).filter(Boolean),
    out: (id: string) => circuit.outputs()[id] ?? {},
    /** What the page would draw now. Brightness is an average since the last look, so look, wait 5 ms, look again. */
    show: (id: string) => { circuit.display(); engine.runUntil(engine.now + 5e6); return circuit.display()[id] ?? {}; },
    set: (id: string, control: string, v: number) => circuit.setControl(id, control, v),
    /** Hold a control at a value for `ms`, then put it back to 0. */
    tap(id: string, control: string, v: number, ms = 80) { circuit.setControl(id, control, v); ex.run(ms); circuit.setControl(id, control, 0); ex.run(ms); },
    /** Nothing in the circuit is miswired, shorted or unpowered. */
    clean() {
      assert.deepEqual(circuit.warnings(), [], `${name}: no wiring warnings`);
      assert.deepEqual(circuit.contended(), [], `${name}: no shorted outputs`);
      for (const [id, o] of Object.entries(circuit.outputs())) assert.notEqual(o.powered, false, `${name}: ${id} has power`);
    },
  };
  return ex;
}
const lit = (o: Record<string, unknown>) => o.lit === true;

test('there are at least ten examples, each with a sketch and a README', () => {
  assert.ok(names.length >= 10, `only ${names.length} examples`);
  for (const n of names) {
    const files = fs.readdirSync(path.join(ROOT, n));
    assert.ok(files.some((f) => f.endsWith('.ino')), `${n} has a sketch`);
    assert.ok(files.includes('README.md'), `${n} has a README`);
  }
  const index = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const n of names) assert.ok(index.includes(`(${n}/)`), `examples/README.md links to ${n}`);
});

test('traffic light: red, green, yellow, in that order and for that long', async () => {
  const ex = await example('traffic-light');
  const lights = () => ['red', 'yellow', 'green'].filter((c) => lit(ex.out(c)));
  ex.run(1000); assert.deepEqual(lights(), ['red']);
  ex.run(2900); assert.deepEqual(lights(), ['green'], 'green after 3 s');
  ex.run(2500); assert.deepEqual(lights(), ['yellow'], 'yellow after 6 s');
  ex.run(1000); assert.deepEqual(lights(), ['red'], 'red again after 7 s');
  assert.deepEqual(ex.lines().slice(0, 4), ['red', 'green', 'yellow', 'red']);
  ex.clean();
});

test('night light: dark in daylight, half lit at dusk, full in the dark', async () => {
  const ex = await example('night-light');
  ex.set('ldr', 'lux', 1000); ex.run(500);
  assert.equal(ex.show('lamp').brightness, 0, 'off in a bright room');
  ex.set('ldr', 'lux', 1); ex.run(500);
  assert.ok(Number(ex.show('lamp').brightness) > 0.95, `full in the dark: ${ex.show('lamp').brightness}`);
  ex.set('ldr', 'lux', 60); ex.run(500);
  const b = Number(ex.show('lamp').brightness);
  assert.ok(b > 0.2 && b < 0.9, `part lit at dusk: ${b}`);
  assert.match(ex.serial(), /light reading \d+, lamp \d+/);
  ex.clean();
});

test('LCD thermometer: shows the temperature the sensor is set to', async () => {
  const ex = await example('lcd-thermometer');
  ex.set('ntc', 'temperature', 30); ex.run(800);
  const [top, bottom] = String(ex.out('lcd').text).split('\n');
  assert.equal(top.trim(), 'Thermometer');
  assert.match(bottom, /^Temp: (29\.9|30\.0|30\.1) C/);
  ex.set('ntc', 'temperature', -5); ex.run(600);
  assert.match(String(ex.out('lcd').text).split('\n')[1], /^Temp: -(4\.9|5\.0|5\.1) C/);
  ex.clean();
});

test('distance alarm: quiet when far, beeps and lights when near', async () => {
  const ex = await example('distance-alarm');
  ex.set('sonar', 'distance', 100); ex.run(400);
  assert.match(ex.lines().at(-1)!, /^Distance: (99|100) cm$/);
  assert.equal(lit(ex.out('warn')), false); assert.equal(ex.show('buzzer').on, false);
  ex.set('sonar', 'distance', 15); ex.run(400);
  assert.match(ex.lines().at(-1)!, /^Distance: (14|15) cm$/);
  assert.equal(lit(ex.out('warn')), true); assert.equal(ex.show('buzzer').on, true);
  ex.set('sonar', 'distance', 200); ex.run(400);
  assert.equal(lit(ex.out('warn')), false); assert.equal(ex.show('buzzer').on, false);
  ex.clean();
});

test('servo sweep: the horn goes all the way to 180 and back to 0', async () => {
  const ex = await example('servo-sweep');
  const angles: number[] = [];
  for (let t = 0; t < 6000; t += 100) { ex.run(100); angles.push(Number(ex.out('servo').angle)); }
  const top = angles.indexOf(Math.max(...angles));
  assert.ok(Math.max(...angles) >= 178, `reaches 180: ${Math.max(...angles)}`);
  assert.ok(angles.slice(top).some((a) => a <= 2), 'comes back to 0');
  // On the way up it only ever turns one way.
  for (let i = 1; i < top; i++) assert.ok(angles[i] >= angles[i - 1], `steady sweep up: ${angles.slice(0, top).join(',')}`);
  assert.match(ex.serial(), /180\r?\n0/);
  ex.clean();
});

test('servo knob: the servo follows the knob', async () => {
  const ex = await example('servo-knob');
  for (const [knob, angle] of [[0, 0], [1023, 180], [512, 90], [256, 45]]) {
    ex.set('knob', 'value', knob); ex.run(200);
    assert.ok(Math.abs(Number(ex.out('servo').angle) - angle) <= 1, `knob ${knob}: angle ${ex.out('servo').angle}, wanted ${angle}`);
  }
  ex.clean();
});

test('keypad lock: the right code unlocks, a wrong one does not', async () => {
  const ex = await example('keypad-lock');
  // Keys count along the rows of the pad: 1 2 3 A / 4 5 6 B / 7 8 9 C / * 0 # D.
  const KEY: Record<string, number> = { '1': 1, '2': 2, '3': 3, '4': 5, '5': 6, '9': 11, '*': 13, '0': 14, '#': 15 };
  const type = (keys: string) => { for (const k of keys) ex.tap('keypad', 'key', KEY[k]); };
  await ex.until(/Locked\. Enter the code/);
  assert.equal(lit(ex.out('locked')), true); assert.equal(lit(ex.out('open')), false);
  type('1299#');
  await ex.until(/Wrong code/);
  assert.equal(lit(ex.out('open')), false);
  ex.run(1000);
  type('12*1234#');
  await ex.until(/Cleared[\s\S]*Unlocked/);
  assert.equal(lit(ex.out('open')), true, 'the green LED shows open');
  assert.equal(lit(ex.out('locked')), false);
  ex.run(2200);
  assert.equal(lit(ex.out('open')), false, 'it locks again after two seconds');
  assert.equal(lit(ex.out('locked')), true);
  ex.clean();
});

test('LED dimmer: brightness follows the knob', async () => {
  const ex = await example('led-dimmer');
  for (const [knob, want] of [[0, 0], [1023, 1], [256, 0.25], [768, 0.75]]) {
    ex.set('knob', 'value', knob); ex.run(200);
    const b = Number(ex.show('lamp').brightness);
    assert.ok(Math.abs(b - want) <= 0.03, `knob ${knob}: brightness ${b}, wanted ${want}`);
  }
  ex.clean();
});

test('motion alarm: movement sets it off, stillness clears it', async () => {
  const ex = await example('motion-alarm');
  await ex.until(/Watching/);
  ex.run(200);
  assert.equal(lit(ex.out('alarm')), false); assert.equal(ex.show('buzzer').on, false);
  ex.set('pir', 'motion', 1); ex.run(200);
  assert.match(ex.serial(), /Motion detected!/);
  assert.equal(lit(ex.out('alarm')), true); assert.equal(ex.show('buzzer').on, true);
  ex.set('pir', 'motion', 0); ex.run(200);
  assert.match(ex.serial(), /All clear/);
  assert.equal(lit(ex.out('alarm')), false); assert.equal(ex.show('buzzer').on, false);
  ex.clean();
});

test('electronic dice: a press rolls a number from 1 to 6 and the digit shows it', async () => {
  const ex = await example('electronic-dice');
  // Segments A..G of each digit, as the display reports them.
  const PATTERN: Record<number, string> = { 1: '0110000', 2: '1101101', 3: '1111001', 4: '0110011', 5: '1011011', 6: '1011111' };
  ex.run(300);
  assert.equal(ex.out('display').values!.toString().replace(/,/g, '').slice(0, 7), '1111110', 'shows 0 before the first roll');
  const rolls = new Set<number>();
  for (let i = 0; i < 6; i++) {
    ex.set('roll', 'pressed', 1); ex.run(30 + i * 37); ex.set('roll', 'pressed', 0);   // hold for a different time each go
    await ex.until(new RegExp(`(Rolled \\d[\\s\\S]*){${i + 1}}`), 3000);
    ex.run(100);
    const n = Number(ex.lines().at(-1)!.split(' ')[1]);
    assert.ok(n >= 1 && n <= 6, `rolled ${n}`);
    rolls.add(n);
    assert.equal((ex.out('display').values as number[]).slice(0, 7).join(''), PATTERN[n], `the digit shows ${n}`);
  }
  assert.ok(rolls.size >= 2, `the rolls vary: ${[...rolls]}`);
  ex.clean();
});

test('RGB mood light: each colour comes up in turn', async () => {
  const ex = await example('rgb-mood-light');
  const peak = { r: 0, g: 0, b: 0 };
  let order = '';
  for (let t = 0; t < 3300; t += 50) {
    ex.run(50);
    const o = ex.show('rgb') as Record<'r' | 'g' | 'b', number>;
    for (const c of ['r', 'g', 'b'] as const) {
      peak[c] = Math.max(peak[c], o[c]);
      if (o[c] > 0.9 && order.at(-1) !== c) order += c;
    }
  }
  assert.ok(peak.r > 0.9 && peak.g > 0.9 && peak.b > 0.9, `every colour reaches full: ${JSON.stringify(peak)}`);
  assert.match(order, /^rgbr/, `red, then green, then blue: ${order}`);
  assert.match(ex.serial(), /green\r?\nblue\r?\nred/);
  ex.clean();
});

test('OLED clock: the time ticks on, and is drawn on the display', async () => {
  const ex = await example('oled-clock');
  await ex.until(/00:00:0\d\r?\n00:00:0\d\r?\n00:00:0\d/, 6000);
  const times = ex.lines().filter((l) => /^\d\d:\d\d:\d\d$/.test(l)).map((l) => Number(l.slice(6)));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 1 && times[i] - times[i - 1] <= 2, `one second a line: ${times}`);
  assert.equal(ex.out('oled').on, true);
  assert.ok(Number(ex.out('oled').pixels) > 100, `text is drawn: ${ex.out('oled').pixels} pixels lit`);
  ex.clean();
});
