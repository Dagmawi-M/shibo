// Sensors that answer over I2C, with the register maps their datasheets give,
// so the usual libraries (Adafruit, SparkFun) work against them unchanged.
import type { Device, PartCtx, PartDef } from '../part.ts';
import { clamp, crc8, i16, range, regBus, toggle, ui } from './sensors-kit.ts';
import { keep, powered } from './util.ts';

type Bus = NonNullable<Device['i2c']>;
/** A floating select or address pin counts as what the breakout's own resistor makes it. */
const high = (ctx: PartCtx, pin: string, floating: boolean) => { const l = ctx.level(pin); return l === null ? floating : l === 1; };

// ---------------- BMP280 and BME280 ----------------
// Calibration words from the BMP280 datasheet's worked example, and typical BME280 humidity words.
const CAL = { T1: 27504, T2: 26435, T3: -1000, P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7, P7: 15500, P8: -14600, P9: 6000 };
const HCAL = { H1: 75, H2: 362, H3: 0, H4: 313, H5: 50, H6: 30 };
const fl = Math.floor;

/** Bosch's integer compensation, exactly as their datasheet and the libraries do it. */
export function bmxTemp(adcT: number): { t: number; fine: number } {
  const v1 = fl(((fl(adcT / 8) - CAL.T1 * 2) * CAL.T2) / 2048);
  const d = fl(adcT / 16) - CAL.T1;
  const v2 = fl((fl((d * d) / 4096) * CAL.T3) / 16384);
  const fine = v1 + v2;
  return { fine, t: fl((fine * 5 + 128) / 256) };
}
export function bmxPress(adcP: number, fine: number): number {
  const B = BigInt;
  let v1 = B(fine) - 128000n;
  let v2 = v1 * v1 * B(CAL.P6);
  v2 += (v1 * B(CAL.P5)) << 17n;
  v2 += B(CAL.P4) << 35n;
  v1 = ((v1 * v1 * B(CAL.P3)) >> 8n) + ((v1 * B(CAL.P2)) << 12n);
  v1 = (((1n << 47n) + v1) * B(CAL.P1)) >> 33n;
  if (v1 === 0n) return 0;
  let p = 1048576n - B(adcP);
  p = (((p << 31n) - v2) * 3125n) / v1;
  v1 = (B(CAL.P9) * (p >> 13n) * (p >> 13n)) >> 25n;
  v2 = (B(CAL.P8) * p) >> 19n;
  return Number(((p + v1 + v2) >> 8n) + (B(CAL.P7) << 4n));      // Pa, times 256
}
export function bmxHum(adcH: number, fine: number): number {
  const B = BigInt;
  let x = B(fine) - 76800n;
  x = ((((B(adcH) << 14n) - (B(HCAL.H4) << 20n) - B(HCAL.H5) * x) + 16384n) >> 15n) *
    (((((((x * B(HCAL.H6)) >> 10n) * (((x * B(HCAL.H3)) >> 11n) + 32768n)) >> 10n) + 2097152n) * B(HCAL.H2) + 8192n) >> 14n);
  x -= ((((x >> 15n) * (x >> 15n)) >> 7n) * B(HCAL.H1)) >> 4n;
  if (x < 0n) x = 0n; if (x > 419430400n) x = 419430400n;
  return Number(x >> 12n);                                            // %RH, times 1024
}
/** The smallest raw reading in [lo, hi) whose result reaches want, for a result that rises with the reading. */
function search(lo: number, hi: number, f: (x: number) => number, want: number): number {
  while (hi - lo > 1) { const m = fl((lo + hi) / 2); if (f(m) <= want) lo = m; else hi = m; }
  return Math.abs(f(hi) - want) < Math.abs(f(lo) - want) ? hi : lo;
}

