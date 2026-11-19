// Boards beyond the Uno, each running a real sketch compiled for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSketch, fqbnOf } from '../src/build.ts';
import { createBackend, runnableBoards } from '../src/backends/index.ts';
import { MegaBackend, parseHex } from '../src/backends/avr.ts';
import { boardPins, canonicalPin } from '../src/project.ts';
import { catalog } from '../src/edit.ts';
import { fw } from './helpers/fw.ts';
import { Session, type OutMsg } from '../src/session.ts';

const MS = 1e6;

async function compile(board: string, sketch: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), `shibo-${board}-`));
  writeFileSync(path.join(dir, 'b.ino'), sketch);
  const built = await buildSketch(dir, board);
  assert.ok(built.ok, built.log);
  return built.hex!;
}

const lines = (s: string) => s.split(/\r?\n/).filter(Boolean);

const MEGA_SKETCH = `
volatile int hits = 0;
void onEdge() { hits++; }
void setup() {
  Serial.begin(115200);
  Serial1.begin(9600); Serial2.begin(9600); Serial3.begin(9600);
  pinMode(40, OUTPUT); digitalWrite(40, HIGH);
  pinMode(22, OUTPUT); digitalWrite(22, LOW);
  pinMode(53, INPUT_PULLUP);
  pinMode(2, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(2), onEdge, FALLING);
  Serial.println("mega up");
}
void loop() {
  Serial.print("A0="); Serial.println(analogRead(A0));
  Serial.print("A15="); Serial.println(analogRead(A15));
  Serial.print("hits="); Serial.println(hits);
  Serial1.println("one"); Serial2.println("two"); Serial3.println("three");
  delay(100);
}
`;

test('every board in the catalog has pins, a build target and a backend', () => {
  for (const c of catalog.filter((c) => c.board)) {
    assert.ok(boardPins[c.type], `${c.type} pins`);
    assert.ok(fqbnOf(c.type), `${c.type} fqbn`);
    assert.ok(runnableBoards.includes(c.type), `${c.type} backend`);
  }
  assert.equal(fqbnOf('mega'), 'arduino:avr:mega:cpu=atmega2560');
});

test('Mega pins: all 70 I/O pins, A0-A15, and SDA/SCL as copies of 20/21', () => {
  const pins = boardPins.mega;
  for (let i = 0; i < 54; i++) assert.ok(pins.includes(String(i)), `pin ${i}`);
  for (let i = 0; i < 16; i++) assert.ok(pins.includes('A' + i), `A${i}`);
  assert.equal(canonicalPin('mega', 'SDA'), '20');
  assert.equal(canonicalPin('mega', 'SCL'), '21');
  assert.equal(canonicalPin('mega', 'GND.5'), 'GND');
  assert.equal(canonicalPin('mega', '5V.2'), '5V');
});

test('Intel HEX past 64 KB (extended address records) loads', () => {
  // A record at segment 0x1000 (byte address 0x10000) must land there, not wrap to 0.
  const hex = [':020000021000EC', ':02000000ABCD86', ':00000001FF'].join('\n');
  const prog = parseHex(hex, 0x40000);
  assert.equal(prog[0x10000 / 2], 0xcdab);
  assert.equal(prog[0], 0);
});

test('Mega runs a real sketch: ports A-L, A15, INT4 on pin 2, and all four serial ports', async () => {
  const m = createBackend('mega', 'm', await compile('mega', MEGA_SKETCH)) as MegaBackend;
  let s0 = ''; const sx = ['', '', '', ''];
  m.onSerial((b) => { s0 += String.fromCharCode(b); });
  for (const n of [1, 2, 3]) m.onSerialPort(n, (b) => { sx[n] += String.fromCharCode(b); });
  m.setAnalog('A0', 1.25); m.setAnalog('A15', 3.75);
  m.setInput('2', 1);
  m.runUntil(150 * MS);
  const level = (p: string) => m.drives().find((d) => d.pin === p);
  assert.equal(level('40')?.level, 1);                      // port G bit 1
  assert.equal(level('22')?.level, 0);                      // port A bit 0
  assert.deepEqual(level('53'), { pin: '53', level: null, pull: 'up' });
  assert.ok(m.inputPins().includes('30'), 'untouched pins are plain inputs');
  assert.match(s0, /mega up/);
  assert.ok(lines(s0).includes('A0=256'), s0);
  assert.ok(lines(s0).includes('A15=768'), s0);
  assert.match(sx[1], /one/); assert.match(sx[2], /two/); assert.match(sx[3], /three/);
  // Two falling edges on pin 2 (PE4, INT4).
  for (const t of [160, 180]) { m.runUntil(t * MS); m.setInput('2', 0); m.runUntil((t + 5) * MS); m.setInput('2', 1); }
  m.runUntil(400 * MS);
  assert.ok(lines(s0).includes('hits=2'), s0);
});

test('Mega millis() keeps time (timer 0 overflow vector) and PWM works on timer 5', async () => {
  const hex = await compile('mega', `
void setup() { Serial.begin(115200); analogWrite(44, 64); analogWrite(6, 192); }
void loop() { Serial.println(millis()); delay(500); }`);
  const m = createBackend('mega', 'm', hex);
  let s = ''; m.onSerial((b) => { s += String.fromCharCode(b); });
  // Measure the duty on pins 44 (timer 5) and 6 (timer 4) over 20 ms.
  const high: Record<string, number> = { '44': 0, '6': 0 }; let n = 0;
  m.runUntil(10 * MS);
  for (let t = 10; t < 30; t += 0.01) {
    m.runUntil(t * MS); n++;
    for (const p of ['44', '6']) if (m.drives().find((d) => d.pin === p)?.level === 1) high[p]++;
  }
  assert.ok(Math.abs(high['44'] / n - 0.25) < 0.05, `pin 44 duty ${high['44'] / n}`);
  assert.ok(Math.abs(high['6'] / n - 0.75) < 0.05, `pin 6 duty ${high['6'] / n}`);
  m.runUntil(2100 * MS);
  const times = lines(s).map(Number);
  assert.ok(times.length >= 4, s);
  assert.ok(Math.abs(times[4] - 2000) <= 5, `millis at 5th line: ${times[4]}`);
});

