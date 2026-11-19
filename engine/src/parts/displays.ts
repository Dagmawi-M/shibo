// Character LCDs, the small OLED, and addressable LEDs.
import type { Device, PartCtx, PartDef } from '../part.ts';
import type { Level } from '../types.ts';
import { keep, powered } from './util.ts';

// ---------- HD44780 character LCD ----------
interface Lcd { ram: number[]; addr: number; cg: boolean; cgAddr: number; inc: number; on: boolean; cursor: boolean; blink: boolean; four: boolean; hi: number; e: Level; light: boolean; lastBus: number }
const ROW_ADDR: Record<number, number[]> = { 2: [0x00, 0x40], 4: [0x00, 0x40, 0x14, 0x54] };

function lcd(type: string, label: string, rows: number, cols: number): PartDef {
  return {
    type, pins: ['GND', 'VCC', 'SDA', 'SCL', 'VSS', 'VDD', 'V0', 'RS', 'RW', 'E', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'A', 'K'], attrs: ['pins', 'color', 'background'],
    ui: { label, tag: `wokwi-${type}`, group: 'Displays', show: { characters: 'characters', cursor: 'cursor', blink: 'blink', cursorX: 'cursorX', cursorY: 'cursorY', backlight: 'backlight' } },
    links: () => [],
    device(ctx: PartCtx): Device {
      const i2c = ctx.attrs.pins === 'i2c';
      const s: Lcd = { ram: Array<number>(0x68).fill(32), addr: 0, cg: false, cgAddr: 0, inc: 1, on: false, cursor: false, blink: false, four: false, hi: -1, e: null, light: !i2c, lastBus: 0 };
      const fed = () => (i2c ? powered(ctx) : powered(ctx, 'VDD', 'VSS'));
      const step = (): void => {
        s.addr += s.inc;
        if (s.addr === 0x28) s.addr = 0x40; else if (s.addr >= 0x68) s.addr = 0; else if (s.addr < 0) s.addr = 0x67; else if (s.addr === 0x3f) s.addr = 0x27;
      };
      const byteIn = (rs: boolean, b: number): void => {
        if (rs) { if (s.cg) s.cgAddr = (s.cgAddr + 1) & 63; else { s.ram[s.addr] = b; step(); } return; }
        if (b & 0x80) { s.cg = false; s.addr = Math.min(b & 0x7f, 0x67); }
        else if (b & 0x40) { s.cg = true; s.cgAddr = b & 0x3f; }
        else if (b & 0x20) { s.four = !(b & 0x10); s.hi = -1; }
        else if (b & 0x10) { if (!(b & 8)) { s.inc = b & 4 ? 1 : -1; step(); s.inc = 1; } }
        else if (b & 0x08) { s.on = Boolean(b & 4); s.cursor = Boolean(b & 2); s.blink = Boolean(b & 1); }
        else if (b & 0x04) s.inc = b & 2 ? 1 : -1;
        else if (b & 0x02) s.addr = 0;
        else if (b & 0x01) { s.ram.fill(32); s.addr = 0; s.inc = 1; }
      };
      // On four data wires a byte arrives as two halves; before that mode is chosen, a half is a whole command.
      const nibble = (rs: boolean, n: number): void => {
        if (!s.four) byteIn(rs, n << 4);
        else if (s.hi < 0) s.hi = n;
        else { const b = (s.hi << 4) | n; s.hi = -1; byteIn(rs, b); }
      };
      const cells = (): number[] => ROW_ADDR[rows].flatMap((a) => s.ram.slice(a, a + cols));
      const bit = (pin: string) => (ctx.level(pin) === 1 ? 1 : 0);
      return {
        onChange() {
          if (i2c) return;
          const e = ctx.level('E');
          // Data is taken when E falls.
          if (e !== 1 && s.e === 1 && fed()) {
            const hi = (bit('D7') << 3) | (bit('D6') << 2) | (bit('D5') << 1) | bit('D4');
            if (s.four) nibble(bit('RS') === 1, hi);
            else byteIn(bit('RS') === 1, (hi << 4) | (bit('D3') << 3) | (bit('D2') << 2) | (bit('D1') << 1) | bit('D0'));
          }
          s.e = e;
        },
        // The common I2C backpack is a PCF8574: bit 0 RS, bit 2 E, bit 3 backlight, bits 4-7 data.
        i2c: i2c ? {
          sda: 'SDA', scl: 'SCL', address: () => (fed() ? 0x27 : -1),
          write(v) { if (s.lastBus & 4 && !(v & 4)) nibble(Boolean(s.lastBus & 1), s.lastBus >> 4); s.lastBus = v; s.light = Boolean(v & 8); return true; },
          read: () => 0xff,
        } : undefined,
        outputs: () => ({ text: Array.from({ length: rows }, (_, r) => cells().slice(r * cols, (r + 1) * cols).map((c) => (s.on && c >= 32 && c < 127 ? String.fromCharCode(c) : ' ')).join('')).join('\n'), powered: fed() }),
        display: () => ({ characters: s.on ? cells() : Array<number>(rows * cols).fill(32), cursor: s.on && s.cursor, blink: s.on && s.blink,
          cursorX: Math.max(0, ROW_ADDR[rows].map((a) => s.addr - a).find((d) => d >= 0 && d < cols) ?? 0), cursorY: Math.max(0, ROW_ADDR[rows].findIndex((a) => s.addr >= a && s.addr < a + cols)),
          backlight: fed() && s.light }),
        ...keep(s),
      };
    },
  };
}

