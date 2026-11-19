// Modules and communication parts, each driven by a real compiled sketch
// written the way a tutorial for the real part would write it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fw, power } from './helpers/fw.ts';
import { rig } from './helpers/rig.ts';

/** The last line the sketch finished printing. */
const last = (s: { serial(): string }) => s.serial().split(/\r?\n/).slice(0, -1).filter(Boolean).at(-1);

test('74HC595: shiftOut and SPI.transfer both set the latched outputs; two chips chain', async () => {
  const s = await fw(`#include <SPI.h>
    const int DATA = 4, CLOCK = 5, LATCH = 6;
    void show(byte a, byte b) { digitalWrite(LATCH, LOW); shiftOut(DATA, CLOCK, MSBFIRST, b); shiftOut(DATA, CLOCK, MSBFIRST, a); digitalWrite(LATCH, HIGH); }
    void setup() { Serial.begin(9600); pinMode(DATA, OUTPUT); pinMode(CLOCK, OUTPUT); pinMode(LATCH, OUTPUT); pinMode(10, OUTPUT); SPI.begin();
      show(0xA5, 0x3C); Serial.println(digitalRead(A0));
      digitalWrite(10, LOW); SPI.transfer(0x81); digitalWrite(10, HIGH); Serial.println("spi"); }
    void loop() {}`,
    [{ id: 'a', type: '74hc595' }, { id: 'b', type: '74hc595' }, { id: 'c', type: '74hc595' }],
    [...power('a'), ...power('b'), ...power('c'), ['a:MR', 'u:5V'], ['a:OE', 'u:GND'], ['b:MR', 'u:5V'], ['b:OE', 'u:GND'], ['c:MR', 'u:5V'], ['c:OE', 'u:GND'],
      ['a:DS', 'u:4'], ['a:SHCP', 'u:5'], ['a:STCP', 'u:6'], ['a:Q7S', 'b:DS'], ['b:SHCP', 'u:5'], ['b:STCP', 'u:6'], ['a:Q0', 'u:A0'],
      ['c:DS', 'u:11'], ['c:SHCP', 'u:13'], ['c:STCP', 'u:10']]);
  s.run(100);
  assert.deepEqual(s.out('a').values, [1, 0, 1, 0, 0, 1, 0, 1], 'first chip holds the byte sent last (0xA5)');
  assert.deepEqual(s.out('b').values, [0, 0, 1, 1, 1, 1, 0, 0], 'second chip holds the byte pushed through (0x3C)');
  assert.deepEqual(s.lines(), ['1', 'spi'], 'the board reads Q0 back');
  assert.deepEqual(s.out('c').values, [1, 0, 0, 0, 0, 0, 0, 1], 'hardware SPI (0x81)');
});

test('74HC595: OE high lets go of the outputs and MR low clears; unwired control pins are reported', () => {
  const r = rig([{ id: 'a', type: '74hc595' }], [['a:VCC', 'u:5V'], ['a:GND', 'u:GND'], ['a:DS', 'u:2'], ['a:SHCP', 'u:3'], ['a:STCP', 'u:4'], ['a:OE', 'u:5'], ['a:MR', 'u:6'], ['a:Q3', 'u:7']]);
  r.at(0, '5', 0); r.at(0, '6', 1); r.at(0, '2', 1);
  for (let i = 0; i < 4; i++) { r.at(1e5 + i * 1e5, '3', 1); r.at(1.5e5 + i * 1e5, '3', 0); }
  r.at(6e5, '4', 1); r.at(6.5e5, '4', 0);
  r.run(1); assert.equal(r.inputs['7'], 1, 'Q3 is high after four ones');
  r.at(1.1e6, '5', 1); r.run(1.2); assert.equal(r.inputs['7'], null, 'OE high: floating');
  r.at(1.3e6, '5', 0); r.at(1.4e6, '6', 0); r.at(1.5e6, '4', 1); r.run(2); assert.equal(r.inputs['7'], 0, 'MR then latch: cleared');
  const loose = rig([{ id: 'a', type: '74hc595' }], [['a:VCC', 'u:5V'], ['a:GND', 'u:GND']]);
  assert.equal(loose.circuit.warnings().filter((w) => /a pin (MR|OE) is not connected/.test(w)).length, 2);
});

