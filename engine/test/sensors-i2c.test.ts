// I2C sensors, driven by real sketches that use Wire the way the libraries do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fw, power } from './helpers/fw.ts';
import { rig } from './helpers/rig.ts';

const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
const nums = (line: string | undefined) => (line ?? '').trim().split(/\s+/).map(Number);
const i2c = (id: string, vcc = 'VCC'): [string, string][] => [...power(id, vcc), [`${id}:SDA`, 'u:A4'], [`${id}:SCL`, 'u:A5']];

const WIRE = `
#include <Wire.h>
uint8_t rd8(uint8_t a, uint8_t r) { Wire.beginTransmission(a); Wire.write(r); Wire.endTransmission(); Wire.requestFrom(a, (uint8_t)1); return Wire.read(); }
void wr8(uint8_t a, uint8_t r, uint8_t v) { Wire.beginTransmission(a); Wire.write(r); Wire.write(v); Wire.endTransmission(); }
void rdn(uint8_t a, uint8_t r, uint8_t *b, uint8_t n) { Wire.beginTransmission(a); Wire.write(r); Wire.endTransmission(); Wire.requestFrom(a, n); for (uint8_t i = 0; i < n; i++) b[i] = Wire.read(); }
`;

test('BMP280 and BME280: Bosch compensation in a sketch gives back the temperature, pressure and humidity', async () => {
  const s = await fw(WIRE + `
    uint16_t T1, P1; int16_t T2, T3, P2, P3, P4, P5, P6, P7, P8, P9; uint8_t H1, H3; int16_t H2, H4, H5; int8_t H6; int32_t t_fine;
    void cal(uint8_t a) { uint8_t b[24]; rdn(a, 0x88, b, 24); uint16_t w[12]; for (int i = 0; i < 12; i++) w[i] = b[2*i] | (b[2*i+1] << 8);
      T1 = w[0]; T2 = w[1]; T3 = w[2]; P1 = w[3]; P2 = w[4]; P3 = w[5]; P4 = w[6]; P5 = w[7]; P6 = w[8]; P7 = w[9]; P8 = w[10]; P9 = w[11];
      H1 = rd8(a, 0xA1); uint8_t h[7]; rdn(a, 0xE1, h, 7); H2 = h[0] | (h[1] << 8); H3 = h[2]; H4 = (h[3] << 4) | (h[4] & 15); H5 = (h[5] << 4) | (h[4] >> 4); H6 = h[6]; }
    int32_t compT(int32_t adc) { int32_t v1 = ((((adc>>3) - ((int32_t)T1<<1))) * ((int32_t)T2)) >> 11;
      int32_t v2 = (((((adc>>4) - ((int32_t)T1)) * ((adc>>4) - ((int32_t)T1))) >> 12) * ((int32_t)T3)) >> 14; t_fine = v1 + v2; return (t_fine * 5 + 128) >> 8; }
    uint32_t compP(int32_t adc) { int64_t v1, v2, p; v1 = ((int64_t)t_fine) - 128000; v2 = v1 * v1 * (int64_t)P6; v2 = v2 + ((v1*(int64_t)P5)<<17); v2 = v2 + (((int64_t)P4)<<35);
      v1 = ((v1 * v1 * (int64_t)P3)>>8) + ((v1 * (int64_t)P2)<<12); v1 = (((((int64_t)1)<<47)+v1))*((int64_t)P1)>>33; if (v1 == 0) return 0;
      p = 1048576-adc; p = (((p<<31)-v2)*3125)/v1; v1 = (((int64_t)P9) * (p>>13) * (p>>13)) >> 25; v2 = (((int64_t)P8) * p) >> 19;
      p = ((p + v1 + v2) >> 8) + (((int64_t)P7)<<4); return (uint32_t)p; }
    uint32_t compH(int32_t adc) { int32_t v = (t_fine - ((int32_t)76800));
      v = (((((adc << 14) - (((int32_t)H4) << 20) - (((int32_t)H5) * v)) + ((int32_t)16384)) >> 15) * (((((((v * ((int32_t)H6)) >> 10) * (((v * ((int32_t)H3)) >> 11) + ((int32_t)32768))) >> 10) + ((int32_t)2097152)) * ((int32_t)H2) + 8192) >> 14));
      v = (v - (((((v >> 15) * (v >> 15)) >> 7) * ((int32_t)H1)) >> 4)); v = (v < 0 ? 0 : v); v = (v > 419430400 ? 419430400 : v); return (uint32_t)(v>>12); }
    void show(uint8_t a) { uint8_t b[8]; cal(a); rdn(a, 0xF7, b, 8);
      int32_t ap = ((uint32_t)b[0] << 12) | ((uint32_t)b[1] << 4) | (b[2] >> 4), at = ((uint32_t)b[3] << 12) | ((uint32_t)b[4] << 4) | (b[5] >> 4), ah = ((uint16_t)b[6] << 8) | b[7];
      Serial.print(rd8(a, 0xD0), HEX); Serial.print(' '); Serial.print(compT(at)); Serial.print(' '); Serial.print(compP(ap) / 256); Serial.print(' '); Serial.print(compH(ah) / 1024.0); Serial.print(' '); }
    void setup() { Serial.begin(115200); Wire.begin(); for (uint8_t a = 0x76; a <= 0x77; a++) { wr8(a, 0xF2, 0x01); wr8(a, 0xF4, 0x27); } }
    void loop() { show(0x76); show(0x77); Serial.println(); delay(50); }`,
    [{ id: 'bmp', type: 'bmp280' }, { id: 'bme', type: 'bme280' }], [...i2c('bmp'), ...i2c('bme'), ['bme:SDO', 'u:5V']]);
  s.run(200);
  let v = s.lines().at(-1)!.trim().split(' ');
  assert.equal(v[0], '58'); assert.equal(v[4], '60', 'chip ids');
  near(+v[1], 2400, 1, 'BMP280 °C x100'); near(+v[2], 101325, 2, 'BMP280 Pa');
  near(+v[5], 2400, 1, 'BME280 °C x100'); near(+v[6], 101325, 2, 'BME280 Pa'); near(+v[7], 40, 0.1, 'BME280 %RH');
  s.control('bmp', 'temperature', -12.3); s.control('bmp', 'pressure', 850.5);
  s.control('bme', 'temperature', 31.7); s.control('bme', 'pressure', 1050); s.control('bme', 'humidity', 77.7);
  s.run(150); v = s.lines().at(-1)!.trim().split(' ');
  near(+v[1], -1230, 1); near(+v[2], 85050, 2); near(+v[5], 3170, 1); near(+v[6], 105000, 2); near(+v[7], 77.7, 0.1);
});

