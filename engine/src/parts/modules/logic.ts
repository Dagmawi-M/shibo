// Logic chips that sit between a board and many pins: shift registers and
// an analog multiplexer.
import type { PartDef } from '../../part.ts';
import type { Link } from '../../nets.ts';
import type { Level } from '../../types.ts';
import { keep, powered } from '../util.ts';

const Q = Array.from({ length: 8 }, (_, i) => `Q${i}`);
const D = Array.from({ length: 8 }, (_, i) => `D${i}`);
const bit = (l: Level): number => (l === 1 ? 1 : 0);
const rose = (was: Level, now: Level) => now === 1 && was !== 1;

/** A chip whose control pin is left unwired is a common slip; real chips then act at random. */
const loose = (pins: string[], why: Record<string, string>) => (id: string, see: { level(n: string): Level }) =>
  see.level(`${id}:VCC`) === 1 ? pins.filter((p) => see.level(`${id}:${p}`) === null).map((p) => `${id} pin ${p} is not connected: ${why[p]}`) : [];

// ---------- 74HC595: serial in, eight latched outputs ----------
const hc595: PartDef = {
  type: '74hc595', pins: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'GND', 'Q7S', 'MR', 'SHCP', 'STCP', 'OE', 'DS', 'Q0', 'VCC'],
  ui: { label: 'Shift register out (74HC595)', tag: 'shibo-74hc595', group: 'Modules' },
  links: () => [],
  check: loose(['MR', 'OE'], { MR: 'wire it to 5V, or the register may clear itself.', OE: 'wire it to GND, or the outputs may switch off.' }),
  device(ctx) {
    const s = { sr: 0, latch: 0, sh: null as Level, st: null as Level };
    const on = () => powered(ctx);
    const shift = (b: number) => { s.sr = ((s.sr << 1) | b) & 255; };
    return {
      drives() {
        if (!on()) return [];
        const out: { pin: string; level: Level }[] = [{ pin: 'Q7S', level: (s.sr >> 7) as Level }];
        // OE is active low: high lets go of all eight outputs.
        const enabled = ctx.level('OE') !== 1;
        for (let i = 0; i < 8; i++) out.push({ pin: Q[i], level: enabled ? (((s.latch >> i) & 1) as Level) : null });
        return out;
      },
      onChange() {
        const sh = ctx.level('SHCP'), st = ctx.level('STCP');
        if (on()) {
          let moved = false;
          if (ctx.level('MR') === 0) { if (s.sr) moved = true; s.sr = 0; }           // MR low clears the shift stage at once
          else if (rose(s.sh, sh)) { shift(bit(ctx.level('DS'))); moved = true; }
          if (rose(s.st, st)) { s.latch = s.sr; moved = true; }
          if (moved) ctx.changed();
        }
        s.sh = sh; s.st = st;
      },
      // With hardware SPI the clock pulses are not seen one by one: a whole byte arrives, most significant bit first.
      spi: { cs: 'STCP', sck: 'SHCP', transfer(b) { const out = s.sr; if (on() && ctx.level('MR') !== 0) s.sr = b & 255; return out; } },
      outputs: () => ({ values: Array.from({ length: 8 }, (_, i) => (s.latch >> i) & 1), powered: on() }),
      ...keep(s),
    };
  },
};

// ---------- 74HC165: eight inputs, read out serially ----------
const hc165: PartDef = {
  type: '74hc165', pins: ['PL', 'CP', 'D4', 'D5', 'D6', 'D7', 'Q7_N', 'GND', 'Q7', 'DS', 'D0', 'D1', 'D2', 'D3', 'CE', 'VCC'],
  ui: { label: 'Shift register in (74HC165)', tag: 'shibo-74hc165', group: 'Modules' },
  links: () => [],
  check: loose(['CE', 'PL'], { CE: 'wire it to GND (or a board pin held low), or the clock is ignored.', PL: 'wire it to a board pin: pulsing it low takes a reading.' }),
  device(ctx) {
    const s = { sr: 0, cp: null as Level };
    const on = () => powered(ctx);
    const load = () => { let v = 0; for (let i = 0; i < 8; i++) v |= bit(ctx.level(D[i])) << i; return v; };
    return {
      drives: () => (on() ? [{ pin: 'Q7', level: (s.sr >> 7) as Level }, { pin: 'Q7_N', level: (((s.sr >> 7) ^ 1) as Level) }] : []),
      onChange() {
        const cp = ctx.level('CP'), was = s.sr;
        if (on()) {
          // PL low copies the inputs in, and keeps copying while it stays low.
          if (ctx.level('PL') === 0) s.sr = load();
          else if (rose(s.cp, cp) && ctx.level('CE') !== 1) s.sr = ((s.sr << 1) | bit(ctx.level('DS'))) & 255;
          if (s.sr !== was) ctx.changed();
        }
        s.cp = cp;
      },
      spi: {
        cs: 'CE', sck: 'CP',
        transfer() {
          if (!on() || ctx.level('PL') === 0) return on() ? load() : 0xff;
          const out = s.sr; s.sr = ctx.level('DS') === 1 ? 255 : 0; return out;
        },
      },
      outputs: () => ({ powered: on() }),
      ...keep(s),
    };
  },
};

// ---------- CD4051: one common pin switched to one of eight channels ----------
const Y = Array.from({ length: 8 }, (_, i) => `Y${i}`);
const cd4051: PartDef = {
  type: 'cd4051', pins: ['Y4', 'Y6', 'COM', 'Y7', 'Y5', 'INH', 'VEE', 'GND', 'C', 'B', 'A', 'Y3', 'Y0', 'Y1', 'Y2', 'VCC'],
  ui: { label: 'Analog multiplexer (CD4051)', tag: 'shibo-cd4051', group: 'Modules' },
  links: () => [],
  device(ctx) {
    const s = {};
    const channel = (): number => {
      if (!powered(ctx) || ctx.level('INH') === 1) return -1;          // INH high opens every switch
      return bit(ctx.level('A')) | (bit(ctx.level('B')) << 1) | (bit(ctx.level('C')) << 2);
    };
    return {
      // The switch passes whatever is there, analog or digital, both ways.
      links: (): Link[] => { const c = channel(); return c < 0 ? [] : [{ a: `${ctx.id}:COM`, b: `${ctx.id}:${Y[c]}`, kind: 'wire' }]; },
      outputs: () => ({ channel: channel(), powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

export const logic: PartDef[] = [hc595, hc165, cd4051];
