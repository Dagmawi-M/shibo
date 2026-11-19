// Indicators and the simplest inputs.
import type { PartDef } from '../part.ts';
import { duty, dutyEdge, dutyRead, keep, press } from './util.ts';

const NO_RESISTOR = (id: string) => `${id} is lit with no resistor in its path: a real LED would burn out or overload the pin. Put a resistor (220 Ω is typical) in series with it.`;

const led: PartDef = {
  type: 'led', pins: ['A', 'C'], attrs: ['color', 'flip'],
  ui: { label: 'LED', tag: 'wokwi-led', group: 'Lights and sound', show: { value: 'lit', brightness: 'brightness' } },
  links: () => [],
  outputs: (id, level) => ({ lit: level(`${id}:A`) === 1 && level(`${id}:C`) === 0 }),
  check: (id, see) => (see.level(`${id}:A`) === 1 && see.level(`${id}:C`) === 0 && see.strong(`${id}:A`) && see.strong(`${id}:C`) ? [NO_RESISTOR(id)] : []),
  device(ctx) {
    const s = duty(ctx.now());
    return {
      onChange() { dutyEdge(s, ctx.level('A') === 1 && ctx.level('C') === 0, ctx.now()); },
      display() { const f = dutyRead(s, ctx.now()); return { lit: f > 0.01, brightness: Math.round(f * 100) / 100 }; },
      ...keep(s),
    };
  },
};

const rgbLed: PartDef = {
  type: 'rgb-led', pins: ['R', 'G', 'B', 'COM'], attrs: ['common'],
  ui: { label: 'RGB LED', tag: 'wokwi-rgb-led', group: 'Lights and sound', show: { ledRed: 'r', ledGreen: 'g', ledBlue: 'b' } },
  links: () => [],
  check: (id, see) => {
    const com = see.level(`${id}:COM`);
    const bare = ['R', 'G', 'B'].some((p) => { const l = see.level(`${id}:${p}`); return l !== null && com !== null && l !== com && see.strong(`${id}:${p}`) && see.strong(`${id}:COM`); });
    return bare ? [NO_RESISTOR(id)] : [];
  },
  device(ctx) {
    const anode = ctx.attrs.common === 'anode';
    const on = (pin: string) => (anode ? ctx.level('COM') === 1 && ctx.level(pin) === 0 : ctx.level('COM') === 0 && ctx.level(pin) === 1);
    const s = { r: duty(ctx.now()), g: duty(ctx.now()), b: duty(ctx.now()) };
    return {
      onChange() { const n = ctx.now(); dutyEdge(s.r, on('R'), n); dutyEdge(s.g, on('G'), n); dutyEdge(s.b, on('B'), n); },
      outputs: () => ({ r: on('R'), g: on('G'), b: on('B') }),
      display() { const n = ctx.now(); const f = (d: typeof s.r) => Math.round(dutyRead(d, n) * 100) / 100; return { r: f(s.r), g: f(s.g), b: f(s.b) }; },
      ...keep(s),
    };
  },
};