const calBytes = (): Record<number, number> => {
  const words = [CAL.T1, CAL.T2, CAL.T3, CAL.P1, CAL.P2, CAL.P3, CAL.P4, CAL.P5, CAL.P6, CAL.P7, CAL.P8, CAL.P9];
  const m: Record<number, number> = {};
  words.forEach((w, i) => { m[0x88 + i * 2] = w & 255; m[0x89 + i * 2] = (w >> 8) & 255; });
  m[0xa1] = HCAL.H1; m[0xe1] = HCAL.H2 & 255; m[0xe2] = (HCAL.H2 >> 8) & 255; m[0xe3] = HCAL.H3;
  m[0xe4] = HCAL.H4 >> 4; m[0xe5] = (HCAL.H4 & 15) | ((HCAL.H5 & 15) << 4); m[0xe6] = HCAL.H5 >> 4; m[0xe7] = HCAL.H6 & 255;
  return m;
};

function bmx(type: string, label: string, humid: boolean): PartDef {
  return {
    type, pins: ['VCC', 'GND', 'SCL', 'SDA', 'CSB', 'SDO'], ui: ui(type, label),
    controls: {
      temperature: range(-40, 85, 24, 'Temperature', '°C', 0.1),
      pressure: range(300, 1100, 1013.25, 'Pressure', 'hPa', 0.01),
      ...(humid ? { humidity: range(0, 100, 40, 'Humidity', '%', 0.1) } : {}),
    },
    links: () => [],
    device(ctx) {
      const cal = calBytes();
      const fresh = () => ({ ptr: 0, first: false, ctrl: 0, config: 0, hum: 0, adcT: 0x80000, adcP: 0x80000, adcH: 0x8000 });
      const s = fresh();
      const measure = () => {
        const osT = s.ctrl >> 5, osP = (s.ctrl >> 2) & 7, osH = s.hum & 7;
        const adcT = search(0, 1 << 20, (x) => bmxTemp(x).t, Math.round(ctx.control('temperature') * 100));
        const fine = bmxTemp(adcT).fine;
        // A skipped measurement leaves the reset value in its registers.
        s.adcT = osT ? adcT : 0x80000;
        // Pressure falls as the raw reading rises; search on the negated result.
        s.adcP = osP && osT ? search(0, 1 << 20, (x) => -bmxPress(x, fine), -Math.round(ctx.control('pressure') * 100 * 256)) : 0x80000;
        s.adcH = humid && osH && osT ? search(0, 1 << 16, (x) => bmxHum(x, fine), Math.round(ctx.control('humidity') * 1024)) : 0x8000;
      };
      const read = (r: number): number => {
        if ((s.ctrl & 3) === 3 && r >= 0xf7) measure();                   // normal mode: always a fresh reading
        switch (r) {
          case 0xd0: return humid ? 0x60 : 0x58;
          case 0xf2: return humid ? s.hum : 0;
          case 0xf3: return 0;
          case 0xf4: return s.ctrl;
          case 0xf5: return s.config;
          case 0xf7: return s.adcP >> 12; case 0xf8: return (s.adcP >> 4) & 255; case 0xf9: return (s.adcP & 15) << 4;
          case 0xfa: return s.adcT >> 12; case 0xfb: return (s.adcT >> 4) & 255; case 0xfc: return (s.adcT & 15) << 4;
          case 0xfd: return humid ? s.adcH >> 8 : 0x80; case 0xfe: return humid ? s.adcH & 255 : 0;
          default: return r in cal && (humid || r < 0xa0) ? cal[r] : 0;
        }
      };
      const write = (r: number, v: number): void => {
        if (r === 0xe0 && v === 0xb6) Object.assign(s, { ...fresh(), ptr: s.ptr });
        else if (r === 0xf2 && humid) s.hum = v & 7;
        else if (r === 0xf5) s.config = v;
        else if (r === 0xf4) {
          s.ctrl = v;
          // Forced mode: one measurement, then back to sleep.
          if ((v & 3) === 1 || (v & 3) === 2) { measure(); s.ctrl &= ~3; }
        }
      };
      return {
        i2c: regBus(ctx, s, { address: () => (powered(ctx) && high(ctx, 'CSB', true) ? (high(ctx, 'SDO', false) ? 0x77 : 0x76) : -1), read, write }),
        outputs: () => ({ powered: powered(ctx) }),
        ...keep(s),
      };
    },
  };
}

