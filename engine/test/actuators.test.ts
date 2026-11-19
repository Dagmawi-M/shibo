// Motors, drivers, relay modules and power parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers/rig.ts';
import { fw } from './helpers/fw.ts';
import { library } from '../src/parts/index.ts';
import { catalog } from '../src/edit.ts';
import { generateSketch } from '../src/sketchgen.ts';

const near = (a: number, b: number, d: number, what = '') => assert.ok(Math.abs(a - b) <= d, `${what} ${a} is not within ${d} of ${b}`);
/** Square wave on a board pin: `duty` of each `periodMs`, from `fromMs` for `forMs`. */
function pwm(r: ReturnType<typeof rig>, pin: string, duty: number, periodMs: number, fromMs: number, forMs: number) {
  for (let t = fromMs; t < fromMs + forMs; t += periodMs) {
    r.at(t * 1e6, pin, 1);
    r.at((t + periodMs * duty) * 1e6, pin, 0);
  }
}

test('every new part has pins, a label, a group and a drawing tag', () => {
  for (const type of ['dc-motor', 'l298n', 'l9110', 'relay-module', 'relay-module-high', 'solenoid', 'vibration-motor', 'fan', 'water-pump', 'stepper-28byj48',
    'battery-9v', 'battery-aa4', 'lipo', 'lm7805', 'ams1117', 'power-switch', 'fuse', 'power-module']) {
    const d = library[type];
    assert.ok(d, type);
    assert.ok(d.pins.length > 0 && d.ui?.label && d.ui.group && d.ui.tag.startsWith('shibo-'), type);
    assert.ok(catalog.some((c) => c.type === type), type);
  }
});

// ---------- DC motor ----------
test('a DC motor driven full on spins up to its rated speed, then coasts down when let go', () => {
  const r = rig([{ id: 'm', type: 'dc-motor' }, { id: 'h', type: 'l298n' }, { id: 'b', type: 'battery-9v' }],
    [['b:+', 'h:12V'], ['b:-', 'h:GND'], ['h:GND', 'u:GND'], ['u:8', 'h:IN1'], ['u:9', 'h:IN2'], ['h:OUT1', 'm:1'], ['h:OUT2', 'm:2']]);
  r.set('8', 1); r.set('9', 0);
  r.run(20);
  const early = r.out('m').rpm as number;
  assert.ok(early > 0 && early < 200, `still spinning up at 20 ms: ${early}`);
  r.run(1000);
  near(r.out('m').rpm as number, 200, 2, 'full speed');
  r.set('9', 1);                       // both inputs high: brake
  r.run(1500);
  near(r.out('m').rpm as number, 0, 1, 'braked');
});

test('a DC motor turns the other way when its leads are reversed', () => {
  const r = rig([{ id: 'm', type: 'dc-motor' }, { id: 'h', type: 'l298n' }, { id: 'b', type: 'battery-aa4' }],
    [['b:+', 'h:12V'], ['b:-', 'h:GND'], ['u:8', 'h:IN1'], ['u:9', 'h:IN2'], ['h:OUT1', 'm:1'], ['h:OUT2', 'm:2']]);
  r.set('8', 0); r.set('9', 1);
  r.run(1000);
  near(r.out('m').rpm as number, -200, 2, 'reverse');
});

test('PWM on the L298N enable pin sets the speed; a low duty does not overcome friction', () => {
  const half = rig([{ id: 'm', type: 'dc-motor' }, { id: 'h', type: 'l298n' }, { id: 'b', type: 'battery-9v' }],
    [['b:+', 'h:12V'], ['b:-', 'h:GND'], ['u:8', 'h:IN1'], ['u:9', 'h:IN2'], ['u:10', 'h:ENA'], ['h:OUT1', 'm:1'], ['h:OUT2', 'm:2']]);
  half.set('8', 1); half.set('9', 0); half.set('10', 0);
  pwm(half, '10', 0.5, 2, 0, 1200);
  half.run(1200);
  const rpm = half.out('m').rpm as number;
  near(rpm, 200 * (0.5 - 0.1) / 0.9, 6, 'half duty');
  const low = rig([{ id: 'm', type: 'dc-motor' }, { id: 'h', type: 'l298n' }, { id: 'b', type: 'battery-9v' }],
    [['b:+', 'h:12V'], ['b:-', 'h:GND'], ['u:8', 'h:IN1'], ['u:9', 'h:IN2'], ['u:10', 'h:ENA'], ['h:OUT1', 'm:1'], ['h:OUT2', 'm:2']]);
  low.set('8', 1); low.set('9', 0); low.set('10', 0);
  pwm(low, '10', 0.05, 2, 0, 1000);
  low.run(1000);
  assert.equal(low.out('m').rpm, 0);
});

