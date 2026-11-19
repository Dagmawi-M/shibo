// Parts that depend on timing or speak a protocol. Where a common sketch
// pattern exists, a real compiled sketch does the talking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers/rig.ts';
import { fw, power } from './helpers/fw.ts';

const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);

test('HC-SR04: a sketch using pulseIn reads the distance that was set', async () => {
  const s = await fw(`
    void setup() { Serial.begin(9600); pinMode(7, OUTPUT); pinMode(8, INPUT); }
    void loop() { digitalWrite(7, LOW); delayMicroseconds(2); digitalWrite(7, HIGH); delayMicroseconds(10); digitalWrite(7, LOW);
      unsigned long us = pulseIn(8, HIGH, 40000UL); Serial.println(us / 58); delay(60); }`,
    [{ id: 'd', type: 'hc-sr04' }], [...power('d'), ['u:7', 'd:TRIG'], ['d:ECHO', 'u:8']]);
  s.run(300); near(Number(s.lines().at(-1)), 100, 2, 'default distance');
  s.control('d', 'distance', 23); s.run(300); near(Number(s.lines().at(-1)), 23, 1, 'near');
  s.control('d', 'distance', 320); s.run(400); near(Number(s.lines().at(-1)), 320, 4, 'far');
});

test('DHT22: a sketch reading the 40-bit frame gets the temperature and humidity that were set', async () => {
  const s = await fw(`
    const int P = 4; uint8_t d[5];
    bool readDHT() {
      pinMode(P, OUTPUT); digitalWrite(P, LOW); delay(2); pinMode(P, INPUT_PULLUP);
      if (pulseIn(P, HIGH, 2000) == 0) return false;                 // the sensor's 80 us "here I am"
      for (int i = 0; i < 40; i++) { unsigned long w = pulseIn(P, HIGH, 2000); if (!w) return false; d[i / 8] = (d[i / 8] << 1) | (w > 45); }
      return ((d[0] + d[1] + d[2] + d[3]) & 0xff) == d[4];
    }
    void setup() { Serial.begin(9600); }
    void loop() { delay(300); if (readDHT()) { int h = (d[0] << 8) | d[1]; int t = ((d[2] & 0x7f) << 8) | d[3]; if (d[2] & 0x80) t = -t;
      Serial.print(h); Serial.print(' '); Serial.println(t); } else Serial.println("fail"); }`,
    [{ id: 'h', type: 'dht22' }], [...power('h'), ['h:SDA', 'u:4']]);
  s.run(700); assert.equal(s.lines().at(-1), '400 240');
  s.control('h', 'temperature', -7.5); s.control('h', 'humidity', 81.3); s.run(700);
  assert.equal(s.lines().at(-1), '813 -75');
});

test('servo: pulse width sets the angle', async () => {
  const s = await fw(`int us = 1500;
    void setup() { pinMode(9, OUTPUT); Serial.begin(9600); }
    void loop() { if (Serial.available()) us = Serial.parseInt(); digitalWrite(9, HIGH); delayMicroseconds(us); digitalWrite(9, LOW); delay(18); }`,
    [{ id: 'm', type: 'servo' }], [['m:V+', 'u:5V'], ['m:GND', 'u:GND'], ['u:9', 'm:PWM']]);
  s.run(100); near(s.out('m').angle as number, 93, 2, '1500 us');
  const r = rig([{ id: 'm', type: 'servo' }], [['m:V+', 'u:5V'], ['m:GND', 'u:GND'], ['u:9', 'm:PWM']]);
  r.at(1e6, '9', 1); r.at(1e6 + 544_000, '9', 0); r.run(3); near(r.out('m').angle as number, 0, 1, '544 us');
  r.at(21e6, '9', 1); r.at(21e6 + 2_400_000, '9', 0); r.run(25); near(r.out('m').angle as number, 180, 1, '2400 us');
});