// ---------------- SHT31 ----------------
const sht31: PartDef = {
  type: 'sht31', pins: ['VIN', 'GND', 'SCL', 'SDA', 'ADR', 'AL'], ui: ui('sht31', 'Temperature and humidity (SHT31)'),
  controls: { temperature: range(-40, 125, 24, 'Temperature', '°C', 0.1), humidity: range(0, 100, 40, 'Humidity', '%', 0.1) },
  links: () => [],
  device(ctx) {
    const s = { cmd: [] as number[], out: [] as number[], status: 0x8010, periodic: false };
    const word = (w: number) => [w >> 8, w & 255, crc8([w >> 8, w & 255])];
    const data = () => [...word(Math.round(clamp((ctx.control('temperature') + 45) / 175, 0, 1) * 65535)), ...word(Math.round(clamp(ctx.control('humidity') / 100, 0, 1) * 65535))];
    const run = (c: number): void => {
      const hi = c >> 8;
      if (hi === 0x24 || hi === 0x2c) s.out = data();                      // single shot
      else if (c === 0xe000) s.out = s.periodic ? data() : [];               // fetch a periodic result
      else if ([0x20, 0x21, 0x22, 0x23, 0x27].includes(hi)) s.periodic = true;
      else if (c === 0x3093) s.periodic = false;                             // break
      else if (c === 0x30a2) { s.periodic = false; s.status = 0x0010; s.out = []; }   // soft reset
      else if (c === 0x306d) s.status |= 0x2000;                             // heater on
      else if (c === 0x3066) s.status &= ~0x2000;
      else if (c === 0xf32d) s.out = word(s.status);
      else if (c === 0x3041) s.status &= 0x2000;                             // clear status: only the heater bit stays
    };
    const bus: Bus = {
      sda: 'SDA', scl: 'SCL', address: () => (powered(ctx, 'VIN') ? (ctx.level('ADR') === 1 ? 0x45 : 0x44) : -1),
      start(write) { if (write) s.cmd = []; },
      write(b) { s.cmd.push(b); if (s.cmd.length === 2) run((s.cmd[0] << 8) | s.cmd[1]); return true; },
      read() { return s.out.length ? s.out.shift()! : 0xff; },
    };
    return { i2c: bus, outputs: () => ({ powered: powered(ctx, 'VIN') }), ...keep(s) };
  },
};

// ---------------- BH1750 ----------------
const bh1750: PartDef = {
  type: 'bh1750', pins: ['VCC', 'GND', 'SCL', 'SDA', 'ADDR'], ui: ui('bh1750', 'Light sensor (BH1750)'),
  controls: { lux: { kind: 'range', min: 0.1, max: 65535, initial: 300, log: true, label: 'Light', unit: 'lux' } },
  links: () => [],
  device(ctx) {
    const s = { on: false, mode: 0, mt: 69, value: 0, readyAt: 0, byte: 0, mtHi: 69 >> 5 };
    const count = (): number => {
      const c = (ctx.control('lux') * 1.2 * s.mt) / 69;
      const res = s.mode & 1 && !(s.mode & 2) ? 2 : s.mode & 2 ? 0.25 : 1;      // H-res2 counts half-lux steps; L-res keeps 4 lx steps
      return clamp(Math.round(res === 0.25 ? Math.round(c / 4) * 4 : c * res), 0, 65535);
    };
    const wait = () => ((s.mode & 3) === 3 ? 16e6 : 120e6) * (s.mt / 69);
    const latch = () => { if (s.mode && ctx.now() >= s.readyAt) { s.value = count(); if (s.mode & 0x20) { s.mode = 0; s.on = false; } } };
    const run = (c: number): void => {
      if (c === 0x00) s.on = false;
      else if (c === 0x01) s.on = true;
      else if (c === 0x07) { if (s.on) s.value = 0; }
      else if ((c & 0xf8) === 0x40) s.mtHi = c & 7;
      else if ((c & 0xe0) === 0x60) s.mt = clamp((s.mtHi << 5) | (c & 31), 31, 254);
      else if ([0x10, 0x11, 0x13, 0x20, 0x21, 0x23].includes(c)) { s.on = true; s.mode = c; s.readyAt = ctx.now() + wait(); }
    };
    const bus: Bus = {
      sda: 'SDA', scl: 'SCL', address: () => (powered(ctx) ? (ctx.level('ADDR') === 1 ? 0x5c : 0x23) : -1),
      start() { s.byte = 0; latch(); },
      write(b) { run(b); return true; },
      read() { const v = s.byte++ % 2 ? s.value & 255 : s.value >> 8; return v; },
    };
    return { i2c: bus, outputs: () => ({ powered: powered(ctx) }), ...keep(s) };
  },
};