test('the L298N needs its motor supply; its enable jumper keeps a channel on when ENA is not wired', () => {
  const dry = rig([{ id: 'm', type: 'dc-motor' }, { id: 'h', type: 'l298n' }], [['u:8', 'h:IN1'], ['u:9', 'h:IN2'], ['h:GND', 'u:GND'], ['h:OUT1', 'm:1'], ['h:OUT2', 'm:2']]);
  dry.set('8', 1); dry.set('9', 0); dry.run(500);
  assert.equal(dry.out('m').rpm, 0);
  assert.ok(dry.circuit.warnings().some((w) => /h\b/.test(w) && /12V/.test(w)), JSON.stringify(dry.circuit.warnings()));
  const ok = rig([{ id: 'm', type: 'dc-motor' }, { id: 'h', type: 'l298n' }, { id: 'b', type: 'battery-9v' }],
    [['b:+', 'h:12V'], ['b:-', 'h:GND'], ['u:8', 'h:IN3'], ['u:9', 'h:IN4'], ['h:OUT3', 'm:1'], ['h:OUT4', 'm:2']]);
  ok.set('8', 1); ok.set('9', 0); ok.run(1000);
  near(ok.out('m').rpm as number, 200, 2, 'channel B');
  assert.equal(ok.out('h').powered, true);
});

test('the L298N 5V pin supplies the board side when the motor supply is on', () => {
  const r = rig([{ id: 'h', type: 'l298n' }, { id: 'b', type: 'battery-9v' }, { id: 'p', type: 'pir-motion-sensor' }],
    [['b:+', 'h:12V'], ['b:-', 'h:GND'], ['h:5V', 'p:VCC'], ['p:GND', 'h:GND'], ['p:OUT', 'u:2']]);
  r.control('p', 'motion', 1);
  assert.equal(r.inputs['2'], 1);
});

test('a DC motor wired straight to a board pin is called out', () => {
  const r = rig([{ id: 'm', type: 'dc-motor' }], [['u:5', 'm:1'], ['m:2', 'u:GND']]);
  r.set('5', 1);
  assert.ok(r.circuit.warnings().some((w) => /\bm\b/.test(w) && /driver/.test(w)), JSON.stringify(r.circuit.warnings()));
});

test('L9110: IA high and IB low turns forward, the other way reverses, both equal stops', () => {
  const r = rig([{ id: 'm', type: 'dc-motor' }, { id: 'd', type: 'l9110' }],
    [['d:VCC', 'u:5V'], ['d:GND', 'u:GND'], ['u:5', 'd:A-IA'], ['u:6', 'd:A-IB'], ['d:MOTOR-A1', 'm:1'], ['d:MOTOR-A2', 'm:2']]);
  r.set('5', 1); r.set('6', 0); r.run(1000);
  near(r.out('m').rpm as number, 200, 2, 'forward');
  r.set('5', 0); r.set('6', 1); r.run(2500);
  near(r.out('m').rpm as number, -200, 2, 'reverse');
  r.set('6', 0); r.run(4000);
  near(r.out('m').rpm as number, 0, 1, 'stopped');
});

test('a sketch drives a motor through an L298N with analogWrite', async () => {
  const s = await fw(`
    void setup() { pinMode(8, OUTPUT); pinMode(9, OUTPUT); digitalWrite(8, HIGH); digitalWrite(9, LOW); analogWrite(10, 255); }
    void loop() {}`,
  [{ id: 'm', type: 'dc-motor' }, { id: 'h', type: 'l298n' }, { id: 'b', type: 'battery-9v' }],
  [['b:+', 'h:12V'], ['b:-', 'h:GND'], ['h:GND', 'u:GND'], ['u:8', 'h:IN1'], ['u:9', 'h:IN2'], ['u:10', 'h:ENA'], ['h:OUT1', 'm:1'], ['h:OUT2', 'm:2']]);
  s.run(1000);
  near(s.out('m').rpm as number, 200, 2, 'full');
  const half = await fw(`
    void setup() { pinMode(8, OUTPUT); pinMode(9, OUTPUT); digitalWrite(8, HIGH); digitalWrite(9, LOW); analogWrite(10, 128); }
    void loop() {}`,
  [{ id: 'm', type: 'dc-motor' }, { id: 'h', type: 'l298n' }, { id: 'b', type: 'battery-9v' }],
  [['b:+', 'h:12V'], ['b:-', 'h:GND'], ['h:GND', 'u:GND'], ['u:8', 'h:IN1'], ['u:9', 'h:IN2'], ['u:10', 'h:ENA'], ['h:OUT1', 'm:1'], ['h:OUT2', 'm:2']]);
  half.run(1000);
  near(half.out('m').rpm as number, 200 * (128 / 255 - 0.1) / 0.9, 6, 'half');
});