test('BMP280: sleeps until told to measure; forced mode measures once', () => {
  const r = rig([{ id: 'b', type: 'bmp280' }], i2c('b'));
  r.run(1);
  const bus = r.i2c();
  const read = (reg: number, n: number) => { bus.connect(0x76, true); bus.write(reg); bus.connect(0x76, false); const out = Array.from({ length: n }, () => bus.read(true)); bus.stop(); return out; };
  const write = (reg: number, v: number) => { bus.connect(0x76, true); bus.write(reg); bus.write(v); bus.stop(); };
  assert.deepEqual(read(0xfa, 3), [0x80, 0, 0], 'reset value before any measurement');
  write(0xf4, 0x25);                                    // forced, x1 oversampling
  const a = read(0xfa, 3); assert.notDeepEqual(a, [0x80, 0, 0]);
  assert.equal(read(0xf4, 1)[0] & 3, 0, 'back to sleep');
  r.control('b', 'temperature', 50); assert.deepEqual(read(0xfa, 3), a, 'asleep: the old reading stays');
  assert.equal(bus.connect(0x77, true), false, 'SDO low: 0x77 does not answer');
});

test('SHT31 (CRC-checked) and BH1750 read back what the sliders say', async () => {
  const s = await fw(WIRE + `
    uint8_t crc(uint8_t *d) { uint8_t c = 0xFF; for (int i = 0; i < 2; i++) { c ^= d[i]; for (int b = 0; b < 8; b++) c = c & 0x80 ? (c << 1) ^ 0x31 : c << 1; } return c; }
    void setup() { Serial.begin(115200); Wire.begin(); Wire.beginTransmission(0x23); Wire.write(0x10); Wire.endTransmission(); }
    void loop() {
      Wire.beginTransmission(0x44); Wire.write(0x24); Wire.write(0x00); Wire.endTransmission(); delay(20);
      uint8_t d[6]; Wire.requestFrom(0x44, 6); for (int i = 0; i < 6; i++) d[i] = Wire.read();
      bool ok = crc(d) == d[2] && crc(d + 3) == d[5];
      float t = -45 + 175.0 * (uint16_t)((d[0] << 8) | d[1]) / 65535.0, h = 100.0 * (uint16_t)((d[3] << 8) | d[4]) / 65535.0;
      Wire.requestFrom(0x23, 2); uint16_t raw = Wire.read() << 8; raw |= Wire.read();
      Serial.print(ok); Serial.print(' '); Serial.print(t); Serial.print(' '); Serial.print(h); Serial.print(' '); Serial.println(raw / 1.2); delay(100); }`,
    [{ id: 'sht', type: 'sht31' }, { id: 'lux', type: 'bh1750' }], [...i2c('sht', 'VIN'), ...i2c('lux')]);
  s.run(400);
  let v = nums(s.lines().at(-1));
  assert.equal(v[0], 1, 'CRCs check'); near(v[1], 24, 0.02); near(v[2], 40, 0.02); near(v[3], 300, 1);
  s.control('sht', 'temperature', -5.5); s.control('sht', 'humidity', 88.8); s.control('lux', 'lux', 12000);
  s.run(300); v = nums(s.lines().at(-1));
  near(v[1], -5.5, 0.02); near(v[2], 88.8, 0.02); near(v[3], 12000, 1);
});

