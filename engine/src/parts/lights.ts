// LEDs and light modules: colour and size variants, bi-colour and common-anode
// RGB LEDs, the traffic-light module, laser and IR LEDs, a WS2812 strip, and
// the MAX7219 matrix and TM1637 display drivers.
import type { Device, PartCtx, PartDef } from '../part.ts';
import type { Level } from '../types.ts';
import { duty, dutyEdge, dutyRead, keep, powered } from './util.ts';
import { pixelChain } from './displays.ts';

const GROUP = 'Lights and sound';
const NO_RESISTOR = (id: string) => `${id} is lit with no resistor in its path: a real LED would burn out or overload the pin. Put a resistor (220 Ω is typical) in series with it.`;
const round = (x: number) => Math.round(x * 100) / 100;

// ---------- single LEDs ----------
/** A two-legged LED. `resistor`: it has one built in, so it needs none in series. */
function led(type: string, label: string, opts: { resistor?: boolean } = {}): PartDef {
  return {
    type, pins: ['A', 'C'], attrs: ['color', 'flip', 'size'],
    ui: { label, tag: `shibo-${type}`, group: GROUP, show: { value: 'lit', brightness: 'brightness' } },
    links: () => [],
    check: (id, see) => (!opts.resistor && see.level(`${id}:A`) === 1 && see.level(`${id}:C`) === 0 && see.strong(`${id}:A`) && see.strong(`${id}:C`) ? [NO_RESISTOR(id)] : []),
    device(ctx) {
      const s = duty(ctx.now());
      return {
        onChange() { dutyEdge(s, ctx.level('A') === 1 && ctx.level('C') === 0, ctx.now()); },
        outputs: () => ({ lit: ctx.level('A') === 1 && ctx.level('C') === 0 }),
        display() { const f = dutyRead(s, ctx.now()); return { lit: f > 0.01, brightness: round(f) }; },
        ...keep(s),
      };
    },
  };
}

export const LED_COLOURS = ['green', 'blue', 'yellow', 'white', 'orange', 'pink', 'purple'];
const LEDS: PartDef[] = [
  ...LED_COLOURS.map((c) => led(`led-${c}`, `LED (${c})`)),
  led('led-3mm', 'LED 3 mm (red)'), led('led-10mm', 'LED 10 mm (red)'),
  led('ir-led', 'Infrared LED (940 nm)'),
  led('led-resistor', 'LED with built-in resistor', { resistor: true }),
];

// ---------- several lamps in one package ----------
/**
 * Lamps that share one common leg. Each lamp lights while its own pin and the
 * common one differ the right way round. `resistors`: the board has them.
 */
function lamps(type: string, label: string, lamp: Record<string, string>, common: string, opts: { anodeAttr?: boolean; anode?: boolean; resistors?: boolean; pins?: string[] }): PartDef {
  const names = Object.keys(lamp);
  return {
    type, pins: opts.pins ?? [...names, common], attrs: opts.anodeAttr ? ['common'] : undefined,
    ui: { label, tag: `shibo-${type}`, group: GROUP, show: Object.fromEntries(names.map((p) => [lamp[p], lamp[p]])) },
    links: () => [],
    check: opts.resistors ? undefined : (id, see) => {
      const com = see.level(`${id}:${common}`);
      return names.some((p) => { const l = see.level(`${id}:${p}`); return l !== null && com !== null && l !== com && see.strong(`${id}:${p}`) && see.strong(`${id}:${common}`); }) ? [NO_RESISTOR(id)] : [];
    },
    device(ctx) {
      const anode = opts.anode ?? ctx.attrs.common === 'anode';
      const on = (p: string) => (anode ? ctx.level(common) === 1 && ctx.level(p) === 0 : ctx.level(common) === 0 && ctx.level(p) === 1);
      const s = Object.fromEntries(names.map((p) => [p, duty(ctx.now())]));
      return {
        onChange() { const n = ctx.now(); for (const p of names) dutyEdge(s[p], on(p), n); },
        outputs: () => Object.fromEntries(names.map((p) => [lamp[p], on(p)])),
        display() { const n = ctx.now(); return Object.fromEntries(names.map((p) => [lamp[p], round(dutyRead(s[p], n))])); },
        ...keep(s),
      };
    },
  };
}

const bicolor = lamps('led-bicolor', 'Bi-colour LED (red/green)', { R: 'red', G: 'green' }, 'C', { anodeAttr: true, pins: ['R', 'C', 'G'] });
const trafficLight = lamps('traffic-light', 'Traffic-light module', { R: 'red', Y: 'yellow', G: 'green' }, 'GND', { anode: false, resistors: true, pins: ['GND', 'R', 'Y', 'G'] });

