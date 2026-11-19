// Things that supply power: batteries, regulators, a breadboard power module,
// and what sits in a supply line (a switch, a fuse). A source drives its
// positive pin high and its negative pin low, so whatever it feeds is powered.
import type { PartDef } from '../part.ts';
import { fed } from './util.ts';

const GROUP = 'Power';
const BOARD_MAX = 5.5;            // an Uno pin takes no more than its own 5 V supply

const battery = (type: string, label: string, volts: number): PartDef => ({
  type, pins: ['+', '-'],
  ui: { label, tag: `shibo-${type}`, group: GROUP },
  links: () => [],
  // A cell in series (its - on another cell's +) is let off its - by the circuit: see `cell`.
  cell: true,
  drives: () => [{ pin: '+', level: 1 }, { pin: '-', level: 0 }],
  analog: (id) => [{ node: `${id}:+`, volts }],
  check(id, see) {
    const pin = see.boardPin(`${id}:+`);
    return volts > BOARD_MAX && pin ? [`${id} puts ${volts} V straight on ${pin}, which takes at most 5 V: it can destroy the pin. Feed the board through its VIN pin or barrel jack, or step the voltage down (a regulator, or a divider for measuring).`] : [];
  },
});

const regulator = (type: string, label: string, volts: number): PartDef => ({
  type, pins: ['IN', 'GND', 'OUT'],
  ui: { label, tag: `shibo-${type}`, group: GROUP },
  links: () => [],
  drives: (id, _s, level) => (fed(level, id, 'IN') ? [{ pin: 'OUT', level: 1 }] : []),
  analog: (id, _s, level) => (fed(level, id, 'IN') ? [{ node: `${id}:OUT`, volts }] : []),
  outputs: (id, level) => ({ powered: fed(level, id, 'IN') }),
});

const powerSwitch: PartDef = {
  contact: true,
  type: 'power-switch', pins: ['1', '2'],
  ui: { label: 'Power switch', tag: 'shibo-power-switch', group: GROUP, events: [{ on: 'input', control: 'on', from: 'value' }] },
  controls: { on: { kind: 'toggle', initial: 0, label: 'On' } },
  links: (id, s) => (s.on ? [{ a: `${id}:1`, b: `${id}:2`, kind: 'wire' }] : []),
  outputs: (_id, _l, s) => ({ on: Boolean(s.on) }),
};

const fuse: PartDef = {
  type: 'fuse', pins: ['1', '2'], attrs: ['rating'],
  ui: { label: 'Fuse', tag: 'shibo-fuse', group: GROUP, show: { blown: 'blown' } },
  // Nothing here knows currents, so a fuse blows only when you say so: try what your circuit does without it.
  controls: { blown: { kind: 'toggle', initial: 0, label: 'Blown' } },
  links: (id, s) => (s.blown ? [] : [{ a: `${id}:1`, b: `${id}:2`, kind: 'wire' }]),
  outputs: (_id, _l, s) => ({ blown: Boolean(s.blown) }),
};

/** The MB102 breadboard supply: a barrel jack in, two rails out, each set to 5 V or 3.3 V by a jumper. */
const powerModule: PartDef = {
  type: 'power-module', pins: ['VCC1', 'GND1', 'VCC2', 'GND2'], attrs: ['left', 'right'],
  ui: { label: 'Breadboard power module', tag: 'shibo-power-module', group: GROUP, events: [{ on: 'input', control: 'on', from: 'value' }] },
  controls: { on: { kind: 'toggle', initial: 1, label: 'On' } },
  links: () => [],
  device(ctx) {
    const volts = (rail: string | undefined) => (/^3/.test(rail ?? '') ? 3.3 : 5);
    const on = () => ctx.control('on') === 1;
    return {
      drives: () => (on() ? [{ pin: 'VCC1', level: 1 }, { pin: 'GND1', level: 0 }, { pin: 'VCC2', level: 1 }, { pin: 'GND2', level: 0 }] : []),
      analog: () => (on() ? [{ pin: 'VCC1', volts: volts(ctx.attrs.left) }, { pin: 'VCC2', volts: volts(ctx.attrs.right) }] : []),
      outputs: () => ({ on: on() }),
      save: () => null, restore() {},
    };
  },
};

export const power: PartDef[] = [battery('battery-9v', 'Battery (9V)', 9), battery('battery-aa4', 'Battery pack (4 x AA)', 6), battery('lipo', 'LiPo cell (3.7V)', 3.7),
  regulator('lm7805', 'Voltage regulator (LM7805, 5V)', 5), regulator('ams1117', 'Voltage regulator (AMS1117, 3.3V)', 3.3), powerSwitch, fuse, powerModule];