test('ADXL345 and both compasses report the field and tilt that were set', async () => {
  const s = await fw(WIRE + `
    void setup() { Serial.begin(115200); Wire.begin();
      wr8(0x53, 0x31, 0x0B); wr8(0x53, 0x2D, 0x08);             // full resolution, +-16 g; measure
      wr8(0x1E, 0x00, 0x70); wr8(0x1E, 0x01, 0x20); wr8(0x1E, 0x02, 0x00);
      wr8(0x0D, 0x0B, 0x01); wr8(0x0D, 0x09, 0x1D); }           // QMC5883L: 8 G range, continuous
    void loop() { uint8_t b[6];
      Serial.print(rd8(0x53, 0x00), HEX); rdn(0x53, 0x32, b, 6);
      for (int i = 0; i < 3; i++) { Serial.print(' '); Serial.print((int16_t)(b[2*i] | (b[2*i+1] << 8)) / 256.0); }
      Serial.print(' '); Serial.print((char)rd8(0x1E, 10)); rdn(0x1E, 0x03, b, 6);
      int16_t x = (b[0] << 8) | b[1], z = (b[2] << 8) | b[3], y = (b[4] << 8) | b[5];
      Serial.print(' '); Serial.print(atan2(y, x) * 180 / PI); Serial.print(' '); Serial.print(z / 1090.0);
      rdn(0x0D, 0x00, b, 6); x = b[0] | (b[1] << 8); y = b[2] | (b[3] << 8);
      Serial.print(' '); Serial.print(rd8(0x0D, 0x0D), HEX); Serial.print(' '); Serial.println(atan2(y, x) * 180 / PI); delay(50); }`,
    [{ id: 'acc', type: 'adxl345' }, { id: 'hmc', type: 'hmc5883l' }, { id: 'qmc', type: 'qmc5883l' }], [...i2c('acc'), ...i2c('hmc'), ...i2c('qmc')]);
  s.run(150);
  let v = s.lines().at(-1)!.trim().split(' ');
  assert.equal(v[0], 'E5'); near(+v[1], 0, 0.01); near(+v[3], 1, 0.01); assert.equal(v[4], 'H'); near(+v[5], 0, 0.5); near(+v[6], -0.4, 0.01); assert.equal(v[7], 'FF');
  s.control('acc', 'ax', -2.5); s.control('acc', 'az', 0.5); s.control('hmc', 'heading', 120); s.control('qmc', 'heading', 300);
  s.run(150); v = s.lines().at(-1)!.trim().split(' ');
  near(+v[1], -2.5, 0.01); near(+v[3], 0.5, 0.01); near(+v[5], 120, 0.5); near(+v[8], -60, 0.5);
});

test('ADXL345: a 10-bit reading clips at the range; offsets add', () => {
  const r = rig([{ id: 'a', type: 'adxl345' }], i2c('a'));
  r.run(1);
  const bus = r.i2c();
  const write = (reg: number, v: number) => { bus.connect(0x53, true); bus.write(reg); bus.write(v); bus.stop(); };
  const x = () => { bus.connect(0x53, true); bus.write(0x32); bus.connect(0x53, false); const lo = bus.read(true), hi = bus.read(false); bus.stop(); return ((hi << 8) | lo) << 16 >> 16; };
  assert.equal(x(), 0, 'standby: nothing measured yet');
  write(0x31, 0x00); write(0x2d, 0x08); r.control('a', 'ax', 3);
  assert.equal(x(), 511, '+-2 g, 10 bits: 3 g clips');
  write(0x31, 0x01); assert.equal(x(), 384, '+-4 g: 128 per g');
  write(0x1e, 0x10); assert.equal(x(), Math.round((3 + 16 * 0.0156) * 128), 'an offset of 16 adds a quarter g');
});