test('stepper: four full steps forward and back', () => {
  const r = rig([{ id: 'm', type: 'stepper-motor' }], [['u:8', 'm:A-'], ['u:9', 'm:A+'], ['u:10', 'm:B+'], ['u:11', 'm:B-']]);
  const coil = (am: number, ap: number, bp: number, bm: number) => { r.set('8', am as 0 | 1); r.set('9', ap as 0 | 1); r.set('10', bp as 0 | 1); r.set('11', bm as 0 | 1); };
  const seq: [number, number, number, number][] = [[0, 1, 0, 1], [0, 1, 1, 0], [1, 0, 1, 0], [1, 0, 0, 1]];     // one coil pair at a time, wave of full steps
  coil(...seq[0]); const start = r.out('m').angle as number;
  for (let i = 1; i <= 4; i++) coil(...seq[i % 4]);
  near((r.out('m').angle as number) - start, 7.2, 0.01, 'four steps of 1.8 degrees');
  for (let i = 3; i >= 0; i--) coil(...seq[i]);
  near((r.out('m').angle as number) - start, 0, 0.01, 'and back');
});

test('IR receiver: a remote key arrives as an NEC frame', () => {
  const r = rig([{ id: 'ir', type: 'ir-receiver' }], [...['VCC', 'GND'].map((p) => [`ir:${p}`, p === 'VCC' ? 'u:5V' : 'u:GND'] as [string, string]), ['ir:DAT', 'u:2']]);
  r.run(1); assert.equal(r.inputs['2'], 1, 'idle high');
  r.control('ir', 'command', 0x68); r.run(120);
  const e = r.edgesOf('2'); const t0 = e.find(([l]) => l === 0)![1];
  const edges = e.filter(([, t]) => t >= t0);
  near(edges[1][1] - edges[0][1], 9e6, 1e3, 'leading mark'); near(edges[2][1] - edges[1][1], 4.5e6, 1e3, 'leading space');
  // decode: each bit is a 562.5 us mark, then a short (0) or long (1) space
  const bits: number[] = [];
  for (let i = 2; i + 2 < edges.length && bits.length < 32; i += 2) bits.push(edges[i + 2][1] - edges[i + 1][1] > 1e6 ? 1 : 0);
  const byte = (n: number) => bits.slice(n * 8, n * 8 + 8).reduce((a, b, i) => a | (b << i), 0);
  assert.deepEqual([byte(0), byte(1), byte(2), byte(3)], [0x00, 0xff, 0x68, 0x97]);
  assert.equal(r.inputs['2'], 1, 'back to idle');
});

test('HX711: 24 bits are clocked out, most significant first', () => {
  const r = rig([{ id: 'w', type: 'hx711' }], [...power('w'), ['w:DT', 'u:3'], ['u:2', 'w:SCK']]);
  r.set('2', 0); r.control('w', 'reading', 0x123456); r.run(2);
  assert.equal(r.inputs['3'], 0, 'DT low means a reading is ready');
  let v = 0;
  for (let i = 0; i < 24; i++) { r.set('2', 1); v = (v << 1) | (r.inputs['3'] as number); r.set('2', 0); }
  r.set('2', 1); r.set('2', 0);
  assert.equal(v, 0x123456);
  assert.equal(r.inputs['3'], 1, 'DT high until the next reading');
  r.run(5); assert.equal(r.inputs['3'], 0);
});

