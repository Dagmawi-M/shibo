// Modules that answer register reads over I2C.
import type { PartDef } from '../part.ts';
import { keep, powered } from './util.ts';

const bcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const unbcd = (b: number) => ((b >> 4) & 15) * 10 + (b & 15);
const START = Date.UTC(2026, 0, 1, 0, 0, 0);          // what the clock reads when a run begins

const ds1307: PartDef = {
  type: 'ds1307', pins: ['GND', '5V', 'SDA', 'SCL', 'SQW'],
  ui: { label: 'Real-time clock (DS1307)', tag: 'wokwi-ds1307', group: 'Modules' },
  links: () => [],
  device(ctx) {
    const s = { ptr: 0, first: false, offset: 0, ram: Array<number>(57).fill(0) };
    const fed = () => powered(ctx, '5V', 'GND');
    const time = (): number[] => {
      const d = new Date(START + s.offset + ctx.now() / 1e6);
      return [bcd(d.getUTCSeconds()), bcd(d.getUTCMinutes()), bcd(d.getUTCHours()), d.getUTCDay() + 1, bcd(d.getUTCDate()), bcd(d.getUTCMonth() + 1), bcd(d.getUTCFullYear() % 100)];
    };
    return {
      i2c: {
        sda: 'SDA', scl: 'SCL', address: () => (fed() ? 0x68 : -1),
        start(write) { s.first = write; },
        write(b) {
          if (s.first) { s.first = false; s.ptr = b & 0x3f; return true; }
          if (s.ptr < 7) {
            // Setting one time register moves the whole clock.
            const r = time(); r[s.ptr] = b;
            const want = Date.UTC(2000 + unbcd(r[6]), unbcd(r[5] & 0x1f) - 1, unbcd(r[4] & 0x3f), unbcd(r[2] & 0x3f), unbcd(r[1] & 0x7f), unbcd(r[0] & 0x7f));
            if (Number.isFinite(want)) s.offset = want - START - ctx.now() / 1e6;
          } else s.ram[s.ptr - 7] = b;
          s.ptr = (s.ptr + 1) & 0x3f;
          return true;
        },
        read() { const v = s.ptr < 7 ? time()[s.ptr] : s.ram[s.ptr - 7]; s.ptr = (s.ptr + 1) & 0x3f; return v; },
      },
      outputs: () => ({ powered: fed() }),
      ...keep(s),
    };
  },
};

const G = { kind: 'range' as const, min: -16, max: 16, step: 0.01, unit: 'g' };
const DPS = { kind: 'range' as const, min: -2000, max: 2000, step: 1, unit: '°/s' };
const GYRO_LSB = [131, 65.5, 32.8, 16.4];
const mpu6050: PartDef = {
  type: 'mpu6050', pins: ['INT', 'AD0', 'XCL', 'XDA', 'SDA', 'SCL', 'GND', 'VCC'],
  ui: { label: 'Accelerometer and gyro (MPU6050)', tag: 'wokwi-mpu6050', group: 'Sensors' },
  controls: {
    ax: { ...G, initial: 0, label: 'Acceleration X' }, ay: { ...G, initial: 0, label: 'Acceleration Y' }, az: { ...G, initial: 1, label: 'Acceleration Z' },
    gx: { ...DPS, initial: 0, label: 'Rotation X' }, gy: { ...DPS, initial: 0, label: 'Rotation Y' }, gz: { ...DPS, initial: 0, label: 'Rotation Z' },
    temperature: { kind: 'range', min: -40, max: 85, initial: 24, step: 0.1, label: 'Temperature', unit: '°C' },
  },
  links: () => [],
  device(ctx) {
    const s = { ptr: 0, first: false, reg: Array<number>(128).fill(0) };
    s.reg[0x75] = 0x68; s.reg[0x6b] = 0x40;
    const i16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v))) & 0xffff;
    const read = (r: number): number => {
      if (r >= 0x3b && r <= 0x48) {
        const accel = 16384 / (1 << ((s.reg[0x1c] >> 3) & 3)), gyro = GYRO_LSB[(s.reg[0x1b] >> 3) & 3];
        const words = [ctx.control('ax') * accel, ctx.control('ay') * accel, ctx.control('az') * accel, (ctx.control('temperature') - 36.53) * 340,
          ctx.control('gx') * gyro, ctx.control('gy') * gyro, ctx.control('gz') * gyro].map(i16);
        const w = words[(r - 0x3b) >> 1];
        return (r - 0x3b) & 1 ? w & 255 : w >> 8;
      }
      return s.reg[r & 127];
    };
    return {
      i2c: {
        sda: 'SDA', scl: 'SCL', address: () => (powered(ctx) ? (ctx.level('AD0') === 1 ? 0x69 : 0x68) : -1),
        start(write) { s.first = write; },
        write(b) { if (s.first) { s.first = false; s.ptr = b & 127; } else { if (s.ptr !== 0x75) s.reg[s.ptr] = b; s.ptr = (s.ptr + 1) & 127; } return true; },
        read() { const v = read(s.ptr); s.ptr = (s.ptr + 1) & 127; return v; },
      },
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

export const bus: PartDef[] = [ds1307, mpu6050];