// ---------- SSD1306 128x64 OLED over I2C ----------
const ARGS: Record<number, number> = { 0x20: 1, 0x21: 2, 0x22: 2, 0x81: 1, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x8d: 1, 0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0xa3: 2 };
const POP = Array.from({ length: 256 }, (_, i) => i.toString(2).replace(/0/g, '').length);
const oled: PartDef = {
  type: 'ssd1306', pins: ['DATA', 'CLK', 'DC', 'RST', 'CS', '3V3', 'VIN', 'GND'],
  ui: { label: 'OLED display (SSD1306)', tag: 'wokwi-ssd1306', group: 'Displays', paint: 'oled' },
  links: () => [],
  device(ctx) {
    const s = { fb: Array<number>(1024).fill(0), lit: 0, col: 0, page: 0, c0: 0, c1: 127, p0: 0, p1: 7, on: false, invert: false, first: true, data: false, cmd: -1, need: 0, args: [] as number[], rev: 0 };
    let hex = '', hexRev = -1;                       // the frame as text, rebuilt only when it changed
    const fed = () => (ctx.level('VIN') === 1 || ctx.level('3V3') === 1) && ctx.level('GND') === 0;
    const run = (c: number, a: number[]): void => {
      if (c === 0xae) s.on = false; else if (c === 0xaf) s.on = true;
      else if (c === 0xa6) s.invert = false; else if (c === 0xa7) s.invert = true;
      else if (c === 0x21) { s.c0 = a[0] & 127; s.c1 = a[1] & 127; s.col = s.c0; }
      else if (c === 0x22) { s.p0 = a[0] & 7; s.p1 = a[1] & 7; s.page = s.p0; }
      else if (c >= 0xb0 && c <= 0xb7) s.page = c & 7;
      else if (c <= 0x0f) s.col = (s.col & 0xf0) | c; else if (c >= 0x10 && c <= 0x1f) s.col = ((c & 7) << 4) | (s.col & 15);
      s.rev++;
    };
    return {
      i2c: {
        sda: 'DATA', scl: 'CLK', address: () => (fed() ? 0x3c : -1),
        start() { s.first = true; },
        write(b) {
          if (s.first) { s.first = false; s.data = Boolean(b & 0x40); return true; }      // the control byte: commands or pixels follow
          if (s.data) {
            const i = s.page * 128 + s.col;
            s.lit += POP[b] - POP[s.fb[i]]; s.fb[i] = b; s.rev++;
            if (++s.col > s.c1) { s.col = s.c0; if (++s.page > s.p1) s.page = s.p0; }
          } else if (s.need > 0) { s.args.push(b); if (--s.need === 0) { run(s.cmd, s.args); s.args = []; } }
          else { s.cmd = b; s.need = ARGS[b] ?? 0; if (!s.need) run(b, []); }
          return true;
        },
        read: () => 0,
      },
      outputs: () => ({ on: s.on, pixels: s.lit, powered: fed() }),
      display() {
        if (hexRev !== s.rev) { hex = s.fb.map((b) => b.toString(16).padStart(2, '0')).join(''); hexRev = s.rev; }
        return { fb: hex, on: s.on && fed(), invert: s.invert };
      },
      save: () => structuredClone(s), restore(x) { Object.assign(s, structuredClone(x)); s.rev++; },
    };
  },
};