test('74HC165: shiftIn reads the eight inputs; SPI reads them too', async () => {
  const s = await fw(`#include <SPI.h>
    const int LOAD = 7, CLK = 6, DATA = 5;
    void setup() { Serial.begin(9600); pinMode(LOAD, OUTPUT); pinMode(CLK, OUTPUT); pinMode(DATA, INPUT); pinMode(9, OUTPUT); digitalWrite(9, HIGH); SPI.begin(); }
    void loop() {
      digitalWrite(CLK, HIGH);       // shiftIn reads after each rising edge, so the clock idles high or D7 is lost
      digitalWrite(LOAD, LOW); delayMicroseconds(5); digitalWrite(LOAD, HIGH);
      byte v = shiftIn(DATA, CLK, MSBFIRST);
      digitalWrite(LOAD, LOW); delayMicroseconds(5); digitalWrite(LOAD, HIGH);
      digitalWrite(9, LOW); byte w = SPI.transfer(0); digitalWrite(9, HIGH);
      Serial.print(v, BIN); Serial.print(' '); Serial.println(w, BIN); delay(20); }`,
    [{ id: 'r', type: '74hc165' }, { id: 'k', type: '74hc165' }],
    [...power('r'), ['r:CE', 'u:GND'], ['r:PL', 'u:7'], ['r:CP', 'u:6'], ['r:Q7', 'u:5'], ['r:DS', 'u:GND'],
      ['r:D0', 'u:5V'], ['r:D1', 'u:GND'], ['r:D2', 'u:GND'], ['r:D3', 'u:5V'], ['r:D4', 'u:GND'], ['r:D5', 'u:GND'], ['r:D6', 'u:GND'], ['r:D7', 'u:5V'],
      ...power('k'), ['k:CE', 'u:9'], ['k:PL', 'u:7'], ['k:CP', 'u:13'], ['k:Q7', 'u:12'], ['k:DS', 'u:GND'],
      ...['D0', 'D2', 'D3', 'D4', 'D5', 'D6'].map((d) => [`k:${d}`, 'u:GND'] as [string, string]), ['k:D7', 'u:5V'], ['k:D1', 'u:5V']]);
  s.run(100);
  assert.equal(last(s), '10001001 10000010');
});

test('CD4051: the address pins pick which channel reaches the common pin', async () => {
  const s = await fw(`
    void setup() { Serial.begin(9600); pinMode(2, OUTPUT); pinMode(3, OUTPUT); pinMode(4, OUTPUT); }
    void loop() { for (int c = 0; c < 8; c++) { digitalWrite(2, c & 1); digitalWrite(3, (c >> 1) & 1); digitalWrite(4, (c >> 2) & 1); delay(1); Serial.print(analogRead(A0) / 100); Serial.print(c < 7 ? ' ' : '\\n'); } delay(10); }`,
    [{ id: 'm', type: 'cd4051' }, { id: 'p', type: 'potentiometer' }],
    [...power('m'), ['m:VEE', 'u:GND'], ['m:INH', 'u:GND'], ['m:A', 'u:2'], ['m:B', 'u:3'], ['m:C', 'u:4'], ['m:COM', 'u:A0'],
      ['m:Y0', 'u:GND'], ['m:Y1', 'u:5V'], ['m:Y5', 'p:SIG'], ['p:VCC', 'u:5V'], ['p:GND', 'u:GND'], ['m:Y2', 'u:GND'], ['m:Y3', 'u:GND'], ['m:Y4', 'u:GND'], ['m:Y6', 'u:GND'], ['m:Y7', 'u:5V']]);
  s.control('p', 'value', 512);
  s.run(60);
  assert.equal(last(s), '0 10 0 0 0 5 0 10');
});

