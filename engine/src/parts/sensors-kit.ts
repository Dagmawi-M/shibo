// Building blocks for the sensor modules in sensors-*.ts.
import type { ControlDef, Device, PartCtx, PartDef } from '../part.ts';
import type { Level } from '../types.ts';
import { fed, powered } from './util.ts';

type State = Record<string, number>;

export interface Module {
  type: string; label: string; pins: string[]; controls: Record<string, ControlDef>;
  /** Supply and ground pin names, if not VCC and GND. */
  vcc?: string; gnd?: string;
  /** Pins joined inside the module (a current sensor's IP+ and IP-). */
  joined?: [string, string][];
  analog?: Record<string, (s: State) => number>;
  digital?: Record<string, (s: State) => Level>;
  /** A module with no supply pin: it only needs its ground pin low. */
  passive?: boolean;
  contact?: boolean;
}

export const tagOf = (type: string): string => `shibo-${type}`;
export const ui = (type: string, label: string) => ({ label, tag: tagOf(type), group: 'Sensors' });

/** A module with no memory: each output pin is a function of the sliders while it is powered. */
export function module(d: Module): PartDef {
  const on = (level: (n: string) => Level, id: string) => (d.passive ? level(`${id}:${d.gnd ?? 'GND'}`) === 0 : fed(level, id, d.vcc, d.gnd));
  return {
    type: d.type, pins: d.pins, controls: d.controls, ui: ui(d.type, d.label), ...(d.contact ? { contact: true } : {}),
    links: (id) => (d.joined ?? []).map(([a, b]) => ({ a: `${id}:${a}`, b: `${id}:${b}`, kind: 'wire' as const })),
    outputs: (id, level) => ({ powered: on(level, id) }),
    analog: (id, s, level) => (on(level, id) ? Object.entries(d.analog ?? {}).map(([pin, f]) => ({ node: `${id}:${pin}`, volts: clamp(f(s), 0, 5) })) : []),
    drives: (id, s, level) => (on(level, id) ? Object.entries(d.digital ?? {}).map(([pin, f]) => ({ pin, level: f(s) })) : []),
  };
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const range = (min: number, max: number, initial: number, label: string, unit?: string, step = 1): ControlDef =>
  ({ kind: 'range', min, max, initial, step, label, ...(unit ? { unit } : {}) });
export const toggle = (label: string, initial = 0): ControlDef => ({ kind: 'toggle', initial, label });
/** The trimmer on a comparator module (LM393), as a percentage of the supply. */
export const knob = (initial = 50): ControlDef => range(0, 100, initial, 'Threshold knob', '%');
/** An LM393 comparator output: high while the analog side is above the knob's voltage. */
export const above = (volts: number, s: State): Level => (volts > (s.threshold / 100) * 5 ? 1 : 0);

// ---- I2C register maps ----

/** A chip with 8-bit registers and an auto-incrementing pointer, the common I2C layout. */
export interface Regs {
  ptr: number; first: boolean;
}
export function regBus(ctx: PartCtx, s: Regs, o: {
  sda?: string; scl?: string; address(): number; size?: number;
  read(reg: number): number; write(reg: number, v: number): void;
  /** The pointer after reading reg; by default the next register. */
  next?(reg: number): number;
}): NonNullable<Device['i2c']> {
  const size = o.size ?? 256;
  return {
    sda: o.sda ?? 'SDA', scl: o.scl ?? 'SCL', address: o.address,
    start(write) { s.first = write; },
    write(b) {
      if (s.first) { s.first = false; s.ptr = b % size; return true; }
      o.write(s.ptr, b & 255); s.ptr = (s.ptr + 1) % size; return true;
    },
    read() { const r = s.ptr, v = o.read(r) & 255; s.ptr = (o.next ? o.next(r) : r + 1) % size; return v; },
  };
}

export const i16 = (v: number): number => clamp(Math.round(v), -32768, 32767) & 0xffff;

/** Sensirion's CRC-8 (polynomial 0x31, start 0xFF). */
export function crc8(bytes: number[]): number {
  let c = 0xff;
  for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x31) & 255 : (c << 1) & 255; }
  return c;
}

// ---- waveforms ----

/**
 * A voltage that changes with time (mains, a sound). The engine only hands a
 * board new analog values when something changes, so while the wave is
 * running the device asks to be looked at again every `step` nanoseconds.
 */
export function wave(ctx: PartCtx, s: { run: number; on: boolean }, o: { step(): number; active(): boolean }) {
  const tick = (run: number): void => {
    if (run !== s.run) return;
    if (!o.active()) { s.on = false; return; }
    ctx.changed();
    ctx.after(o.step(), () => tick(run));
  };
  return {
    /** Call from onChange: starts the ticks when the wave becomes active. */
    poke(): void { if (!s.on && o.active()) { s.on = true; const run = ++s.run; ctx.after(o.step(), () => tick(run)); } },
  };
}
export { powered };