// ---------- WS2812 "NeoPixel" LEDs ----------
const GRB = [1, 0, 2];            // the bytes arrive green, red, blue
/**
 * A chain of WS2812s. Each keeps the first 24 bits of a frame and passes the
 * rest on through DOUT, so the next part in the chain gets what is left.
 */
export function pixelChain(ctx: PartCtx, count: number, vcc: string, gnd: string) {
  const s = { pix: Array<number>(count * 3).fill(0), n: 0, cur: 0, upAt: -1, downAt: -1, last: null as Level, fwd: false };
  const onChange = (): void => {
    const l = ctx.level('DIN'), now = ctx.now(), fed = powered(ctx, vcc, gnd);
    if (l === 1 && s.last !== 1) {
      if (s.downAt >= 0 && now - s.downAt > 50_000) s.n = 0;      // a long low starts a new frame
      s.upAt = now;
      if (fed && s.n >= count * 24) { s.fwd = true; ctx.changed(); }
    }
    if (l !== 1 && s.last === 1 && s.upAt >= 0 && fed) {
      if (s.fwd) { s.fwd = false; ctx.changed(); }
      else {
        // A one is a long high (about 0.8 us), a zero a short one (about 0.35 us).
        const byte = Math.floor(s.n / 8);
        s.cur = ((s.cur << 1) | (now - s.upAt > 550 ? 1 : 0)) & 255;
        if (s.n % 8 === 7) { s.pix[Math.floor(byte / 3) * 3 + GRB[byte % 3]] = s.cur; s.cur = 0; ctx.changed(); }
        s.n++;
      }
      s.downAt = now;
    }
    s.last = l;
  };
  const drives = () => (powered(ctx, vcc, gnd) ? [{ pin: 'DOUT', level: (s.fwd ? 1 : 0) as Level }] : []);
  return { s, onChange, drives };
}
const neopixel: PartDef = {
  type: 'neopixel', pins: ['VDD', 'DOUT', 'VSS', 'DIN'],
  ui: { label: 'NeoPixel LED', tag: 'wokwi-neopixel', group: 'Displays', show: { r: 'r', g: 'g', b: 'b' } },
  links: () => [],
  device(ctx) {
    const p = pixelChain(ctx, 1, 'VDD', 'VSS');
    return { onChange: p.onChange, drives: p.drives, outputs: () => ({ r: p.s.pix[0] / 255, g: p.s.pix[1] / 255, b: p.s.pix[2] / 255 }), ...keep(p.s) };
  },
};
const strip = (type: string, label: string, count: (a: Record<string, string>) => number, attrs: string[]): PartDef => ({
  type, pins: ['GND', 'VCC', 'DIN', 'DOUT'], attrs,
  ui: { label, tag: `wokwi-${type}`, group: 'Displays', paint: 'pixels' },
  links: () => [],
  device(ctx) {
    const p = pixelChain(ctx, Math.min(1024, Math.max(1, count(ctx.attrs))), 'VCC', 'GND');
    return { onChange: p.onChange, drives: p.drives, outputs: () => ({ pixels: [...p.s.pix] }), ...keep(p.s) };
  },
});

export const displays: PartDef[] = [
  lcd('lcd1602', 'LCD 16x2', 2, 16), lcd('lcd2004', 'LCD 20x4', 4, 20), oled, neopixel,
  strip('led-ring', 'NeoPixel ring', (a) => Number(a.pixels) || 16, ['pixels']),
  strip('neopixel-matrix', 'NeoPixel matrix', (a) => (Number(a.rows) || 8) * (Number(a.cols) || 8), ['rows', 'cols']),
];