/** The common-anode RGB LED: the same LED as rgb-led, with its common leg to 5V. */
const rgbAnode: PartDef = {
  ...lamps('rgb-led-anode', 'RGB LED (common anode)', { R: 'r', G: 'g', B: 'b' }, 'COM', { anode: true }),
  ui: { label: 'RGB LED (common anode)', tag: 'shibo-rgb-led-anode', group: GROUP, show: { ledRed: 'r', ledGreen: 'g', ledBlue: 'b' } },
};

/** KY-008 laser module: a laser diode with its resistor on the board; the middle pin is not connected. */
const laser: PartDef = {
  type: 'laser-module', pins: ['S', 'NC', 'GND'],
  ui: { label: 'Laser module (KY-008)', tag: 'shibo-laser-module', group: GROUP, show: { on: 'on' } },
  links: () => [],
  device(ctx) {
    const s = duty(ctx.now());
    const on = () => ctx.level('S') === 1 && ctx.level('GND') === 0;
    return {
      onChange() { dutyEdge(s, on(), ctx.now()); },
      outputs: () => ({ on: on() }),
      display() { const f = dutyRead(s, ctx.now()); return { on: f > 0.01, brightness: round(f) }; },
      ...keep(s),
    };
  },
};

// ---------- WS2812 strip ----------
const strip: PartDef = {
  type: 'led-strip', pins: ['GND', 'VCC', 'DIN', 'DOUT'], attrs: ['pixels'],
  ui: { label: 'NeoPixel strip (WS2812)', tag: 'shibo-led-strip', group: 'Displays', paint: 'pixels' },
  links: () => [],
  device(ctx) {
    const p = pixelChain(ctx, Math.min(1024, Math.max(1, Number(ctx.attrs.pixels) || 8)), 'VCC', 'GND');
    return { onChange: p.onChange, drives: p.drives, outputs: () => ({ pixels: [...p.s.pix] }), ...keep(p.s) };
  },
};

// ---------- MAX7219 8x8 LED matrix ----------
// A 16-bit shift register clocked on CLK's rising edge, latched when CS (LOAD)
// rises. DOUT gives out the register's top bit, changing on the falling
// edge (16.5 clocks of delay), so modules chain DOUT to DIN. It wakes up in shutdown.
interface Max { sr: number; next: number; dout: number; clk: Level; cs: Level; rows: number[]; shutdown: boolean; test: boolean; limit: number; intensity: number; decode: number }
const max7219: PartDef = {
  type: 'max7219-matrix', pins: ['VCC', 'GND', 'DIN', 'CS', 'CLK', 'DOUT'],
  ui: { label: 'LED matrix 8x8 (MAX7219)', tag: 'shibo-max7219-matrix', group: 'Displays', show: { values: 'values', intensity: 'intensity' } },
  links: () => [],
  device(ctx: PartCtx): Device {
    const s: Max = { sr: 0, next: 0, dout: 0, clk: null, cs: null, rows: Array<number>(8).fill(0), shutdown: true, test: false, limit: 7, intensity: 0, decode: 0 };
    const fed = () => powered(ctx);
    const latch = (w: number) => {
      const reg = (w >> 8) & 15, d = w & 255;
      if (reg >= 1 && reg <= 8) s.rows[reg - 1] = d;
      else if (reg === 9) s.decode = d;
      else if (reg === 10) s.intensity = d & 15;
      else if (reg === 11) s.limit = d & 7;
      else if (reg === 12) s.shutdown = !(d & 1);
      else if (reg === 15) s.test = Boolean(d & 1);
    };
    const shown = (): number[] => {
      const v: number[] = [];
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) v.push(fed() && (s.test || (!s.shutdown && r <= s.limit && (s.rows[r] >> (7 - c)) & 1)) ? 1 : 0);
      return v;
    };
    return {
      onChange() {
        const clk = ctx.level('CLK'), cs = ctx.level('CS');
        if (!fed()) { s.clk = clk; s.cs = cs; return; }
        if (clk === 1 && s.clk !== 1) { s.sr = ((s.sr << 1) | (ctx.level('DIN') === 1 ? 1 : 0)) & 0xffff; s.next = (s.sr >> 15) & 1; }
        if (clk !== 1 && s.clk === 1 && s.dout !== s.next) { s.dout = s.next; ctx.changed(); }
        if (cs === 1 && s.cs === 0) { latch(s.sr); ctx.changed(); }
        s.clk = clk; s.cs = cs;
      },
      drives: () => (fed() ? [{ pin: 'DOUT', level: s.dout as Level }] : []),
      outputs: () => ({ rows: [...s.rows], on: fed() && (s.test || !s.shutdown), intensity: s.intensity }),
      display: () => ({ values: shown(), intensity: s.intensity }),
      ...keep(s),
    };
  },
};