test('74HC165: with the clock idling low, shiftIn loses D7 as on the real chip', () => {
  const r = rig([{ id: 'r', type: '74hc165' }], [['r:VCC', 'u:5V'], ['r:GND', 'u:GND'], ['r:CE', 'u:GND'], ['r:PL', 'u:2'], ['r:CP', 'u:3'], ['r:Q7', 'u:4'], ['r:D7', 'u:5V'], ['r:D6', 'u:GND'], ['r:DS', 'u:GND']]);
  r.at(0, '3', 0); r.at(0, '2', 0); r.at(1e5, '2', 1);
  r.run(0.2); assert.equal(r.inputs['4'], 1, 'D7 shows on Q7 after loading');
  r.at(3e5, '3', 1); r.run(0.4); assert.equal(r.inputs['4'], 0, 'one rising edge later it is D6');
});

const I2C = (id: string): [string, string][] => [[`${id}:SDA`, 'u:A4'], [`${id}:SCL`, 'u:A5']];

test('24C32 EEPROM: page writes wrap inside a page, the chip is silent while storing, reads run on', async () => {
  const s = await fw(`#include <Wire.h>
    const byte EE = 0x51;
    void put(unsigned a, const char* t) { Wire.beginTransmission(EE); Wire.write(a >> 8); Wire.write(a & 255); while (*t) Wire.write(*t++); Wire.endTransmission(); }
    void setup() { Serial.begin(9600); Wire.begin();
      put(0x0FE, "AB");                                          // in page 0x0E0-0x0FF: A at 0xFE, B at 0xFF
      Wire.beginTransmission(EE); Serial.println(Wire.endTransmission());   // still storing: no answer (2)
      delay(6);
      put(0x11E, "wxyz");                                       // y and z wrap to 0x100 and 0x101
      delay(6);
      Wire.beginTransmission(EE); Wire.write(0x01); Wire.write(0x00); Wire.endTransmission();
      Wire.requestFrom(EE, (byte)2); while (Wire.available()) Serial.write(Wire.read()); Serial.println();
      Wire.beginTransmission(EE); Wire.write(0x00); Wire.write(0xFE); Wire.endTransmission();
      Wire.requestFrom(EE, (byte)3); Serial.print((char)Wire.read()); Serial.print((char)Wire.read()); Serial.println(Wire.read(), HEX); }
    void loop() {}`,
    [{ id: 'e', type: 'eeprom-24c32' }], [...power('e'), ...I2C('e'), ['e:A0', 'u:5V'], ['e:WP', 'u:GND']]);
  s.run(150);
  assert.deepEqual(s.lines(), ['2', 'yz', 'AB79'], 'a read runs on past the page end, into the y at 0x100');
});

test('DS3231: RTClib sees lost power, sets the time, keeps it, and reads the temperature', async () => {
  const s = await fw(`#include <RTClib.h>
    RTC_DS3231 rtc;
    void setup() { Serial.begin(9600);
      if (!rtc.begin()) { Serial.println("no rtc"); return; }
      Serial.println(rtc.lostPower() ? "lost" : "kept");
      rtc.adjust(DateTime(2024, 2, 29, 23, 59, 58));
      Serial.println(rtc.lostPower() ? "lost" : "kept"); }
    void loop() { delay(1000); DateTime n = rtc.now();
      Serial.print(n.year()); Serial.print('-'); Serial.print(n.month()); Serial.print('-'); Serial.print(n.day()); Serial.print(' ');
      Serial.print(n.hour()); Serial.print(':'); Serial.print(n.minute()); Serial.print(':'); Serial.print(n.second()); Serial.print(' ');
      Serial.println(rtc.getTemperature()); }`,
    [{ id: 'c', type: 'ds3231' }], [...power('c'), ...I2C('c')]);
  s.control('c', 'temperature', 31.25);
  s.run(3300);
  const l = s.lines();
  assert.deepEqual(l.slice(0, 2), ['lost', 'kept']);
  assert.equal(l[2], '2024-2-29 23:59:59 31.25');
  assert.equal(last(s), '2024-3-1 0:0:1 31.25', 'leap day rolls into March');
});