test('a motor can be given its own rated speed', () => {
  const r = rig([{ id: 'm', type: 'dc-motor', attrs: { rpm: '3000' } }, { id: 'b', type: 'battery-aa4' }], [['b:+', 'm:1'], ['b:-', 'm:2']]);
  r.run(1000);
  near(r.out('m').rpm as number, 3000, 30, 'rated');
});

// ---------- other motors ----------
test('fan, pump and vibration motor run from a supply; fan and pump only run the right way round', () => {
  const r = rig([{ id: 'f', type: 'fan' }, { id: 'p', type: 'water-pump' }, { id: 'v', type: 'vibration-motor' }, { id: 'b', type: 'battery-aa4' }],
    [['b:+', 'f:+'], ['b:-', 'f:-'], ['b:+', 'p:+'], ['b:-', 'p:-'], ['b:-', 'v:1'], ['b:+', 'v:2']]);
  r.run(1000);
  assert.ok((r.out('f').rpm as number) > 4000, JSON.stringify(r.out('f')));
  near(r.out('p').flow as number, 120, 2, 'flow L/h');
  assert.equal(r.out('v').on, true);
  const back = rig([{ id: 'f', type: 'fan' }, { id: 'p', type: 'water-pump' }, { id: 'b', type: 'battery-aa4' }],
    [['b:-', 'f:+'], ['b:+', 'f:-'], ['b:-', 'p:+'], ['b:+', 'p:-']]);
  back.run(1000);
  assert.equal(back.out('f').rpm, 0); assert.equal(back.out('p').flow, 0);
});

test('a solenoid pulls in while energised and lets go when the drive stops', () => {
  const r = rig([{ id: 's', type: 'solenoid' }, { id: 'k', type: 'relay-module' }, { id: 'b', type: 'battery-9v' }],
    [['k:VCC', 'u:5V'], ['k:GND', 'u:GND'], ['u:7', 'k:IN'], ['b:+', 'k:COM'], ['k:NO', 's:1'], ['s:2', 'b:-']]);
  r.set('7', 1); r.run(50);
  assert.equal(r.out('s').on, false);
  r.set('7', 0); r.run(100);
  assert.equal(r.out('s').on, true);
  r.set('7', 1); r.run(150);
  assert.equal(r.out('s').on, false);
});

test('a solenoid on a board pin is called out', () => {
  const r = rig([{ id: 's', type: 'solenoid' }], [['u:4', 's:1'], ['s:2', 'u:GND']]);
  r.set('4', 1);
  assert.ok(r.circuit.warnings().some((w) => /\bs\b/.test(w) && /transistor/.test(w)), JSON.stringify(r.circuit.warnings()));
});

// ---------- relay modules ----------
test('active-low relay module: IN low closes COM to NO after the contacts move; floating IN is off', () => {
  const r = rig([{ id: 'k', type: 'relay-module' }],
    [['k:VCC', 'u:5V'], ['k:GND', 'u:GND'], ['u:7', 'k:IN'], ['k:COM', 'u:5V'], ['k:NO', 'u:8'], ['k:NC', 'u:9']]);
  r.set('7', 'input'); r.run(30);
  assert.deepEqual([r.inputs['8'], r.inputs['9'], r.out('k').on], [null, 1, false]);
  r.at(40e6, '7', 0);
  r.run(42);
  assert.equal(r.inputs['9'], 1, 'the armature takes a few ms to move');
  r.run(60);
  assert.deepEqual([r.inputs['8'], r.inputs['9'], r.out('k').on], [1, null, true]);
  r.set('7', 1); r.run(80);
  assert.deepEqual([r.inputs['8'], r.inputs['9']], [null, 1]);
  assert.deepEqual(r.circuit.warnings(), []);
});