test('LCD on four data wires: text written by the usual init sequence shows', () => {
  const r = rig([{ id: 'l', type: 'lcd1602' }], [['u:12', 'l:RS'], ['u:11', 'l:E'], ['u:5', 'l:D4'], ['u:4', 'l:D5'], ['u:3', 'l:D6'], ['u:2', 'l:D7'], ['l:VDD', 'u:5V'], ['l:VSS', 'u:GND'], ['l:RW', 'u:GND']]);
  const nibble = (n: number, rs: 0 | 1) => { r.set('12', rs); r.set('5', (n & 1) as 0 | 1); r.set('4', ((n >> 1) & 1) as 0 | 1); r.set('3', ((n >> 2) & 1) as 0 | 1); r.set('2', ((n >> 3) & 1) as 0 | 1); r.set('11', 1); r.set('11', 0); };
  const send = (b: number, rs: 0 | 1) => { nibble(b >> 4, rs); nibble(b & 15, rs); };
  for (const n of [3, 3, 3, 2]) nibble(n, 0);                    // what LiquidCrystal does to enter 4-bit mode
  for (const c of [0x28, 0x0c, 0x06, 0x01]) send(c, 0);
  for (const ch of 'Hi Shibo') send(ch.charCodeAt(0), 1);
  send(0xc0, 0); for (const ch of 'line 2') send(ch.charCodeAt(0), 1);
  assert.equal(r.out('l').text, 'Hi Shibo        \nline 2          ');
  const shown = r.show('l');
  assert.equal((shown.characters as number[]).length, 32);
  assert.equal(String.fromCharCode(...(shown.characters as number[]).slice(0, 8)), 'Hi Shibo');
  send(0x01, 0);
  assert.equal(r.out('l').text, ' '.repeat(16) + '\n' + ' '.repeat(16));
});

test('LCD on I2C: a sketch using Wire and a PCF8574 backpack prints on a 20x4', async () => {
  const s = await fw(`#include <Wire.h>
    const uint8_t A = 0x27, BL = 8, EN = 4, RS = 1;
    void out(uint8_t v) { Wire.beginTransmission(A); Wire.write(v | BL); Wire.endTransmission(); }
    void nib(uint8_t n, uint8_t rs) { out((n << 4) | rs | EN); out((n << 4) | rs); }
    void send(uint8_t b, uint8_t rs) { nib(b >> 4, rs); nib(b & 15, rs); }
    void setup() { Wire.begin(); delay(50); nib(3, 0); delay(5); nib(3, 0); nib(3, 0); nib(2, 0);
      send(0x28, 0); send(0x0c, 0); send(0x06, 0); send(0x01, 0); delay(2);
      for (const char *p = "Shibo I2C"; *p; p++) send(*p, RS);
      send(0x80 | 0x54, 0); for (const char *p = "row four"; *p; p++) send(*p, RS); }
    void loop() {}`,
    [{ id: 'l', type: 'lcd2004', attrs: { pins: 'i2c' } }], [...power('l'), ['l:SDA', 'u:A4'], ['l:SCL', 'u:A5']]);
  s.run(300);
  const rows = (s.out('l').text as string).split('\n');
  assert.equal(rows.length, 4);
  assert.equal(rows[0], 'Shibo I2C'.padEnd(20)); assert.equal(rows[3], 'row four'.padEnd(20));
  assert.equal(s.show('l').backlight, true);
});

test('OLED: the Adafruit SSD1306 library draws pixels where the sketch put them', async () => {
  const s = await fw(`#include <Wire.h>
    #include <Adafruit_GFX.h>
    #include <Adafruit_SSD1306.h>
    Adafruit_SSD1306 d(128, 64, &Wire, -1);
    void setup() { Serial.begin(9600); if (!d.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { Serial.println("no display"); for (;;); }
      d.clearDisplay(); d.drawPixel(10, 3, SSD1306_WHITE); d.fillRect(100, 40, 8, 8, SSD1306_WHITE); d.display(); Serial.println("drawn"); }
    void loop() {}`,
    [{ id: 'o', type: 'ssd1306' }], [['o:VIN', 'u:5V'], ['o:GND', 'u:GND'], ['o:DATA', 'u:A4'], ['o:CLK', 'u:A5']]);
  s.run(1500);
  assert.match(s.serial(), /drawn/);
  assert.equal(s.out('o').on, true);
  assert.equal(s.out('o').pixels, 1 + 64);
  const fb = s.show('o').fb as string;
  assert.equal(fb.length, 2048);
  const bit = (x: number, y: number) => (parseInt(fb.substr((Math.floor(y / 8) * 128 + x) * 2, 2), 16) >> (y % 8)) & 1;
  assert.deepEqual([bit(10, 3), bit(11, 3), bit(100, 40), bit(107, 47), bit(108, 48)], [1, 0, 1, 1, 0]);
});