test('INA219: the Adafruit 32 V, 2 A calibration reads volts and milliamps', async () => {
  const s = await fw(WIRE + `
    void w16(uint8_t r, uint16_t v) { Wire.beginTransmission(0x40); Wire.write(r); Wire.write(v >> 8); Wire.write(v & 255); Wire.endTransmission(); }
    int16_t r16(uint8_t r) { Wire.beginTransmission(0x40); Wire.write(r); Wire.endTransmission(); Wire.requestFrom(0x40, 2); int16_t v = Wire.read() << 8; return v | Wire.read(); }
    void setup() { Serial.begin(115200); Wire.begin(); w16(5, 4096); w16(0, 0x399F); }
    void loop() { w16(5, 4096); Serial.print(((r16(2) >> 3) * 4) * 0.001); Serial.print(' '); Serial.print(r16(1) * 0.01); Serial.print(' ');
      Serial.print(r16(4) / 10.0); Serial.print(' '); Serial.println(r16(3) * 2); delay(50); }`,
    [{ id: 'ina', type: 'ina219' }], i2c('ina'));
  s.run(150);
  let v = nums(s.lines().at(-1));
  near(v[0], 5, 0.004); near(v[1], 10, 0.01, 'shunt mV at 100 mA'); near(v[2], 100, 0.1); near(v[3], 500, 4, 'power mW');
  s.control('ina', 'bus', 12.34); s.control('ina', 'current', -750);
  s.run(150); v = nums(s.lines().at(-1));
  near(v[0], 12.34, 0.004); near(v[2], -750, 0.1); near(v[3], 9255, 10);
  s.control('ina', 'current', 3200); s.run(150); near(nums(s.lines().at(-1))[1], 320, 0.01, 'at the edge of the 320 mV range');
});

test('MAX30102: the FIFO fills at the sample rate with a pulsing IR signal while a finger is on it', () => {
  const r = rig([{ id: 'ox', type: 'max30102' }], i2c('ox', 'VIN'));
  r.run(1);
  const bus = r.i2c();
  const write = (reg: number, v: number) => { bus.connect(0x57, true); bus.write(reg); bus.write(v); bus.stop(); };
  const read = (reg: number, n: number) => { bus.connect(0x57, true); bus.write(reg); bus.connect(0x57, false); const out = Array.from({ length: n }, () => bus.read(true)); bus.stop(); return out; };
  assert.equal(read(0xff, 1)[0], 0x15, 'part id');
  // SparkFun's setup(0x1F, 4, 2, 100, 411, 4096): average 4, rollover, SpO2 mode, 100 sps, 18 bits.
  write(0x08, 0x50); write(0x09, 0x03); write(0x0a, 0x27); write(0x0c, 0x1f); write(0x0d, 0x1f);
  write(0x04, 0); write(0x05, 0); write(0x06, 0);
  const ir: number[] = [], red: number[] = [];
  const drain = () => {
    const [wr] = read(0x04, 1), [rd] = read(0x06, 1);
    const n = (wr - rd + 32) % 32;
    const b = read(0x07, n * 6);
    for (let i = 0; i < n; i++) { red.push((b[i * 6] << 16) | (b[i * 6 + 1] << 8) | b[i * 6 + 2]); ir.push((b[i * 6 + 3] << 16) | (b[i * 6 + 4] << 8) | b[i * 6 + 5]); }
  };
  r.run(1001); drain();
  near(ir.length, 25, 1, '25 averaged samples a second');
  assert.ok(Math.max(...ir) < 50000, 'no finger: little light comes back');
  r.control('ox', 'finger', 1); ir.length = 0; red.length = 0;
  for (let t = 1; t <= 10; t++) { r.run(1001 + t * 200); drain(); }
  assert.equal(ir.length, 50);
  const swing = Math.max(...ir) - Math.min(...ir);
  assert.ok(Math.min(...ir) > 90000 && swing > 200 && swing < 1000, `finger: about 100000 with a heartbeat swing (${swing})`);
  // Count beats: samples that drop through the middle of the swing. 72 bpm over 2 s is about 2.4 beats.
  const mid = (Math.max(...ir) + Math.min(...ir)) / 2;
  const beats = ir.slice(1).filter((x, i) => x < mid && ir[i] >= mid).length;
  assert.ok(beats >= 2 && beats <= 3, `${beats} beats`);
  // Over 32 unread samples with rollover on, the oldest are dropped and counted.
  r.run(5000); assert.ok(read(0x05, 1)[0] > 0, 'overflow counted');
});
