// Sensors with timing: OneWire, motion holds, pulse trains and waveforms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fw, power } from './helpers/fw.ts';
import { rig } from './helpers/rig.ts';
import { crc8maxim, romFor } from '../src/parts/sensors-timed.ts';

const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
/** The last line the sketch finished printing. */
const done = (s: { serial(): string }) => s.serial().split(/\r?\n/).slice(0, -1).filter(Boolean).at(-1);
const nums = (line: string | undefined) => (line ?? '').trim().split(/\s+/).map(Number);

// The OneWire library's bit timings, written out so the test needs no library.
const ONEWIRE = `
const int P = 7;
bool owReset() { noInterrupts(); pinMode(P, OUTPUT); digitalWrite(P, LOW); delayMicroseconds(480); pinMode(P, INPUT); delayMicroseconds(70);
  bool r = !digitalRead(P); interrupts(); delayMicroseconds(410); return r; }
void owBit(bool b) { noInterrupts(); pinMode(P, OUTPUT); digitalWrite(P, LOW); delayMicroseconds(b ? 10 : 65); pinMode(P, INPUT); interrupts(); delayMicroseconds(b ? 55 : 5); }
bool owRead() { noInterrupts(); pinMode(P, OUTPUT); digitalWrite(P, LOW); delayMicroseconds(3); pinMode(P, INPUT); delayMicroseconds(10);
  bool r = digitalRead(P); interrupts(); delayMicroseconds(53); return r; }
void owWrite(uint8_t v) { for (int i = 0; i < 8; i++) owBit((v >> i) & 1); }
uint8_t owByte() { uint8_t v = 0; for (int i = 0; i < 8; i++) if (owRead()) v |= 1 << i; return v; }
uint8_t crc8(const uint8_t *a, uint8_t n) { uint8_t c = 0; while (n--) { uint8_t b = *a++; for (uint8_t i = 8; i; i--) { uint8_t m = (c ^ b) & 1; c >>= 1; if (m) c ^= 0x8C; b >>= 1; } } return c; }
// Maxim's ROM search, as in OneWire::search.
uint8_t rom[8]; int lastDisc = -1; bool lastDev = false;
bool owSearch() {
  if (lastDev || !owReset()) return false;
  int disc = -1; owWrite(0xF0);
  for (int i = 0; i < 64; i++) {
    bool a = owRead(), b = owRead(), dir;
    if (a && b) return false;
    if (a != b) dir = a;
    else { if (i < lastDisc) dir = (rom[i / 8] >> (i % 8)) & 1; else dir = (i == lastDisc); if (!dir) disc = i; }
    if (dir) rom[i / 8] |= 1 << (i % 8); else rom[i / 8] &= ~(1 << (i % 8));
    owBit(dir);
  }
  lastDisc = disc; if (disc < 0) lastDev = true; return true;
}
`;

test('DS18B20: ROM search finds two sensors; each is read by match ROM with a good CRC', async () => {
  const s = await fw(ONEWIRE + `
    uint8_t roms[2][8]; int found = 0;
    void setup() { Serial.begin(115200); while (found < 2 && owSearch()) { memcpy(roms[found], rom, 8); found++; }
      Serial.print("found "); Serial.print(found); for (int k = 0; k < found; k++) { Serial.print(' '); Serial.print(crc8(roms[k], 7) == roms[k][7]); } Serial.println(); }
    void loop() {
      owReset(); owWrite(0xCC); owWrite(0x44);
      int polls = 0; while (!owRead()) polls++;                // the sensor answers 0 until the conversion is done
      for (int k = 0; k < found; k++) {
        owReset(); owWrite(0x55); for (int i = 0; i < 8; i++) owWrite(roms[k][i]); owWrite(0xBE);
        uint8_t d[9]; for (int i = 0; i < 9; i++) d[i] = owByte();
        Serial.print(roms[k][1], HEX); Serial.print(':'); Serial.print(crc8(d, 8) == d[8]); Serial.print(':'); Serial.print((int16_t)((d[1] << 8) | d[0]) / 16.0); Serial.print(' ');
      }
      Serial.println(polls > 9000 && polls < 13000 ? "ok" : "wrong"); /* 750 ms of ~70 us polls */ }`,
    [{ id: 't1', type: 'ds18b20' }, { id: 't2', type: 'ds18b20' }],
    [['t1:VDD', 'u:5V'], ['t1:GND', 'u:GND'], ['t2:VDD', 'u:5V'], ['t2:GND', 'u:GND'], ['t1:DQ', 'u:7'], ['t2:DQ', 'u:7']]);
  s.control('t2', 'temperature', -10.125);
  s.run(900);
  assert.equal(s.lines()[0], 'found 2 1 1');
  const v = s.lines().at(-1)!.split(' ');
  const byId = Object.fromEntries(v.slice(0, 2).map((x) => { const [id, ok, t] = x.split(':'); return [id, [ok, +t]]; }));
  assert.deepEqual(byId[romFor('t1')[1].toString(16).toUpperCase()], ['1', 24]);
  assert.deepEqual(byId[romFor('t2')[1].toString(16).toUpperCase()], ['1', -10.13], 'Serial.print rounds -10.125 to 2 places');
  assert.equal(v[2], 'ok');
});