test('NeoPixels: colours are decoded from the data line timing', () => {
  const r = rig([{ id: 'n', type: 'led-ring', attrs: { pixels: '4' } }, { id: 'one', type: 'neopixel' }], [['u:6', 'n:DIN'], ['n:VCC', 'u:5V'], ['n:GND', 'u:GND'], ['u:7', 'one:DIN'], ['one:VDD', 'u:5V'], ['one:VSS', 'u:GND']]);
  let t = 1e6;
  const sendTo = (pin: string, bytes: number[]) => { for (const b of bytes) for (let i = 7; i >= 0; i--) { const one = (b >> i) & 1; r.at(t, pin, 1); r.at(t + (one ? 812 : 312), pin, 0); t += 1250; } };
  sendTo('6', [0, 255, 0, /* pixel 0: G,R,B = red */ 128, 0, 0, /* pixel 1: half green */ 0, 0, 255 /* pixel 2: blue */]);
  t += 1e6; sendTo('7', [16, 32, 64]);
  r.run(3);
  assert.deepEqual((r.show('n').pixels as number[]), [255, 0, 0, 0, 128, 0, 0, 0, 255, 0, 0, 0]);
  const one = r.out('one'); near(one.r as number, 32 / 255, 0.01); near(one.g as number, 16 / 255, 0.01); near(one.b as number, 64 / 255, 0.01);
});

test('clock and accelerometer answer on I2C as sketches expect', async () => {
  const s = await fw(`#include <Wire.h>
    uint8_t rd(uint8_t a, uint8_t reg) { Wire.beginTransmission(a); Wire.write(reg); Wire.endTransmission(false); Wire.requestFrom(a, (uint8_t)1); return Wire.read(); }
    int16_t rd16(uint8_t a, uint8_t reg) { Wire.beginTransmission(a); Wire.write(reg); Wire.endTransmission(false); Wire.requestFrom(a, (uint8_t)2); int16_t v = Wire.read() << 8; return v | Wire.read(); }
    void setup() { Serial.begin(9600); Wire.begin();
      Wire.beginTransmission(0x69); Wire.write(0x6B); Wire.write(0); Wire.endTransmission(); }
    void loop() { delay(1000);
      Serial.print(rd(0x68, 0), HEX); Serial.print(' '); Serial.print(rd(0x68, 6), HEX); Serial.print(' ');
      Serial.print(rd(0x69, 0x75), HEX); Serial.print(' '); Serial.print(rd16(0x69, 0x3F)); Serial.print(' '); Serial.println(rd16(0x69, 0x3B)); }`,
    [{ id: 'c', type: 'ds1307' }, { id: 'a', type: 'mpu6050' }],
    [['c:5V', 'u:5V'], ['c:GND', 'u:GND'], ['c:SDA', 'u:A4'], ['c:SCL', 'u:A5'], ...power('a'), ['a:SDA', 'u:A4'], ['a:SCL', 'u:A5'], ['a:AD0', 'u:5V']]);
  s.run(3100);
  const [sec, year, who, az, ax] = s.lines().at(-1)!.split(' ');
  assert.equal(sec, '3', 'three seconds on the clock'); assert.equal(year, '26');
  assert.equal(who, '68'); assert.equal(az, '16384', '1 g on Z at rest'); assert.equal(ax, '0');
  s.control('a', 'ax', -0.5); s.run(1000);
  assert.equal(s.lines().at(-1)!.split(' ')[4], '-8192');
});