// ---------------- ADXL345 ----------------
const G = { kind: 'range' as const, min: -16, max: 16, step: 0.01, unit: 'g' };
const adxl345: PartDef = {
  type: 'adxl345', pins: ['GND', 'VCC', 'CS', 'INT1', 'INT2', 'SDO', 'SDA', 'SCL'], ui: ui('adxl345', 'Accelerometer (ADXL345)'),
  controls: { ax: { ...G, initial: 0, label: 'Acceleration X' }, ay: { ...G, initial: 0, label: 'Acceleration Y' }, az: { ...G, initial: 1, label: 'Acceleration Z' } },
  links: () => [],
  device(ctx) {
    const s = { ptr: 0, first: false, reg: Array<number>(64).fill(0), data: [0, 0, 0] };
    s.reg[0x2c] = 0x0a; s.reg[0x30] = 0x02;
    const sample = () => {
      const fmt = s.reg[0x31], r = fmt & 3, full = Boolean(fmt & 8);
      const perG = full ? 256 : 256 >> r, bits = full ? 10 + r : 10, max = (1 << (bits - 1)) - 1;
      s.data = ['ax', 'ay', 'az'].map((k, i) => {
        const ofs = ((s.reg[0x1e + i] << 24) >> 24) * 0.0156;                // offset registers: 15.6 mg each
        const v = clamp(Math.round((ctx.control(k) + ofs) * perG), -max - 1, max);
        return (fmt & 4 ? v << (16 - bits) : v) & 0xffff;                   // left-justified if asked
      });
    };
    const read = (r: number): number => {
      if (r === 0x00) return 0xe5;
      if (r === 0x30) return s.reg[0x2d] & 8 ? 0x83 : 0x02;                  // data ready while measuring
      if (r === 0x39) return s.reg[0x2d] & 8 ? 1 : 0;
      if (r >= 0x32 && r <= 0x37) { if (r === 0x32 && s.reg[0x2d] & 8) sample(); const w = s.data[(r - 0x32) >> 1]; return r & 1 ? w >> 8 : w & 255; }
      return s.reg[r];
    };
    return {
      i2c: regBus(ctx, s, {
        size: 64, address: () => (powered(ctx) && high(ctx, 'CS', true) ? (high(ctx, 'SDO', false) ? 0x1d : 0x53) : -1), read,
        write: (r, v) => { if (r !== 0 && r !== 0x30 && r !== 0x39 && (r < 0x32 || r > 0x37)) s.reg[r] = v; if (r === 0x2d && v & 8) sample(); },
      }),
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

// ---------------- compasses ----------------
const compassControls = {
  heading: range(0, 359, 0, 'Heading', '°'),
  horizontal: range(0, 2, 0.25, 'Horizontal field', 'G', 0.01),
  vertical: range(-2, 2, -0.4, 'Vertical field (Z)', 'G', 0.01),
};
/** The field along the chip's axes, in gauss. Heading is atan2(y, x), as the usual sketches compute it. */
const field = (ctx: PartCtx): [number, number, number] => {
  const a = (ctx.control('heading') * Math.PI) / 180, h = ctx.control('horizontal');
  return [h * Math.cos(a), h * Math.sin(a), ctx.control('vertical')];
};

const HMC_GAIN = [1370, 1090, 820, 660, 440, 390, 330, 230];
const hmc5883l: PartDef = {
  type: 'hmc5883l', pins: ['VCC', 'GND', 'SCL', 'SDA', 'DRDY'], ui: ui('hmc5883l', 'Compass (HMC5883L)'), controls: compassControls,
  links: () => [],
  device(ctx) {
    const s = { ptr: 0, first: false, reg: [0x10, 0x20, 0x01], data: [0, 0, 0], ready: false };
    const sample = () => {
      const [x, y, z] = field(ctx), g = HMC_GAIN[s.reg[1] >> 5];
      // Register order is X, Z, Y. A reading out of range shows as -4096.
      s.data = [x, z, y].map((v) => { const n = Math.round(v * g); return (n < -2048 || n > 2047 ? -4096 : n) & 0xffff; });
      s.ready = true;
    };
    const read = (r: number): number => {
      if (r < 3) return s.reg[r];
      if (r <= 8) { if (r === 3 && (s.reg[2] & 3) === 0) sample(); const w = s.data[(r - 3) >> 1]; if (r === 8) s.ready = false; return r & 1 ? w >> 8 : w & 255; }
      if (r === 9) return s.ready ? 1 : 0;
      return [0x48, 0x34, 0x33][r - 10] ?? 0;
    };
    return {
      i2c: regBus(ctx, s, {
        size: 13, address: () => (powered(ctx) ? 0x1e : -1), read,
        write: (r, v) => { if (r < 3) s.reg[r] = v; if (r === 2 && (v & 3) === 1) { sample(); s.reg[2] = 0x03; } if (r === 2 && (v & 3) === 0) sample(); },
        // Reading on past Y wraps back to X, so a sketch can keep reading six bytes.
        next: (r) => (r === 8 ? 3 : r === 12 ? 0 : r + 1),
      }),
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

const qmc5883l: PartDef = {
  type: 'qmc5883l', pins: ['VCC', 'GND', 'SCL', 'SDA', 'DRDY'], ui: ui('qmc5883l', 'Compass (QMC5883L)'), controls: compassControls,
  links: () => [],
  device(ctx) {
    const s = { ptr: 0, first: false, reg: Array<number>(14).fill(0), data: [0, 0, 0] };
    s.reg[0x0d] = 0xff;
    const continuous = () => (s.reg[9] & 3) === 1;
    const sample = () => { const per = s.reg[9] & 0x10 ? 3000 : 12000; s.data = field(ctx).map((v) => i16(v * per)); };
    const read = (r: number): number => {
      if (r <= 5) { if (r === 0 && continuous()) sample(); const w = s.data[r >> 1]; return r & 1 ? w >> 8 : w & 255; }
      if (r === 6) { if (continuous()) sample(); return continuous() ? 1 : 0; }
      if (r === 7 || r === 8) return 0;
      return s.reg[r] ?? 0;
    };
    return {
      i2c: regBus(ctx, s, {
        size: 14, address: () => (powered(ctx) ? 0x0d : -1), read,
        write: (r, v) => { if (r === 0x0a && v & 0x80) { s.reg.fill(0); s.reg[0x0d] = 0xff; } else if (r >= 9 && r !== 0x0d) s.reg[r] = v; },
        next: (r) => (s.reg[0x0a] & 0x40 && r === 6 ? 0 : r + 1),
      }),
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

// ---------------- INA219 ----------------
const PG_LIMIT = [4000, 8000, 16000, 32000];        // shunt register limits for 40, 80, 160 and 320 mV
const ina219: PartDef = {
  type: 'ina219', pins: ['VCC', 'GND', 'SCL', 'SDA', 'VIN+', 'VIN-', 'A0', 'A1'], ui: ui('ina219', 'Current sensor (INA219)'),
  controls: { bus: range(0, 26, 5, 'Load voltage', 'V', 0.01), current: range(-3200, 3200, 100, 'Load current', 'mA') },
  // The 0.1 ohm shunt sits between VIN+ and VIN-: for wiring, they are joined.
  links: (id) => [{ a: `${id}:VIN+`, b: `${id}:VIN-`, kind: 'wire' }],
  device(ctx) {
    const s = { ptr: 0, first: false, w: [] as number[], byte: 0, config: 0x399f, cal: 0 };
    const shunt = () => { const lim = PG_LIMIT[(s.config >> 11) & 3]; return clamp(Math.round(ctx.control('current') * 10), -lim, lim); };   // 10 uV steps across 0.1 ohm
    const busRaw = () => clamp(Math.round((ctx.control('bus') * 1000) / 4), 0, 8191);
    const current = () => Math.trunc((shunt() * s.cal) / 4096);
    const reg = (r: number): number => {
      switch (r) {
        case 0: return s.config;
        case 1: return shunt() & 0xffff;
        case 2: return (busRaw() << 3) | 2;                                  // conversion ready
        case 3: return clamp(Math.trunc((Math.abs(current()) * busRaw()) / 5000), 0, 65535);
        case 4: return clamp(current(), -32768, 32767) & 0xffff;
        case 5: return s.cal;
        default: return 0;
      }
    };
    const bus: Bus = {
      sda: 'SDA', scl: 'SCL',
      address: () => (powered(ctx) ? 0x40 | (ctx.level('A0') === 1 ? 1 : 0) | (ctx.level('A1') === 1 ? 4 : 0) : -1),
      start(write) { s.first = write; s.w = []; s.byte = 0; },
      write(b) {
        if (s.first) { s.first = false; s.ptr = b; return true; }
        s.w.push(b);
        if (s.w.length === 2) {
          const v = (s.w[0] << 8) | s.w[1]; s.w = [];
          if (s.ptr === 0 && v & 0x8000) { s.config = 0x399f; s.cal = 0; }         // reset bit
          else if (s.ptr === 0) s.config = v;
          if (s.ptr === 5) s.cal = v & 0xfffe;
        }
        return true;
      },
      read() { const v = reg(s.ptr); return s.byte++ % 2 ? v & 255 : v >> 8; },
    };
    return { i2c: bus, outputs: () => ({ powered: powered(ctx) }), ...keep(s) };
  },
};

// ---------------- MAX30102 ----------------
const RATE = [50, 100, 200, 400, 800, 1000, 1600, 3200];
const AVG = [1, 2, 4, 8, 16, 32, 32, 32];
const RANGE_NA = [2048, 4096, 8192, 16384];
/** One heartbeat: a sharp rise, then a smaller second bump, for phase 0..1. */
const pulse = (ph: number) => Math.exp(-(((ph - 0.15) / 0.07) ** 2)) + 0.35 * Math.exp(-(((ph - 0.45) / 0.09) ** 2));
/** The red/IR ratio R that the usual SpO2 curve (-45.06 R^2 + 30.354 R + 94.845) turns into this saturation. */
const ratioFor = (spo2: number) => (30.354 + Math.sqrt(Math.max(0, 30.354 ** 2 + 4 * 45.06 * (94.845 - spo2)))) / (2 * 45.06);

const max30102: PartDef = {
  type: 'max30102', pins: ['VIN', 'SCL', 'SDA', 'INT', 'IRD', 'RD', 'GND'], ui: ui('max30102', 'Pulse oximeter (MAX30102)'),
  controls: { finger: toggle('Finger on the sensor'), bpm: range(30, 200, 72, 'Heart rate', 'bpm'), spo2: range(80, 100, 98, 'Blood oxygen', '%') },
  links: () => [],
  device(ctx) {
    const fresh = () => ({ ptr: 0, first: false, reg: Array<number>(256).fill(0), fifo: Array.from({ length: 32 }, () => [] as number[]), n: 0, wr: 0, rd: 0, ovf: 0, byte: 0, t0: ctx.now(), made: 0, int1: 0x01, int2: 0 });
    const s = fresh();
    s.reg[0xfe] = 0x03; s.reg[0xff] = 0x15;
    const mode = () => s.reg[0x09] & 7;
    const leds = () => (mode() === 2 ? 1 : mode() === 3 ? 2 : mode() === 7 ? [0x11, 0x12].reduce((n, r) => n + (s.reg[r] & 7 ? 1 : 0) + (s.reg[r] & 0x70 ? 1 : 0), 0) : 0);
    const value = (t: number, ir: boolean): number => {
      const pa = s.reg[ir ? 0x0d : 0x0c] * 0.2;                               // LED current, mA
      const na = (ir ? 252 : 214) * pa * (ctx.control('finger') ? 1 : 0.01);  // light coming back, nA
      const pi = ctx.control('finger') ? (ir ? 0.005 : 0.005 * ratioFor(ctx.control('spo2'))) : 0;
      const ph = ((t * ctx.control('bpm')) / 60e9) % 1;
      const bits = 15 + (s.reg[0x0a] & 3);
      const n = clamp(Math.round(((na * (1 - pi * pulse(ph))) / RANGE_NA[(s.reg[0x0a] >> 5) & 3]) * 262144), 0, 262143);
      return n & ~((1 << (18 - bits)) - 1);
    };
    const push = (t: number): void => {
      const n = leds(), sample = [value(t, false), value(t, true)].slice(0, n);
      if (s.n === 32) {
        s.ovf = Math.min(31, s.ovf + 1);
        if (!(s.reg[0x08] & 0x10)) return;                                   // no rollover: the new sample is lost
        s.rd = (s.rd + 1) % 32; s.n--;
      }
      s.fifo[s.wr] = sample; s.wr = (s.wr + 1) % 32; s.n++;
      s.int1 |= 0x40;
      if (s.n >= 32 - (s.reg[0x08] & 15)) s.int1 |= 0x80;
    };
    /** Make the samples that are due by now. */
    const sync = (): void => {
      if (!leds() || s.reg[0x09] & 0x80) { s.t0 = ctx.now(); s.made = 0; return; }
      const rate = RATE[(s.reg[0x0a] >> 2) & 7] / AVG[s.reg[0x08] >> 5];
      const due = Math.floor(((ctx.now() - s.t0) * rate) / 1e9);
      for (let k = Math.max(s.made, due - 40); k < due; k++) push(s.t0 + (k * 1e9) / rate);
      s.made = due;
    };
    const fifoByte = (): number => {
      const n = leds() || 1;
      if (s.n === 0) return 0;
      const sample = s.fifo[s.rd] ?? [], v = sample[Math.floor(s.byte / 3)] ?? 0, k = s.byte % 3;
      if (++s.byte >= n * 3) { s.byte = 0; s.rd = (s.rd + 1) % 32; s.n--; }
      return k === 0 ? (v >> 16) & 3 : k === 1 ? (v >> 8) & 255 : v & 255;
    };
    const read = (r: number): number => {
      sync();
      switch (r) {
        case 0x00: { const v = s.int1; s.int1 = 0; return v; }
        case 0x01: { const v = s.int2; s.int2 = 0; return v; }
        case 0x04: return s.wr;
        case 0x05: return s.ovf;
        case 0x06: return s.rd;
        case 0x07: return fifoByte();
        default: return s.reg[r];
      }
    };
    const write = (r: number, v: number): void => {
      sync();
      if (r === 0x09 && v & 0x40) { const keepPtr = s.ptr; Object.assign(s, fresh(), { ptr: keepPtr }); s.reg[0xfe] = 0x03; s.reg[0xff] = 0x15; return; }
      if (r === 0x04) { s.wr = v & 31; s.n = (s.wr - s.rd + 32) % 32; s.byte = 0; }
      else if (r === 0x05) s.ovf = v & 31;
      else if (r === 0x06) { s.rd = v & 31; s.n = (s.wr - s.rd + 32) % 32; s.byte = 0; }
      else if (r === 0x21) { if (v & 1) { s.reg[0x1f] = 30; s.reg[0x20] = 8; s.int2 |= 0x02; } }  // die temperature: 30.5 °C
      else if (r < 0xfe && r !== 0x07) s.reg[r] = v;
      if (r === 0x08 || r === 0x09 || r === 0x0a) { s.t0 = ctx.now(); s.made = 0; }
    };
    return {
      i2c: regBus(ctx, s, { address: () => (powered(ctx, 'VIN') ? 0x57 : -1), read, write, next: (r) => (r === 0x07 ? 0x07 : r + 1) }),
      outputs: () => ({ powered: powered(ctx, 'VIN') }),
      ...keep(s),
    };
  },
};

export const sensorsI2C: PartDef[] = [
  bmx('bmp280', 'Pressure and temperature (BMP280)', false), bmx('bme280', 'Pressure, temperature, humidity (BME280)', true),
  sht31, bh1750, adxl345, hmc5883l, qmc5883l, ina219, max30102,
];
