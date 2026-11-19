// Switches, knobs and the relay.
import type { PartDef } from '../part.ts';
import type { Link } from '../nets.ts';
import type { Level } from '../types.ts';
import { fed, keep, press } from './util.ts';

const dipSwitch: PartDef = {
  contact: true,
  type: 'dip-switch-8', pins: [...Array.from({ length: 8 }, (_, i) => `${i + 1}a`), ...Array.from({ length: 8 }, (_, i) => `${i + 1}b`)],
  ui: { label: 'DIP switch (8)', tag: 'wokwi-dip-switch-8', group: 'Switches and knobs', events: [{ on: 'switch-change', from: 'dip' }] },
  controls: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`sw${i + 1}`, { kind: 'toggle' as const, initial: 0, label: `Switch ${i + 1}` }])),
  links: (id, s) => Array.from({ length: 8 }, (_, i) => i + 1).filter((n) => s[`sw${n}`]).map((n): Link => ({ a: `${id}:${n}a`, b: `${id}:${n}b`, kind: 'wire' })),
};

const keypad: PartDef = {
  contact: true,
  type: 'membrane-keypad', pins: ['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4'], attrs: ['columns'],
  ui: { label: 'Keypad', tag: 'wokwi-membrane-keypad', group: 'Switches and knobs', events: [{ on: 'button-press', control: 'key', from: 'keypad' }, { on: 'button-release', control: 'key', value: 0 }] },
  // 0 is no key; otherwise 1..16 counting along the rows of a 4-wide pad.
  controls: { key: { kind: 'range', min: 0, max: 16, initial: 0 } },
  links: (id, s) => (s.key ? [{ a: `${id}:R${Math.floor((s.key - 1) / 4) + 1}`, b: `${id}:C${((s.key - 1) % 4) + 1}`, kind: 'wire' }] : []),
};

const joystick: PartDef = {
  type: 'analog-joystick', pins: ['VCC', 'VERT', 'HORZ', 'SEL', 'GND'],
  ui: { label: 'Joystick', tag: 'wokwi-analog-joystick', group: 'Switches and knobs', events: [{ on: 'input', from: 'joystick' }, ...press] },
  controls: { x: { kind: 'range', min: -1, max: 1, initial: 0, step: 0.01, label: 'Left / right' }, y: { kind: 'range', min: -1, max: 1, initial: 0, step: 0.01, label: 'Down / up' }, pressed: { kind: 'momentary', initial: 0 } },
  links: (id, s) => (s.pressed ? [{ a: `${id}:SEL`, b: `${id}:GND`, kind: 'wire' }] : []),
  analog: (id, s, level) => (fed(level, id) ? [{ node: `${id}:HORZ`, volts: ((s.x + 1) / 2) * 5 }, { node: `${id}:VERT`, volts: ((s.y + 1) / 2) * 5 }] : []),
};

const slidePot: PartDef = {
  type: 'slide-potentiometer', pins: ['VCC', 'SIG', 'GND'],
  ui: { label: 'Slide potentiometer', tag: 'wokwi-slide-potentiometer', group: 'Switches and knobs', events: [{ on: 'input', control: 'value', from: 'pot' }] },
  controls: { value: { kind: 'range', min: 0, max: 1023, initial: 0 } },
  links: () => [],
  analog: (id, s, level) => (fed(level, id) ? [{ node: `${id}:SIG`, volts: (s.value / 1023) * 5 }] : []),
};

const STEP_NS = 2e6;              // time between the two contacts closing on one click
const encoder: PartDef = {
  type: 'ky-040', pins: ['CLK', 'DT', 'SW', 'VCC', 'GND'],
  ui: { label: 'Rotary encoder', tag: 'wokwi-ky-040', group: 'Switches and knobs', events: [{ on: 'rotate-cw', control: 'position', delta: 1 }, { on: 'rotate-ccw', control: 'position', delta: -1 }, ...press] },
  controls: { position: { kind: 'range', min: -1e6, max: 1e6, initial: 0, step: 1 }, pressed: { kind: 'momentary', initial: 0 } },
  links: () => [],
  device(ctx) {
    const s = { pos: 0, clk: 1 as Level, dt: 1 as Level, busy: false };
    const click = (cw: boolean): void => {
      // The leading contact falls first: CLK for clockwise, DT for counter-clockwise.
      const first = cw ? 'clk' : 'dt', second = cw ? 'dt' : 'clk';
      s.busy = true; s[first] = 0; ctx.changed();
      ctx.after(STEP_NS, () => { s[second] = 0; ctx.changed(); });
      ctx.after(2 * STEP_NS, () => { s[first] = 1; ctx.changed(); });
      ctx.after(3 * STEP_NS, () => { s[second] = 1; s.pos += cw ? 1 : -1; s.busy = false; ctx.changed(); });
    };
    return {
      drives: () => [{ pin: 'CLK', level: s.clk }, { pin: 'DT', level: s.dt }, { pin: 'SW', level: ctx.control('pressed') ? 0 : 1 }],
      onChange() { const want = Math.round(ctx.control('position')); if (!s.busy && want !== s.pos) click(want > s.pos); },
      ...keep(s),
    };
  },
};

const relay: PartDef = {
  type: 'ks2e-m-dc5', pins: ['NO2', 'NC2', 'P2', 'COIL2', 'NO1', 'NC1', 'P1', 'COIL1'],
  ui: { label: 'Relay', tag: 'wokwi-ks2e-m-dc5', group: 'Motors and switching' },
  links: (id, _s, level) => {
    const a = level(`${id}:COIL1`), b = level(`${id}:COIL2`), on = a !== null && b !== null && a !== b;
    return [1, 2].map((n): Link => ({ a: `${id}:P${n}`, b: `${id}:${on ? 'NO' : 'NC'}${n}`, kind: 'wire' }));
  },
  outputs: (id, level) => { const a = level(`${id}:COIL1`), b = level(`${id}:COIL2`); return { on: a !== null && b !== null && a !== b }; },
  check: (id, see) => {
    const a = see.level(`${id}:COIL1`), b = see.level(`${id}:COIL2`);
    const pin = see.boardPin(`${id}:COIL1`) ?? see.boardPin(`${id}:COIL2`);
    return a !== null && b !== null && a !== b && pin ? [`${id}'s coil is driven straight from ${pin}: a relay coil needs more current than a pin can give. Switch it with a transistor, or use a relay module.`] : [];
  },
};

export const inputs: PartDef[] = [dipSwitch, keypad, joystick, slidePot, encoder, relay];