test('DS18B20: power-on reads 85 °C; 9-bit resolution converts faster with coarser steps', async () => {
  const s = await fw(ONEWIRE + `
    float readT() { owReset(); owWrite(0xCC); owWrite(0xBE); uint8_t lo = owByte(), hi = owByte(); return (int16_t)((hi << 8) | lo) / 16.0; }
    void setup() { Serial.begin(115200);
      Serial.print(owReset()); Serial.print(' '); Serial.print(readT());
      owReset(); owWrite(0xCC); owWrite(0x4E); owWrite(0x4B); owWrite(0x46); owWrite(0x1F);   // 9 bits
      owReset(); owWrite(0xCC); owWrite(0x44); unsigned long t0 = millis(); while (!owRead()) ; Serial.print(' '); Serial.print(millis() - t0);
      Serial.print(' '); Serial.println(readT()); }
    void loop() {}`,
    [{ id: 't', type: 'ds18b20' }], [['t:VDD', 'u:5V'], ['t:GND', 'u:GND'], ['t:DQ', 'u:7']]);
  s.control('t', 'temperature', 21.3);
  s.run(250);
  const [present, first, ms, t] = nums(s.lines()[0]);
  assert.equal(present, 1); assert.equal(first, 85);
  near(ms, 94, 3, 'conversion ms'); assert.equal(t, 21.0, '0.5 °C steps');
});

test('DS18B20: the CRC and ROM helpers match the Maxim examples', () => {
  // Maxim application note 27's worked example ROM.
  assert.equal(crc8maxim([0x02, 0x1c, 0xb8, 0x01, 0x00, 0x00, 0x00]), 0xa2);
  const rom = romFor('x'); assert.equal(rom[0], 0x28); assert.equal(crc8maxim(rom.slice(0, 7)), rom[7]);
});

test('HC-SR501: repeat mode holds after motion stops; single mode pulses then blocks', () => {
  const r = rig([{ id: 'p', type: 'hc-sr501' }, { id: 'm', type: 'am312' }], [...power('p'), ['p:OUT', 'u:2'], ...power('m'), ['m:OUT', 'u:3']]);
  r.run(10); assert.equal(r.inputs['2'], 0);
  r.control('p', 'motion', 1); r.control('m', 'motion', 1); r.run(20);
  assert.equal(r.inputs['2'], 1); assert.equal(r.inputs['3'], 1);
  r.control('p', 'motion', 0); r.control('m', 'motion', 0);
  r.run(2000); assert.equal(r.inputs['3'], 1, 'AM312 holds 2 s'); r.run(2030); assert.equal(r.inputs['3'], 0);
  r.run(5000); assert.equal(r.inputs['2'], 1, 'still on 5 s later... just'); r.run(5050); assert.equal(r.inputs['2'], 0, 'off after the 5 s hold');
  // Single trigger: continuous motion still gives one pulse, a 2.5 s gap, then another.
  r.control('p', 'repeat', 0); r.control('p', 'hold', 3); r.control('p', 'motion', 1);
  r.run(5100); assert.equal(r.inputs['2'], 1);
  r.run(8100); assert.equal(r.inputs['2'], 0, 'pulse over although motion goes on');
  r.run(10500); assert.equal(r.inputs['2'], 0, 'blocked');
  r.run(10700); assert.equal(r.inputs['2'], 1, 'triggers again after the block');
});

