// Chips on the I2C bus: an EEPROM, a precise clock, and an 8-pin expander.
import type { PartDef } from '../../part.ts';
import type { Level } from '../../types.ts';
import { keep, powered } from '../util.ts';

const bit = (l: Level): number => (l === 1 ? 1 : 0);
/** The three address pins most I2C chips have, as a number 0 to 7. Unwired counts as low, as on breakout boards with pull-downs. */
const addrPins = (level: (p: string) => Level) => bit(level('A0')) | (bit(level('A1')) << 1) | (bit(level('A2')) << 2);

// ---------- 24C32: 4 KB EEPROM ----------
const SIZE = 4096, PAGE = 32, WRITE_NS = 5e6;
const eeprom: PartDef = {
  type: 'eeprom-24c32', pins: ['A0', 'A1', 'A2', 'GND', 'SDA', 'SCL', 'WP', 'VCC'],
  ui: { label: 'EEPROM (24C32)', tag: 'shibo-eeprom-24c32', group: 'Modules' },
  links: () => [],
  device(ctx) {
    // `mem` is kept as text so a snapshot stays small and cheap to copy.
    const s = { mem: 'ff'.repeat(SIZE), ptr: 0, phase: 0, writing: false, pending: [] as [number, number][], busyUntil: -1 };
    const at = (i: number) => parseInt(s.mem.substr(i * 2, 2), 16);
    return {
      i2c: {
        sda: 'SDA', scl: 'SCL',
        // While it is storing a page it does not answer at all, which is how sketches poll for "done".
        address: () => (powered(ctx) && ctx.now() >= s.busyUntil ? 0x50 | addrPins(ctx.level) : -1),
        start(write) { s.phase = write ? 0 : 2; s.writing = write; s.pending = []; },
        write(b) {
          if (s.phase === 0) { s.ptr = (b << 8) & 0xf00; s.phase = 1; return true; }
          if (s.phase === 1) { s.ptr |= b; s.phase = 2; return true; }
          // Data bytes stay within the page: past its end they wrap to its start.
          s.pending.push([s.ptr, b]);
          s.ptr = (s.ptr & ~(PAGE - 1)) | ((s.ptr + 1) & (PAGE - 1));
          return true;
        },
        read() { const v = at(s.ptr); s.ptr = (s.ptr + 1) % SIZE; return v; },
        stop() {
          if (s.writing && s.pending.length) {
            if (ctx.level('WP') !== 1) {
              const m = s.mem.match(/../g)!;
              for (const [a, v] of s.pending) m[a] = v.toString(16).padStart(2, '0');
              s.mem = m.join('');
            }
            s.busyUntil = ctx.now() + WRITE_NS;
          }
          s.writing = false; s.pending = [];
        },
      },
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

// ---------- DS3231: temperature-compensated real-time clock ----------
const bcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const unbcd = (b: number) => ((b >> 4) & 15) * 10 + (b & 15);
const START = Date.UTC(2026, 0, 1, 0, 0, 0);
const ds3231: PartDef = {
  type: 'ds3231', pins: ['GND', 'VCC', 'SDA', 'SCL', 'SQW', '32K'],
  ui: { label: 'Real-time clock (DS3231)', tag: 'shibo-ds3231', group: 'Modules' },
  controls: { temperature: { kind: 'range', min: -40, max: 85, initial: 24, step: 0.25, label: 'Temperature', unit: '°C' } },
  links: () => [],
  device(ctx) {
    // reg holds everything but the time: alarms 7-13, control 14, status 15 (OSF set: it has never been set), aging 16.
    const s = { offset: 0, ptr: 0, first: false, edit: null as number[] | null, reg: Array<number>(19).fill(0), lastSec: -1 };
    s.reg[0x0e] = 0x1c; s.reg[0x0f] = 0x88;
    const fed = () => powered(ctx);
    const date = () => new Date(START + s.offset + ctx.now() / 1e6);
    const time = (): number[] => {
      const d = date();
      return [bcd(d.getUTCSeconds()), bcd(d.getUTCMinutes()), bcd(d.getUTCHours()), d.getUTCDay() + 1, bcd(d.getUTCDate()),
        bcd(d.getUTCMonth() + 1) | (d.getUTCFullYear() >= 2100 ? 0x80 : 0), bcd(d.getUTCFullYear() % 100)];
    };
    const temp = (): number[] => { const q = Math.round(ctx.control('temperature') * 4); return [(q >> 2) & 255, (q & 3) << 6]; };
    const read = (r: number): number => (r < 7 ? (s.edit ?? time())[r] : r >= 0x11 ? temp()[r - 0x11] : s.reg[r]);
    const hours = (b: number) => (b & 0x40 ? (unbcd(b & 0x1f) % 12) + (b & 0x20 ? 12 : 0) : unbcd(b & 0x3f));
    // Alarms are checked once a second; a match sets A1F or A2F, and pulls INT/SQW low if enabled.
    const alarm = (): void => {
      const t = time(), r = s.reg;
      const hit = (v: number, now: number, mask: number) => Boolean(v & 0x80) || (v & mask) === now;
      const day = (v: number) => v & 0x80 || (v & 0x40 ? (v & 0x0f) === t[3] : (v & 0x3f) === t[4]);
      if (hit(r[7], t[0], 0x7f) && hit(r[8], t[1], 0x7f) && hit(r[9], t[2], 0x3f) && day(r[10])) r[0x0f] |= 1;
      if (t[0] === 0 && hit(r[11], t[1], 0x7f) && hit(r[12], t[2], 0x3f) && day(r[13])) r[0x0f] |= 2;
    };
    const tick = (): void => { if (fed()) { const n = date().getUTCSeconds(); if (n !== s.lastSec) { s.lastSec = n; alarm(); ctx.changed(); } } ctx.after(1e9 - ((START + s.offset + ctx.now() / 1e6) % 1000) * 1e6 + 1, tick); };
    ctx.after(1e9, tick);
    return {
      drives() {
        if (!fed()) return [];
        const c = s.reg[0x0e], st = s.reg[0x0f];
        // INT/SQW is open-drain: in interrupt mode it is low while an enabled alarm flag is set.
        const low = c & 4 ? (st & c & 3) !== 0 : false;
        return [{ pin: 'SQW', level: low ? 0 : null, pull: 'up' as const }];
      },
      i2c: {
        sda: 'SDA', scl: 'SCL', address: () => (fed() ? 0x68 : -1),
        start(write) { s.first = write; },
        write(b) {
          if (s.first) { s.first = false; s.ptr = b % 0x13; return true; }
          if (s.ptr < 7) { (s.edit ??= time())[s.ptr] = b; }
          else if (s.ptr === 0x0f) s.reg[0x0f] = (b & 0x08) | (s.reg[0x0f] & b & 0x83) | (s.reg[0x0f] & 0x04);   // OSF, A2F and A1F can only be cleared
          else if (s.ptr < 0x11) s.reg[s.ptr] = b;
          s.ptr = (s.ptr + 1) % 0x13;
          return true;
        },
        read() { const v = read(s.ptr); s.ptr = (s.ptr + 1) % 0x13; return v; },
        stop() {
          // The time registers take effect together when the write ends, so a date is never judged half-written.
          const r = s.edit; s.edit = null;
          if (!r) return;
          const want = Date.UTC(2000 + unbcd(r[6]) + (r[5] & 0x80 ? 100 : 0), unbcd(r[5] & 0x1f) - 1, unbcd(r[4] & 0x3f), hours(r[2]), unbcd(r[1] & 0x7f), unbcd(r[0] & 0x7f));
          if (Number.isFinite(want)) s.offset = want - START - ctx.now() / 1e6;
        },
      },
      outputs: () => ({ powered: fed() }),
      ...keep(s),
    };
  },
};

// ---------- PCF8574: eight quasi-bidirectional pins over I2C ----------
const P = Array.from({ length: 8 }, (_, i) => `P${i}`);
const pcf = (type: string, label: string, base: number): PartDef => ({
  type, pins: ['A0', 'A1', 'A2', 'P0', 'P1', 'P2', 'P3', 'GND', 'P4', 'P5', 'P6', 'P7', 'INT', 'SCL', 'SDA', 'VCC'],
  ui: { label, tag: `shibo-${type}`, group: 'Modules' },
  links: () => [],
  device(ctx) {
    const s = { out: 0xff, seen: -1, int: false };
    const pins = () => P.reduce((v, p, i) => v | (bit(ctx.level(p)) << i), 0);
    return {
      // A 0 pulls the pin hard low; a 1 only holds it up weakly, so a button to ground can still pull it down and be read.
      drives: () => (powered(ctx) ? [...P.map((pin, i) => ((s.out >> i) & 1 ? { pin, level: null, pull: 'up' as const } : { pin, level: 0 as Level })),
        { pin: 'INT', level: s.int ? 0 : null }] : []),
      // INT falls when a pin used as an input changes from what was last read or written; reading or writing lets it go.
      onChange() {
        if (!powered(ctx)) return;
        const now = pins() & s.out;
        if (s.seen < 0) s.seen = now; else if (!s.int && now !== s.seen) { s.int = true; ctx.changed(); }
      },
      i2c: {
        sda: 'SDA', scl: 'SCL', address: () => (powered(ctx) ? base | addrPins(ctx.level) : -1),
        write(b) { s.out = b & 255; s.int = false; s.seen = -1; return true; },
        read() { const v = pins(); s.seen = v & s.out; s.int = false; return v; },
      },
      outputs: () => ({ port: s.out, powered: powered(ctx) }),
      ...keep(s),
    };
  },
});

export const i2cChips: PartDef[] = [eeprom, ds3231, pcf('pcf8574', 'I/O expander (PCF8574)', 0x20)];