test('Mega in a circuit: a potentiometer on A12 and a button on pin 19', async () => {
  const f = await fw(`
void setup() { Serial.begin(115200); pinMode(19, INPUT_PULLUP); }
void loop() { Serial.print(analogRead(A12)); Serial.print(' '); Serial.println(digitalRead(19)); delay(50); }`,
  [{ id: 'pot', type: 'potentiometer' }, { id: 'b', type: 'pushbutton' }],
  [['pot:VCC', 'u:5V'], ['pot:GND', 'u:GND.1'], ['pot:SIG', 'u:A12'], ['b:1.l', 'u:19'], ['b:2.l', 'u:GND.2']], 'mega');
  f.control('pot', 'value', 512);
  f.run(120);
  assert.match(f.lines().at(-1)!, /^51[12] 1$/);
  f.control('b', 'pressed', 1);
  f.run(120);
  assert.match(f.lines().at(-1)!, /^51[12] 0$/);
});

test('Nano builds with its own FQBN, so A6 and A7 exist', async () => {
  assert.equal(fqbnOf('nano'), 'arduino:avr:nano:cpu=atmega328');
  const nano = createBackend('nano', 'n', await compile('nano', `void setup() { Serial.begin(9600); } void loop() { Serial.println(analogRead(A7)); delay(50); }`));
  let s = ''; nano.onSerial((b) => { s += String.fromCharCode(b); });
  nano.setAnalog('A7', 2.5);
  nano.runUntil(100 * MS);
  assert.ok(lines(s).includes('512'), s);
});

test('Mega I2C: a DS1307 on the SDA/SCL header answers, and one on pins 20/21 too', async () => {
  const sketch = `#include <Wire.h>
void setup() { Serial.begin(115200); Wire.begin(); }
void loop() { Wire.beginTransmission(0x68); Serial.println(Wire.endTransmission()); delay(50); }`;
  for (const [sda, scl] of [['SDA', 'SCL'], ['20', '21']]) {
    const f = await fw(sketch, [{ id: 'rtc', type: 'ds1307' }],
      [['rtc:5V', 'u:5V'], ['rtc:GND', 'u:GND.1'], ['rtc:SDA', `u:${sda}`], ['rtc:SCL', `u:${scl}`]], 'mega');
    f.run(80);
    assert.equal(f.lines()[0], '0', `wired to ${sda}/${scl}: ${f.serial()}`);
  }
});

test('Mega pin-change interrupts on port K (A8-A15) and port J (pin 15)', async () => {
  const hex = await compile('mega', `
volatile int k = 0, j = 0;
ISR(PCINT2_vect) { k++; }
ISR(PCINT1_vect) { j++; }
void setup() {
  Serial.begin(115200);
  pinMode(A8, INPUT_PULLUP); pinMode(15, INPUT_PULLUP);
  PCMSK2 = 1; PCMSK1 = 1 << 1; PCICR = (1 << PCIE2) | (1 << PCIE1);
}
void loop() { Serial.print(k); Serial.print(' '); Serial.println(j); delay(20); }`);
  const m = createBackend('mega', 'm', hex);
  let s = ''; m.onSerial((b) => { s += String.fromCharCode(b); });
  m.setInput('A8', 1); m.setInput('15', 1);
  m.runUntil(30 * MS);
  m.setInput('A8', 0); m.runUntil(35 * MS); m.setInput('A8', 1); m.runUntil(40 * MS);
  m.setInput('15', 0); m.runUntil(45 * MS);
  m.runUntil(100 * MS);
  assert.equal(lines(s).at(-1), '2 1');
});

test('the session builds for and runs whichever board is in the circuit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-mega-session-'));
  writeFileSync(path.join(dir, 'diagram.json'), JSON.stringify({
    version: 1, parts: [{ type: 'wokwi-arduino-mega', id: 'mega', top: 0, left: 0 }, { type: 'wokwi-led', id: 'led1', top: 0, left: 0 }],
    connections: [['mega:46', 'led1:A', 'green', []], ['led1:C', 'mega:GND.4', 'black', []]],
  }));
  // Pin 46 and Serial3 exist only on the Mega: an Uno build would fail.
  writeFileSync(path.join(dir, 'm.ino'), 'void setup() { Serial.begin(9600); Serial3.begin(9600); pinMode(46, OUTPUT); digitalWrite(46, HIGH); Serial.println("on a mega"); } void loop() {}');
  const boards: string[] = [];
  const s = new Session({ build: (d, b) => { boards.push(b); return buildSketch(d, b); } });
  const out: OutMsg[] = []; s.onMessage((m) => out.push(m));
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'start' });
  for (let i = 0; i < 4; i++) s.tick(50);
  assert.deepEqual(boards, ['mega']);
  assert.equal(out.filter((m) => m.t === 'error').length, 0, JSON.stringify(out.filter((m) => m.t === 'error')));
  assert.match(out.filter((m) => m.t === 'serial').map((m) => (m as any).text).join(''), /on a mega/);
  assert.equal((out.filter((m) => m.t === 'outputs').at(-1) as any).outputs.led1.lit, true);
  s.dispose();
});