// ---------- TM1637 4-digit display ----------
// Two wires, both open-drain with pull-ups on the module. A start is DIO
// falling while CLK is high, a stop is DIO rising while CLK is high. Bits
// arrive least significant first, read as CLK rises; after eight, the chip
// holds DIO low through the ninth clock as its acknowledge.
interface Tm { clk: Level; dio: Level; frame: boolean; first: boolean; n: number; byte: number; ack: boolean; addr: number; fixed: boolean; digits: number[]; on: boolean; brightness: number }
const SEG_CHARS: Record<number, string> = { 0x3f: '0', 0x06: '1', 0x5b: '2', 0x4f: '3', 0x66: '4', 0x6d: '5', 0x7d: '6', 0x07: '7', 0x7f: '8', 0x6f: '9', 0x77: 'A', 0x7c: 'b', 0x39: 'C', 0x5e: 'd', 0x79: 'E', 0x71: 'F', 0x40: '-', 0x00: ' ' };
const tm1637: PartDef = {
  type: 'tm1637', pins: ['CLK', 'DIO', 'VCC', 'GND'],
  ui: { label: '4-digit display (TM1637)', tag: 'shibo-tm1637', group: 'Displays', show: { values: 'values', colon: 'colon', brightness: 'brightness' } },
  links: () => [],
  device(ctx: PartCtx): Device {
    const s: Tm = { clk: null, dio: null, frame: false, first: false, n: 0, byte: 0, ack: false, addr: 0, fixed: false, digits: [0, 0, 0, 0], on: false, brightness: 0 };
    const fed = () => powered(ctx);
    const take = (b: number) => {
      if (s.first) {
        s.first = false;
        const kind = b & 0xc0;
        if (kind === 0x40) s.fixed = Boolean(b & 4);
        else if (kind === 0xc0) s.addr = b & 7;
        else if (kind === 0x80) { s.on = Boolean(b & 8); s.brightness = b & 7; }
        return;
      }
      if (s.addr < 6) { if (s.addr < 4) s.digits[s.addr] = b; if (!s.fixed) s.addr++; }      // the chip has six grids; modules wire four
    };
    return {
      onChange() {
        const clk = ctx.level('CLK') === 1 ? 1 : 0, dio = ctx.level('DIO') === 1 ? 1 : 0;
        if (!fed()) { s.clk = clk; s.dio = dio; return; }
        if (clk === 1 && s.clk === 1 && dio !== s.dio && !s.ack) {
          if (dio === 0) { s.frame = true; s.first = true; s.n = 0; s.byte = 0; }
          else { s.frame = false; ctx.changed(); }
        } else if (s.frame && clk === 1 && s.clk === 0 && !s.ack) { s.byte |= dio << s.n; s.n++; }
        else if (s.frame && clk === 0 && s.clk === 1) {
          if (s.ack) { s.ack = false; s.n = 0; s.byte = 0; ctx.changed(); }
          else if (s.n === 8) { take(s.byte); s.ack = true; ctx.changed(); }
        }
        s.clk = clk; s.dio = ctx.level('DIO') === 1 ? 1 : 0;
      },
      drives: () => [{ pin: 'CLK', level: null, pull: 'up' }, { pin: 'DIO', level: s.ack && fed() ? 0 : null, pull: 'up' }],
      outputs: () => ({
        digits: [...s.digits], on: fed() && s.on, brightness: s.brightness,
        text: s.digits.map((d, i) => (SEG_CHARS[d & 0x7f] ?? '?') + (i === 1 && d & 0x80 ? ':' : '')).join(''),
      }),
      display: () => {
        const lit = fed() && s.on;
        return { values: s.digits.flatMap((d) => Array.from({ length: 8 }, (_, i) => (lit && i < 7 && (d >> i) & 1 ? 1 : 0))), colon: lit && Boolean(s.digits[1] & 0x80), brightness: lit ? s.brightness : 0 };
      },
      ...keep(s),
    };
  },
};

export const lights: PartDef[] = [...LEDS, bicolor, rgbAnode, trafficLight, laser, strip, max7219, tm1637];