test('active-high relay module: IN high energises it; with no VCC nothing happens', () => {
  const r = rig([{ id: 'k', type: 'relay-module-high' }], [['k:VCC', 'u:5V'], ['k:GND', 'u:GND'], ['u:7', 'k:IN'], ['k:COM', 'u:GND'], ['k:NO', 'u:8']]);
  r.set('8', 'pullup'); r.set('7', 0); r.run(30);
  assert.equal(r.inputs['8'], 1);
  r.set('7', 1); r.run(60);
  assert.equal(r.inputs['8'], 0);
  const dead = rig([{ id: 'k', type: 'relay-module-high' }], [['u:7', 'k:IN'], ['k:COM', 'u:GND'], ['k:NO', 'u:8']]);
  dead.set('8', 'pullup'); dead.set('7', 1); dead.run(60);
  assert.equal(dead.inputs['8'], 1);
});

test('a sketch switches a relay module with digitalWrite', async () => {
  const s = await fw(`
    void setup() { pinMode(7, OUTPUT); digitalWrite(7, HIGH); pinMode(2, INPUT_PULLUP); Serial.begin(115200); }
    void loop() { static int n = 0; delay(50); Serial.println(digitalRead(2)); digitalWrite(7, (++n % 2) ? LOW : HIGH); }`,
  [{ id: 'k', type: 'relay-module' }], [['k:VCC', 'u:5V'], ['k:GND', 'u:GND'], ['u:7', 'k:IN'], ['k:COM', 'u:GND'], ['k:NO', 'u:2']]);
  s.run(400);
  assert.deepEqual(s.lines().slice(0, 4), ['1', '0', '1', '0']);
});

// ---------- 28BYJ-48 ----------
// The Arduino Stepper library's four-wire sequence, with pins given IN1, IN3, IN2, IN4 as is usual for this motor.
const STEPPER = (usPerStep: number, steps: number) => `
  const int p[4] = {8, 10, 9, 11};
  const byte seq[4][4] = {{1,0,1,0},{0,1,1,0},{0,1,0,1},{1,0,0,1}};
  void stepTo(int i) { for (int k = 0; k < 4; k++) digitalWrite(p[k], seq[i & 3][k]); }
  void setup() { for (int k = 0; k < 4; k++) pinMode(p[k], OUTPUT); Serial.begin(115200);
    for (long i = 0; i < ${Math.abs(steps)}; i++) { stepTo(${steps < 0 ? '-i + 4000' : 'i'}); delayMicroseconds(${usPerStep}); }
    Serial.println("done"); }
  void loop() {}`;
const BYJ: [string, string][] = [['s:IN1', 'u:8'], ['s:IN2', 'u:9'], ['s:IN3', 'u:10'], ['s:IN4', 'u:11'], ['s:VCC', 'u:5V'], ['s:GND', 'u:GND']];

test('28BYJ-48: 2048 full steps make one turn of the shaft, at the speed the Stepper library is usually set to', async () => {
  const s = await fw(STEPPER(2000, 1024), [{ id: 's', type: 'stepper-28byj48' }], BYJ);
  s.run(2300);
  assert.deepEqual(s.lines(), ['done']);
  near(s.out('s').angle as number, 180, 0.5, 'half a turn');
  const back = await fw(STEPPER(2000, -512), [{ id: 's', type: 'stepper-28byj48' }], BYJ);
  back.run(1200);
  near(back.out('s').angle as number, -90, 0.5, 'a quarter turn back');
});

test('28BYJ-48: stepped too fast it misses steps, as the real one does', async () => {
  const s = await fw(STEPPER(400, 512), [{ id: 's', type: 'stepper-28byj48' }], BYJ);
  s.run(400);
  assert.deepEqual(s.lines(), ['done']);
  assert.ok(Math.abs(s.out('s').angle as number) < 60, `${s.out('s').angle}`);
  assert.equal(s.out('s').stalled, true);
});

test('28BYJ-48: the ULN2003 board lights an LED for each energised coil, and needs power', () => {
  const r = rig([{ id: 's', type: 'stepper-28byj48' }], BYJ);
  r.set('8', 1); r.set('9', 1);
  assert.deepEqual(r.out('s').coils, [1, 1, 0, 0]);
  const dead = rig([{ id: 's', type: 'stepper-28byj48' }], BYJ.slice(0, 4));
  dead.set('8', 1);
  assert.deepEqual(dead.out('s').coils, [0, 0, 0, 0]);
});

// ---------- power ----------
test('a battery powers what is wired to it: a sensor fed from AA cells works', () => {
  const r = rig([{ id: 'b', type: 'battery-aa4' }, { id: 'p', type: 'pir-motion-sensor' }], [['b:+', 'p:VCC'], ['b:-', 'p:GND'], ['b:-', 'u:GND'], ['p:OUT', 'u:2']]);
  r.control('p', 'motion', 1);
  assert.equal(r.inputs['2'], 1);
  assert.equal(r.out('p').powered, true);
});