test('SW-420 pulses while shaken; KY-031 bounces low on a knock; TTP223 direct and toggle modes', () => {
  const r = rig([{ id: 'v', type: 'vibration-sensor' }, { id: 'k', type: 'knock-sensor' }, { id: 't', type: 'touch-sensor' }],
    [...power('v'), ['v:DO', 'u:2'], ...power('k'), ['k:S', 'u:3'], ...power('t'), ['t:SIG', 'u:4']]);
  r.run(5); assert.deepEqual([r.inputs['2'], r.inputs['3'], r.inputs['4']], [0, 1, 0]);
  r.control('v', 'shake', 3); r.run(105);
  const rises = r.edgesOf('2').filter(([l]) => l === 1);
  near(rises.length, 10, 1, 'a pulse every 10 ms');
  const [[, up], [, down]] = r.edgesOf('2').slice(-2).sort((a, b) => a[1] - b[1]).length === 2 ? [r.edgesOf('2').filter(([l]) => l === 1).at(-1)!, r.edgesOf('2').filter(([l]) => l === 0).at(-1)!] : [[0, 0], [0, 0]];
  near(Math.abs(down - up), up < down ? 3e6 : 7e6, 0.2e6, 'high for 3 ms of each 10');
  r.control('v', 'shake', 0); r.run(120); assert.equal(r.inputs['2'], 0);
  r.control('k', 'knock', 1); r.run(121); assert.equal(r.inputs['3'], 0, 'knock pulls S low'); r.run(130); assert.equal(r.inputs['3'], 1);
  assert.equal(r.edgesOf('3').filter(([l]) => l === 0).length, 2, 'the contact bounces once');
  r.control('t', 'touch', 1); r.run(131); assert.equal(r.inputs['4'], 1); r.control('t', 'touch', 0); r.run(132); assert.equal(r.inputs['4'], 0);
  r.control('t', 'toggleMode', 1);
  r.control('t', 'touch', 1); r.run(132.5); r.control('t', 'touch', 0); r.run(133); assert.equal(r.inputs['4'], 1, 'toggle: one touch turns it on');
  r.control('t', 'touch', 1); r.run(133.5); r.control('t', 'touch', 0); r.run(134); assert.equal(r.inputs['4'], 0, 'and the next turns it off');
  r.control('t', 'activeLow', 1); r.run(135); assert.equal(r.inputs['4'], 1, 'active low');
});

test('ZMPT101B, ACS712 and microphone: a sketch sampling the waveform sees its RMS and peak-to-peak', async () => {
  const s = await fw(`
    void setup() { Serial.begin(115200); }
    void loop() {
      // 100 ms of samples (5 mains cycles) on each input.
      for (int a = A0; a <= A2; a++) {
        double sum = 0, sq = 0; long n = 0; int lo = 1023, hi = 0; unsigned long t0 = millis();
        while (millis() - t0 < 100) { int v = analogRead(a); sum += v; sq += (double)v * v; n++; if (v < lo) lo = v; if (v > hi) hi = v; }
        double mean = sum / n; double rms = sqrt(sq / n - mean * mean) * 5.0 / 1023;
        Serial.print(mean * 5.0 / 1023, 3); Serial.print(' '); Serial.print(rms, 3); Serial.print(' '); Serial.print(hi - lo); Serial.print(' ');
      }
      Serial.println(); }`,
    [{ id: 'z', type: 'zmpt101b' }, { id: 'c', type: 'acs712-5a' }, { id: 'mic', type: 'microphone' }],
    [...power('z'), ...power('c'), ...power('mic'), ['z:OUT', 'u:A0'], ['c:OUT', 'u:A1'], ['mic:OUT', 'u:A2']]);
  s.control('c', 'current', 2); s.control('mic', 'loudness', 50);
  s.run(350);
  let v = nums(done(s));
  near(v[0], 2.5, 0.02, 'ZMPT mean'); near(v[1], 1 / Math.SQRT2, 0.03, 'ZMPT RMS: 1 V peak at 230 V');
  near(v[3], 2.5 + 2 * 0.185, 0.01, 'ACS712 DC: 185 mV/A'); assert.ok(v[5] < 3, 'DC: steady');
  near(v[8], 2 * 1.2 * 1023 / 5, 25, 'microphone peak-to-peak at half loudness');
  s.control('z', 'volts', 115); s.control('c', 'ac', 1); s.control('c', 'current', 3);
  s.run(700); v = nums(done(s));
  near(v[1], 0.5 / Math.SQRT2, 0.02, 'ZMPT at 115 V'); near(v[4], 3 * 0.185, 0.02, 'ACS712 AC RMS');
});