const ledBarGraph: PartDef = {
  type: 'led-bar-graph', pins: [...Array.from({ length: 10 }, (_, i) => `A${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `C${i + 1}`)], attrs: ['color'],
  ui: { label: 'LED bar graph', tag: 'wokwi-led-bar-graph', group: 'Lights and sound', show: { values: 'values' } },
  links: () => [],
  outputs: (id, level) => ({ values: Array.from({ length: 10 }, (_, i) => (level(`${id}:A${i + 1}`) === 1 && level(`${id}:C${i + 1}`) === 0 ? 1 : 0)) }),
};

const SEGS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];
const PERSIST_NS = 20e6;          // the eye holds a multiplexed digit about this long
const sevenSegment: PartDef = {
  type: '7segment', pins: [...SEGS, 'COM', 'COM.1', 'COM.2', 'DIG1', 'DIG2', 'DIG3', 'DIG4', 'CLN'], attrs: ['digits', 'common', 'color', 'colon'],
  ui: { label: '7-segment display', tag: 'wokwi-7segment', group: 'Lights and sound', show: { values: 'values' } },
  links: (id) => [{ a: `${id}:COM.1`, b: `${id}:COM.2`, kind: 'wire' }, { a: `${id}:COM.1`, b: `${id}:COM`, kind: 'wire' }],
  device(ctx) {
    const digits = Math.min(4, Math.max(1, Number(ctx.attrs.digits) || 1));
    const cathode = ctx.attrs.common === 'cathode';
    const s = { last: Array<number>(digits * 8).fill(-1) };
    const now = (): number[] => {
      const v: number[] = [];
      for (let d = 0; d < digits; d++) {
        const com = ctx.level(digits === 1 ? 'COM.1' : `DIG${d + 1}`);
        for (const seg of SEGS) v.push((cathode ? com === 0 && ctx.level(seg) === 1 : com === 1 && ctx.level(seg) === 0) ? 1 : 0);
      }
      return v;
    };
    return {
      onChange() { const t = ctx.now(); now().forEach((x, i) => { if (x) s.last[i] = t; }); },
      outputs: () => ({ values: now() }),
      display() { const t = ctx.now(), v = now(); return { values: v.map((x, i) => (x || (s.last[i] >= 0 && t - s.last[i] < PERSIST_NS) ? 1 : 0)) }; },
      ...keep(s),
    };
  },
};

const buzzer: PartDef = {
  type: 'buzzer', pins: ['1', '2'],
  ui: { label: 'Buzzer', tag: 'wokwi-buzzer', group: 'Lights and sound', show: { hasSignal: 'on' } },
  links: () => [],
  outputs: (id, level) => { const a = level(`${id}:1`), b = level(`${id}:2`); return { on: a !== null && b !== null && a !== b }; },
  device(ctx) {
    const s = duty(ctx.now());
    return {
      onChange() { const a = ctx.level('1'), b = ctx.level('2'); dutyEdge(s, a !== null && b !== null && a !== b, ctx.now()); },
      display: () => ({ on: dutyRead(s, ctx.now()) > 0.01 }),       // a tone is a square wave: sounding, not flickering
      ...keep(s),
    };
  },
};

const resistor: PartDef = {
  type: 'resistor', pins: ['1', '2'], attrs: ['value'],
  ui: { label: 'Resistor', tag: 'wokwi-resistor', group: 'Basics' },
  links: (id) => [{ a: `${id}:1`, b: `${id}:2`, kind: 'resistor' }],
};

const button = (type: string, label: string): PartDef => ({
  contact: true,
  type, pins: ['1.l', '1.r', '2.l', '2.r'], attrs: ['color'],
  ui: { label, tag: `wokwi-${type}`, group: 'Switches and knobs', events: press },
  controls: { pressed: { kind: 'momentary', initial: 0 } },
  links: (id, s) => [
    { a: `${id}:1.l`, b: `${id}:1.r`, kind: 'wire' },
    { a: `${id}:2.l`, b: `${id}:2.r`, kind: 'wire' },
    ...(s.pressed ? [{ a: `${id}:1.l`, b: `${id}:2.l`, kind: 'wire' as const }] : []),
  ],
});

const slideSwitch: PartDef = {
  contact: true,
  type: 'slide-switch', pins: ['1', '2', '3'], attrs: ['value'],
  ui: { label: 'Slide switch', tag: 'wokwi-slide-switch', group: 'Switches and knobs', events: [{ on: 'input', control: 'value', from: 'value' }] },
  controls: { value: { kind: 'toggle', initial: 0 } },
  links: (id, s) => [{ a: `${id}:2`, b: `${id}:${s.value ? 3 : 1}`, kind: 'wire' }],
};

const potentiometer: PartDef = {
  type: 'potentiometer', pins: ['GND', 'SIG', 'VCC'], attrs: ['value'],
  ui: { label: 'Potentiometer', tag: 'wokwi-potentiometer', group: 'Switches and knobs', events: [{ on: 'input', control: 'value', from: 'pot' }] },
  controls: { value: { kind: 'range', min: 0, max: 1023, initial: 0 } },
  links: () => [],
  analog: (id, s) => [{ node: `${id}:SIG`, volts: (s.value / 1023) * 5 }],
};

export const basic: PartDef[] = [led, rgbLed, ledBarGraph, sevenSegment, buzzer, resistor, button('pushbutton', 'Push button'), button('pushbutton-6mm', 'Push button (small)'), slideSwitch, potentiometer];