test('regulators: an LM7805 fed from a 9V battery gives 5V; an AMS1117 gives 3.3V', () => {
  const r = rig([{ id: 'b', type: 'battery-9v' }, { id: 'reg', type: 'lm7805' }, { id: 'ams', type: 'ams1117' }, { id: 'p', type: 'pir-motion-sensor' }],
    [['b:+', 'reg:IN'], ['b:-', 'reg:GND'], ['reg:OUT', 'p:VCC'], ['p:GND', 'b:-'], ['p:OUT', 'u:2'], ['reg:OUT', 'ams:IN'], ['ams:GND', 'b:-'], ['ams:OUT', 'u:A1'], ['reg:OUT', 'u:A0'], ['b:-', 'u:GND']]);
  r.control('p', 'motion', 1);
  assert.equal(r.inputs['2'], 1);
  near(r.analog.A0, 5, 0.01); near(r.analog.A1, 3.3, 0.01);
  const off = rig([{ id: 'reg', type: 'lm7805' }, { id: 'p', type: 'pir-motion-sensor' }], [['reg:OUT', 'p:VCC'], ['p:GND', 'u:GND'], ['reg:GND', 'u:GND']]);
  assert.equal(off.out('p').powered, false);
});

test('a power switch and a fuse sit in the supply line', () => {
  const r = rig([{ id: 'b', type: 'battery-9v' }, { id: 'sw', type: 'power-switch' }, { id: 'f', type: 'fuse' }, { id: 'reg', type: 'lm7805' }, { id: 'p', type: 'pir-motion-sensor' }],
    [['b:+', 'f:1'], ['f:2', 'sw:1'], ['sw:2', 'reg:IN'], ['reg:GND', 'b:-'], ['reg:OUT', 'p:VCC'], ['p:GND', 'b:-']]);
  assert.equal(r.out('p').powered, false, 'switch starts off');
  r.control('sw', 'on', 1);
  assert.equal(r.out('p').powered, true);
  r.control('f', 'blown', 1);
  assert.equal(r.out('p').powered, false);
});

test('breadboard power module: each rail gives 5V or 3.3V as its jumper says, and the button turns it off', () => {
  const r = rig([{ id: 'pm', type: 'power-module', attrs: { right: '3.3V' } }, { id: 'p', type: 'pir-motion-sensor' }],
    [['pm:VCC1', 'p:VCC'], ['pm:GND1', 'p:GND'], ['p:OUT', 'u:2'], ['pm:VCC1', 'u:A0'], ['pm:VCC2', 'u:A1'], ['pm:GND1', 'u:GND']]);
  r.control('p', 'motion', 1);
  assert.equal(r.inputs['2'], 1);
  near(r.analog.A0, 5, 0.01); near(r.analog.A1, 3.3, 0.01);
  r.control('pm', 'on', 0);
  assert.equal(r.out('p').powered, false);
});

test('a battery over 5V wired straight to a board pin is called out; a battery shorted by a wire is contended', () => {
  const r = rig([{ id: 'b', type: 'battery-9v' }], [['b:+', 'u:A0'], ['b:-', 'u:GND']]);
  assert.ok(r.circuit.warnings().some((w) => /\bb\b/.test(w) && /9 ?V/.test(w)), JSON.stringify(r.circuit.warnings()));
  const s = rig([{ id: 'b', type: 'lipo' }], [['b:+', 'b:-']]);
  assert.ok(s.engine.log.some((l) => /contended/.test(l)), s.engine.log.join('\n'));
});

test('the starter sketch names the driver inputs and the relay module input', () => {
  const sk = generateSketch({ version: 1, boards: [{ part: 'u', firmware: '' }],
    parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'h', type: 'l298n', x: 0, y: 0 }, { id: 'k', type: 'relay-module', x: 0, y: 0 }, { id: 's', type: 'stepper-28byj48', x: 0, y: 0 }],
    wires: [{ from: 'u:8', to: 'h:IN1' }, { from: 'u:10', to: 'h:ENA' }, { from: 'u:7', to: 'k:IN' }, { from: 'u:2', to: 's:IN1' }] });
  for (const name of ['H_IN1 = 8', 'H_ENA = 10', 'K = 7', 'S_IN1 = 2']) assert.ok(sk.includes(`const int ${name};`), name + '\n' + sk);
});