test('DS3231: alarm 1 sets its flag and pulls INT/SQW low', async () => {
  const s = await fw(`#include <RTClib.h>
    RTC_DS3231 rtc;
    void setup() { Serial.begin(9600); pinMode(2, INPUT_PULLUP); rtc.begin();
      rtc.adjust(DateTime(2025, 6, 1, 12, 0, 0)); rtc.disable32K(); rtc.clearAlarm(1);
      rtc.writeSqwPinMode(DS3231_OFF);
      rtc.setAlarm1(DateTime(2025, 6, 1, 12, 0, 2), DS3231_A1_Second); }
    void loop() { Serial.print(rtc.alarmFired(1)); Serial.println(digitalRead(2)); delay(500); }`,
    [{ id: 'c', type: 'ds3231' }], [...power('c'), ...I2C('c'), ['c:SQW', 'u:2']]);
  s.run(1200); assert.equal(last(s), '01');
  s.run(1500); assert.equal(last(s), '10', 'fired at 12:00:02');
});

test('PCF8574: writes light LEDs, reads see a pressed button, INT falls on a change', async () => {
  const s = await fw(`#include <Wire.h>
    void setup() { Serial.begin(9600); Wire.begin(); pinMode(2, INPUT_PULLUP);
      Wire.beginTransmission(0x23); Wire.write(0xF0 | 0x05); Wire.endTransmission(); }      // P0 and P2 high, P1 and P3 low; P4-P7 inputs
    void loop() { Wire.requestFrom(0x23, 1); byte v = Wire.read(); Serial.print(v, BIN); Serial.print(' '); Serial.println(digitalRead(2)); delay(20); }`,
    [{ id: 'x', type: 'pcf8574' }, { id: 'b', type: 'pushbutton' }],
    [...power('x'), ...I2C('x'), ['x:A0', 'u:5V'], ['x:A1', 'u:5V'], ['x:A2', 'u:GND'], ['x:INT', 'u:2'], ['x:P0', 'u:8'], ['x:P1', 'u:9'], ['x:P5', 'b:1.l'], ['b:2.l', 'u:GND']]);
  s.run(50);
  assert.equal(last(s), '11110101 1');
  s.control('b', 'pressed', 1);
  s.run(2); assert.equal(s.circuit.outputs().x && (s.circuit as any).nets.level('u:2'), 0, 'INT low until the next read');
  s.run(50); assert.equal(last(s), '11010101 1', 'P5 reads low');
});

