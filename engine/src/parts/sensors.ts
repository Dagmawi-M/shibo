// Sensors whose output follows a value you set with a slider.
import type { ControlDef, PartDef } from '../part.ts';
import type { Level } from '../types.ts';
import { fed, keep, powered } from './util.ts';

interface Simple {
  type: string; label: string; pins: string[]; controls: Record<string, ControlDef>;
  analog?: Record<string, (s: Record<string, number>) => number>;
  digital?: Record<string, (s: Record<string, number>) => Level>;
}
/** A sensor with no memory: each output pin is a function of the sliders, when powered. */
const simple = (d: Simple): PartDef => ({
  type: d.type, pins: d.pins, controls: d.controls,
  ui: { label: d.label, tag: `wokwi-${d.type}`, group: 'Sensors' },
  links: () => [],
  outputs: (id, level) => ({ powered: fed(level, id) }),
  analog: (id, s, level) => (fed(level, id) ? Object.entries(d.analog ?? {}).map(([pin, f]) => ({ node: `${id}:${pin}`, volts: f(s) })) : []),
  drives: (id, s, level) => (fed(level, id) ? Object.entries(d.digital ?? {}).map(([pin, f]) => ({ pin, level: f(s) })) : []),
});

// The light sensor module: an LDR (gamma 0.7, 50 k at 10 lux) over a 10 k resistor.
const ldrVolts = (lux: number) => { const r = 50e3 * Math.pow(10 / Math.max(lux, 0.01), 0.7); return (5 * r) / (r + 10e3); };
// A 10 k NTC thermistor (beta 3950) with a 10 k partner.
const ntcVolts = (c: number) => { const r = 10e3 * Math.exp(3950 * (1 / (c + 273.15) - 1 / 298.15)); return (5 * r) / (r + 10e3); };

const sound = (type: string, label: string) => simple({
  type, label, pins: ['AOUT', 'GND', 'VCC', 'DOUT'],
  controls: { level: { kind: 'range', min: 0, max: 1023, initial: 0, step: 1, label: 'Loudness' } },
  analog: { AOUT: (s) => (s.level / 1023) * 5 }, digital: { DOUT: (s) => (s.level > 512 ? 1 : 0) },
});

const heartBeat: PartDef = {
  type: 'heart-beat-sensor', pins: ['GND', 'VCC', 'OUT'],
  ui: { label: 'Heartbeat sensor', tag: 'wokwi-heart-beat-sensor', group: 'Sensors' },
  controls: { bpm: { kind: 'range', min: 0, max: 220, initial: 0, step: 1, label: 'Heart rate', unit: 'bpm' } },
  links: () => [],
  device(ctx) {
    const s = { out: 0 as Level, bpm: 0, run: 0 };
    const beat = (run: number): void => {
      if (run !== s.run || s.bpm <= 0) return;
      s.out = 1; ctx.changed();
      ctx.after(100e6, () => { if (run === s.run) { s.out = 0; ctx.changed(); } });
      ctx.after(60e9 / s.bpm, () => beat(run));
    };
    return {
      drives: () => (powered(ctx) ? [{ pin: 'OUT', level: s.out }] : []),
      onChange() { const bpm = ctx.control('bpm'); if (bpm !== s.bpm) { s.bpm = bpm; s.out = 0; const run = ++s.run; ctx.after(0, () => beat(run)); } },
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

export const sensors: PartDef[] = [
  simple({ type: 'photoresistor-sensor', label: 'Light sensor (LDR)', pins: ['VCC', 'GND', 'DO', 'AO'],
    controls: { lux: { kind: 'range', min: 0.1, max: 100000, initial: 500, log: true, label: 'Light', unit: 'lux' } },
    analog: { AO: (s) => ldrVolts(s.lux) }, digital: { DO: (s) => (ldrVolts(s.lux) > 2.5 ? 1 : 0) } }),
  simple({ type: 'ntc-temperature-sensor', label: 'Temperature sensor (NTC)', pins: ['GND', 'VCC', 'OUT'],
    controls: { temperature: { kind: 'range', min: -24, max: 80, initial: 25, step: 0.1, label: 'Temperature', unit: '°C' } },
    analog: { OUT: (s) => ntcVolts(s.temperature) } }),
  simple({ type: 'gas-sensor', label: 'Gas sensor', pins: ['AOUT', 'DOUT', 'GND', 'VCC'],
    controls: { ppm: { kind: 'range', min: 0, max: 10000, initial: 0, step: 10, label: 'Gas', unit: 'ppm' } },
    analog: { AOUT: (s) => 0.4 + (s.ppm / 10000) * 4.4 }, digital: { DOUT: (s) => (s.ppm > 2000 ? 0 : 1) } }),
  simple({ type: 'flame-sensor', label: 'Flame sensor', pins: ['VCC', 'GND', 'DOUT', 'AOUT'],
    controls: { flame: { kind: 'toggle', initial: 0, label: 'Flame present' } },
    analog: { AOUT: (s) => (s.flame ? 0.5 : 4.5) }, digital: { DOUT: (s) => (s.flame ? 0 : 1) } }),
  sound('big-sound-sensor', 'Sound sensor (large)'), sound('small-sound-sensor', 'Sound sensor (small)'),
  simple({ type: 'pir-motion-sensor', label: 'Motion sensor (PIR)', pins: ['VCC', 'OUT', 'GND'],
    controls: { motion: { kind: 'toggle', initial: 0, label: 'Motion' } }, digital: { OUT: (s) => (s.motion ? 1 : 0) } }),
  simple({ type: 'tilt-switch', label: 'Tilt switch', pins: ['GND', 'VCC', 'OUT'],
    controls: { tilted: { kind: 'toggle', initial: 0, label: 'Tilted' } }, digital: { OUT: (s) => (s.tilted ? 1 : 0) } }),
  heartBeat,
];