test('each custom drawing has exactly the pins of its part', async () => {
  const { readFileSync } = await import('node:fs');
  const { library } = await import('../src/parts/index.ts');
  const src = readFileSync(new URL('../../app/src/drawings/modules/index.ts', import.meta.url), 'utf8');
  const drawn = [...src.matchAll(/(?:dip|breakout)\('shibo-([\w-]+)'[^[]*\[([^\]]*)\]/g)];
  assert.ok(drawn.length >= 3);
  for (const [, type, list] of drawn) {
    const pins = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(library[type], `${type} is a part`);
    assert.deepEqual([...pins].sort(), [...library[type].pins].sort(), type);
    assert.equal(library[type].ui!.tag, `shibo-${type}`);
  }
});

/** The TFT frame the page is sent, back as 240x320 RGB565 values. */
function unpack(frame: string): Uint16Array {
  const pairs = new Uint16Array(new Uint8Array(Buffer.from(frame, 'base64')).buffer), px = new Uint16Array(240 * 320);
  let at = 0;
  for (let i = 0; i < pairs.length; i += 2) { px.fill(pairs[i + 1], at, at + pairs[i]); at += pairs[i]; }
  assert.equal(at, px.length, 'the frame covers the whole screen');
  return px;
}

test('ILI9341: Adafruit_ILI9341 fills, draws in every rotation, and answers its status reads', async () => {
  const s = await fw(`#include <Adafruit_ILI9341.h>
    Adafruit_ILI9341 tft(10, 9);
    void setup() { Serial.begin(115200); tft.begin();
      Serial.println(tft.readcommand8(ILI9341_RDMODE), HEX); Serial.println(tft.readcommand8(ILI9341_RDMADCTL), HEX);
      tft.fillScreen(ILI9341_BLUE);
      tft.fillRect(10, 20, 30, 40, ILI9341_RED);
      tft.setRotation(1); tft.drawPixel(0, 0, ILI9341_GREEN);
      tft.setRotation(2); tft.drawPixel(0, 0, ILI9341_WHITE);
      tft.setRotation(3); tft.drawPixel(0, 0, ILI9341_YELLOW);
      Serial.println("done"); }
    void loop() {}`,
    [{ id: 't', type: 'ili9341' }], [...power('t'), ['t:LED', 'u:5V'], ['t:CS', 'u:10'], ['t:D/C', 'u:9'], ['t:MOSI', 'u:11'], ['t:SCK', 'u:13'], ['t:MISO', 'u:12']]);
  const t0 = Date.now();
  s.run(1500);
  const wall = Date.now() - t0;
  assert.deepEqual(s.lines(), ['9C', '48', 'done']);
  const d = s.show('t'); assert.equal(d.on, true); assert.equal(d.backlight, true);
  const px = unpack(d.frame as string), at = (x: number, y: number) => px[y * 240 + x];
  assert.equal(at(120, 200), 0x001f, 'blue background');
  assert.equal(at(10, 20), 0xf800); assert.equal(at(39, 59), 0xf800); assert.equal(at(40, 59), 0x001f, 'red box is 30 by 40');
  assert.equal(at(239, 0), 0x07e0, 'rotation 1 (landscape) starts at the top right');
  assert.equal(at(239, 319), 0xffff, 'rotation 2 starts at the bottom right');
  assert.equal(at(0, 319), 0xffe0, 'rotation 3 starts at the bottom left');
  console.log(`ILI9341 test: 1.5 s simulated in ${wall} ms`);
});

test('microSD: the SD library reads a file the card starts with, writes and appends a new one, and lists them', async () => {
  const s = await fw(`#include <SPI.h>
    #include <SD.h>
    void setup() { Serial.begin(115200);
      if (!SD.begin(4)) { Serial.println("no card"); return; }
      File f = SD.open("hello.txt"); while (f.available()) Serial.write(f.read()); f.close(); Serial.println();
      f = SD.open("log.txt", FILE_WRITE); for (int i = 0; i < 100; i++) f.println(i); f.close();
      f = SD.open("log.txt", FILE_WRITE); f.print("end"); f.close();
      f = SD.open("log.txt"); Serial.println(f.size()); f.seek(382); while (f.available()) Serial.write(f.read()); f.close(); Serial.println();
      Serial.println(SD.exists("log.txt")); SD.remove("hello.txt"); Serial.println(SD.exists("hello.txt"));
      Sd2Card card; card.init(SPI_HALF_SPEED, 4); Serial.println(card.type()); Serial.println(card.cardSize()); }
    void loop() {}`,
    [{ id: 'sd', type: 'microsd', attrs: { files: '{"HELLO.TXT":"Hi from the card"}' } }],
    [...power('sd'), ['sd:CS', 'u:4'], ['sd:DI', 'u:11'], ['sd:DO', 'u:12'], ['sd:SCK', 'u:13']]);
  s.run(1200);
  // 0..9 are 3 bytes each with CRLF, 10..99 are 4: 30 + 360 = 390, then "end".
  assert.deepEqual(s.lines(), ['Hi from the card', '393', '98', '99', 'end', '1', '0', '3', '5120'].join('\n').split(/\r?\n/).filter(Boolean));
  assert.equal(s.show('sd').files, 'LOG.TXT (393 bytes)');
});

test('microSD: with the card taken out SD.begin fails', async () => {
  const s = await fw(`#include <SD.h>
    void setup() { Serial.begin(115200); Serial.println(SD.begin(4) ? "card" : "no card"); }
    void loop() {}`,
    [{ id: 'sd', type: 'microsd' }], [...power('sd'), ['sd:CS', 'u:4'], ['sd:DI', 'u:11'], ['sd:DO', 'u:12'], ['sd:SCK', 'u:13']]);
  s.control('sd', 'inserted', 0);
  s.run(3000);
  assert.deepEqual(s.lines(), ['no card']);
});
