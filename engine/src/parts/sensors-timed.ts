// Sensors with memory or timing: a OneWire thermometer, motion sensors that hold
// their output, pulse trains, and voltages that are waveforms.
import type { ControlDef, PartCtx, PartDef } from '../part.ts';
import type { Level } from '../types.ts';
import { clamp, range, toggle, ui, wave } from './sensors-kit.ts';
import { keep, powered } from './util.ts';

const US = 1000, MS = 1e6, S = 1e9;

// ---------------- DS18B20 ----------------
/** Dallas/Maxim CRC-8 (polynomial x^8 + x^5 + x^4 + 1, bit-reversed 0x8C). */
export function crc8maxim(bytes: number[]): number {
  let c = 0;
  for (let b of bytes) for (let i = 0; i < 8; i++) { const mix = (c ^ b) & 1; c >>= 1; if (mix) c ^= 0x8c; b >>= 1; }
  return c;
}
/** A 64-bit ROM code: family 0x28, a serial number from the part's name, then the CRC. */
export function romFor(id: string): number[] {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const serial = [h & 255, (h >> 8) & 255, (h >> 16) & 255, (h >>> 24) & 255, (h * 7) & 255, 0];
  const rom = [0x28, ...serial];
  return [...rom, crc8maxim(rom)];
}
const bitsOf = (bytes: number[]) => bytes.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> i) & 1));
const CONVERT_NS = [93.75 * MS, 187.5 * MS, 375 * MS, 750 * MS];

type Mode = 'idle' | 'rom' | 'match' | 'search' | 'fn' | 'send' | 'convert' | 'scratch';
const ds18b20: PartDef = {
  type: 'ds18b20', pins: ['GND', 'DQ', 'VDD'], ui: ui('ds18b20', 'Temperature sensor (DS18B20)'),
  controls: { temperature: range(-55, 125, 24, 'Temperature', '°C', 0.0625) },
  links: () => [],
  device(ctx) {
    const rom = romFor(ctx.id), romBits = bitsOf(rom);
    const s = {
      last: 1 as Level, fallAt: -1, consumed: false, drive: null as Level, mode: 'idle' as Mode,
      got: [] as number[], out: [] as number[], next: 'idle' as Mode, step: 0, until: 0, quietUntil: -1,
      scratch: [0x50, 0x05, 0x4b, 0x46, 0x7f, 0xff, 0x0c, 0x10, 0], eeprom: [0x4b, 0x46, 0x7f],
    };
    const setCrc = () => { s.scratch[8] = crc8maxim(s.scratch.slice(0, 8)); };
    setCrc();
    // Powered from VDD, or "parasite" powered from the data line with VDD grounded.
    const fed = () => ctx.level('GND') === 0 && (ctx.level('VDD') === 1 || ctx.level('VDD') === 0);
    const external = () => ctx.level('VDD') === 1;
    const res = () => (s.scratch[4] >> 5) & 3;
    const measure = () => {
      const drop = 3 - res();
      const raw = (Math.round(clamp(ctx.control('temperature'), -55, 125) * 16) >> drop) << drop;     // lower resolutions leave the low bits 0
      s.scratch[0] = raw & 255; s.scratch[1] = (raw >> 8) & 255; setCrc();
    };
    const drive = (level: Level) => { s.drive = level; ctx.changed(); };
    const send = (bits: number[], then: Mode) => { s.out = [...bits]; s.next = then; s.mode = 'send'; };
    const alarm = () => { const t = ((s.scratch[1] << 8) | s.scratch[0]) << 16 >> 16 >> 4, th = (s.scratch[2] << 24) >> 24, tl = (s.scratch[3] << 24) >> 24; return t >= th || t <= tl; };

    /** Is the next time slot one the board reads (so this part answers it)? */
    const reading = () => s.mode === 'send' || s.mode === 'convert' || (s.mode === 'search' && s.step % 3 !== 2);
    const answer = (): number => {
      if (s.mode === 'convert') return ctx.now() >= s.until ? 1 : 0;
      if (s.mode === 'search') { const b = romBits[Math.floor(s.step / 3)]; const bit = s.step % 3 === 0 ? b : 1 - b; s.step++; return bit; }
      const bit = s.out.length ? s.out.shift()! : 1;
      if (!s.out.length) s.mode = s.next;
      return bit;
    };
    const command = (c: number): void => {
      if (s.mode === 'rom') {
        if (c === 0x33) send(romBits, 'fn');                          // read ROM
        else if (c === 0x55) { s.mode = 'match'; s.got = []; }      // match ROM
        else if (c === 0xcc) s.mode = 'fn';                           // skip ROM
        else if (c === 0xf0 || (c === 0xec && alarm())) { s.mode = 'search'; s.step = 0; }
        else s.mode = 'idle';
        return;
      }
      // function commands
      if (c === 0x44) { s.mode = 'convert'; s.until = ctx.now() + CONVERT_NS[res()]; ctx.after(CONVERT_NS[res()], measure); }
      else if (c === 0xbe) send(bitsOf(s.scratch), 'idle');
      else if (c === 0x4e) { s.mode = 'scratch'; s.got = []; }
      else if (c === 0x48) s.eeprom = [s.scratch[2], s.scratch[3], s.scratch[4]];
      else if (c === 0xb8) { [s.scratch[2], s.scratch[3], s.scratch[4]] = s.eeprom; setCrc(); }
      else if (c === 0xb4) send([external() ? 1 : 0], 'idle');
      else s.mode = 'idle';
    };
    const bit = (b: number): void => {
      if (s.mode === 'search') {
        // The board says which way it goes; a part whose ROM has the other bit drops out until the next reset.
        if (b !== romBits[Math.floor(s.step / 3)]) { s.mode = 'idle'; return; }
        s.step++; if (s.step >= 64 * 3) s.mode = 'fn';
        return;
      }
      if (s.mode === 'idle' || s.mode === 'send' || s.mode === 'convert') return;
      s.got.push(b);
      if (s.mode === 'match') { if (s.got.length === 64) { s.mode = s.got.every((x, i) => x === romBits[i]) ? 'fn' : 'idle'; s.got = []; } return; }
      if (s.mode === 'scratch') {
        if (s.got.length % 8 === 0) {
          const byte = s.got.slice(-8).reduce((a, x, i) => a | (x << i), 0), k = s.got.length / 8;
          s.scratch[k + 1] = k === 3 ? (byte & 0x60) | 0x1f : byte; setCrc();
          if (k === 3) s.mode = 'idle';
        }
        return;
      }
      if (s.got.length === 8) { const c = s.got.reduce((a, x, i) => a | (x << i), 0); s.got = []; command(c); }
    };
    const reset = (): void => {
      s.mode = 'rom'; s.got = []; s.out = [];
      // Other sensors on the line answer the reset too; their presence pulses are not time slots.
      s.quietUntil = ctx.now() + 150 * US;
      // Wait, then pull the line low for 120 us: "I am here".
      ctx.after(30 * US, () => drive(0));
      ctx.after(150 * US, () => drive(null));
    };
    return {
      // One wire both ways: this part only ever pulls low or lets go.
      drives: () => (fed() ? [{ pin: 'DQ', level: s.drive, pull: 'up' as const }] : []),
      onChange() {
        const l = ctx.level('DQ');
        if (!fed() || ctx.now() <= s.quietUntil) { s.last = l; s.fallAt = -1; return; }
        if (l === 0 && s.last !== 0) {
          if (s.drive === 0) s.fallAt = -1;                           // our own pulse
          else {
            s.fallAt = ctx.now(); s.consumed = reading();
            if (s.consumed && answer() === 0) { drive(0); ctx.after(30 * US, () => drive(null)); }
          }
        } else if (l === 1 && s.last === 0 && s.fallAt >= 0) {
          const held = ctx.now() - s.fallAt; s.fallAt = -1;
          if (held >= 400 * US) reset();
          else if (!s.consumed) bit(held < 30 * US ? 1 : 0);
        }
        s.last = l;
      },
      outputs: () => ({ powered: fed() }),
      ...keep(s),
    };
  },
};

// ---------------- PIR motion sensors ----------------
const BLOCK_NS = 2.5 * S;       // after a single-trigger pulse the HC-SR501 ignores motion this long
function pir(type: string, label: string, o: { hold: number; adjustable: boolean }): PartDef {
  const controls: Record<string, ControlDef> = { motion: toggle('Motion') };
  if (o.adjustable) { controls.hold = range(3, 300, o.hold, 'Time knob (output stays on)', 's'); controls.repeat = toggle('Repeat trigger (jumper H)', 1); }
  return {
    type, pins: ['VCC', 'OUT', 'GND'], ui: ui(type, label), controls, links: () => [],
    device(ctx) {
      const s = { out: 0 as Level, motion: 0, run: 0, blockedUntil: 0 };
      const hold = () => (o.adjustable ? ctx.control('hold') : o.hold) * S;
      const repeat = () => !o.adjustable || ctx.control('repeat') === 1;
      const set = (v: Level) => { if (s.out !== v) { s.out = v; ctx.changed(); } };
      const single = (): void => {
        const run = ++s.run; set(1);
        ctx.after(hold(), () => {
          if (run !== s.run) return;
          set(0); s.blockedUntil = ctx.now() + BLOCK_NS;
          ctx.after(BLOCK_NS, () => { if (run === s.run && s.motion) single(); });
        });
      };
      return {
        drives: () => (powered(ctx) ? [{ pin: 'OUT', level: s.out }] : []),
        onChange() {
          const m = ctx.control('motion');
          if (m === s.motion) return;
          s.motion = m;
          if (repeat()) {
            // Repeat mode: on while there is motion, and for the hold time after it stops.
            const run = ++s.run;
            if (m) set(1); else ctx.after(hold(), () => { if (run === s.run) set(0); });
          } else if (m && !s.out && ctx.now() >= s.blockedUntil) single();
        },
        outputs: () => ({ powered: powered(ctx), motion: s.out === 1 }),
        ...keep(s),
      };
    },
  };
}

// ---------------- vibration, knock, touch ----------------
/** SW-420: still, the spring switch is closed and DO is low; shaken, it opens over and over and DO pulses high. */
const sw420: PartDef = {
  type: 'vibration-sensor', pins: ['VCC', 'GND', 'DO'], ui: ui('vibration-sensor', 'Vibration sensor (SW-420)'),
  controls: { shake: range(0, 10, 0, 'Vibration strength') },
  links: () => [],
  device(ctx) {
    // Every 10 ms the contact opens for `strength` milliseconds; at 10 it never closes.
    const s = { out: 0 as Level, run: 0, seen: -1 };
    const strength = () => ctx.control('shake');
    const tick = (run: number): void => {
      if (run !== s.run) return;
      const k = strength();
      s.out = s.out ? 0 : 1; ctx.changed();
      ctx.after((s.out ? k : 10 - k) * MS, () => tick(run));
    };
    return {
      drives: () => (powered(ctx) ? [{ pin: 'DO', level: strength() >= 10 ? 1 : strength() <= 0 ? 0 : s.out }] : []),
      onChange() {
        const k = strength();
        if (k === s.seen) return;
        s.seen = k; s.out = 0; const run = ++s.run;
        if (k > 0 && k < 10) ctx.after(0, () => tick(run));
      },
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

/** Run each step at its time (ns from now). */
const timeline = (ctx: PartCtx, steps: [number, () => void][]): void => { for (const [t, fn] of steps) ctx.after(t, fn); };

/** KY-031: held high by its resistor; a knock closes the spring contact for a few bouncing milliseconds. */
const knock: PartDef = {
  type: 'knock-sensor', pins: ['S', 'VCC', 'GND'], ui: ui('knock-sensor', 'Knock sensor (KY-031)'),
  controls: { knock: toggle('Knock (each click is one knock)') },
  links: () => [],
  device(ctx) {
    const s = { out: 1 as Level, seen: 0 };
    const set = (v: Level) => () => { s.out = v; ctx.changed(); };
    return {
      drives: () => (powered(ctx) ? [{ pin: 'S', level: s.out }] : []),
      onChange() {
        const k = ctx.control('knock');
        if (k !== s.seen) { s.seen = k; timeline(ctx, [[0, set(0)], [2 * MS, set(1)], [3 * MS, set(0)], [6 * MS, set(1)]]); }
      },
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

/** A bare piezo disc, as in Arduino's Knock example: a knock gives a spike that dies away in a few milliseconds. */
const piezo: PartDef = {
  type: 'piezo-sensor', pins: ['+', '-'], ui: ui('piezo-sensor', 'Piezo knock sensor'),
  controls: { strength: range(0, 5, 2, 'How hard', 'V', 0.01), knock: toggle('Knock (each click is one knock)') },
  links: () => [],
  device(ctx) {
    const s = { at: -1, peak: 0, seen: 0, run: 0, on: false };
    const volts = () => (s.at < 0 ? 0 : s.peak * Math.exp(-(ctx.now() - s.at) / (4 * MS)));
    const w = wave(ctx, s, { step: () => 250 * US, active: () => s.at >= 0 && ctx.now() - s.at < 30 * MS });
    return {
      analog: () => (ctx.level('-') === 0 ? [{ pin: '+', volts: volts() }] : []),
      onChange() {
        const k = ctx.control('knock');
        if (k !== s.seen) { s.seen = k; s.at = ctx.now(); s.peak = ctx.control('strength'); s.on = false; ctx.changed(); }
        if (s.at >= 0 && ctx.now() - s.at >= 30 * MS) s.at = -1;
        w.poke();
      },
      ...keep(s),
    };
  },
};

/** TTP223: high while touched. Jumper A makes it active low; jumper B makes each touch toggle it. */
const ttp223: PartDef = {
  type: 'touch-sensor', pins: ['VCC', 'GND', 'SIG'], ui: ui('touch-sensor', 'Touch sensor (TTP223)'),
  controls: { touch: toggle('Touching'), toggleMode: toggle('Toggle mode (jumper B)'), activeLow: toggle('Active low (jumper A)') },
  links: () => [],
  device(ctx) {
    const s = { touch: 0, latched: 0 };
    const on = () => (ctx.control('toggleMode') ? s.latched : ctx.control('touch'));
    return {
      drives: () => (powered(ctx) ? [{ pin: 'SIG', level: (on() ? 1 : 0) ^ (ctx.control('activeLow') ? 1 : 0) as Level }] : []),
      onChange() { const t = ctx.control('touch'); if (t && !s.touch && ctx.control('toggleMode')) s.latched ^= 1; s.touch = t; },
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

// ---------------- waveforms ----------------
/** A sine around half the supply, ticking often enough that a sketch sampling it sees the shape. */
function sine(o: { type: string; label: string; pins: string[]; out: string; controls: Record<string, ControlDef>; joined?: [string, string][];
  /** Peak swing in volts, and frequency in hertz, from the sliders. 0 swing means a steady voltage. */
  peak(c: (n: string) => number): number; hz(c: (n: string) => number): number; offset?(c: (n: string) => number): number }): PartDef {
  return {
    type: o.type, pins: o.pins, ui: ui(o.type, o.label), controls: o.controls,
    links: (id) => (o.joined ?? []).map(([a, b]) => ({ a: `${id}:${a}`, b: `${id}:${b}`, kind: 'wire' as const })),
    device(ctx) {
      const s = { run: 0, on: false };
      const c = (n: string) => ctx.control(n);
      const w = wave(ctx, s, { step: () => Math.max(50 * US, S / o.hz(c) / 40), active: () => powered(ctx) && o.peak(c) !== 0 });
      return {
        analog: () => (powered(ctx) ? [{ pin: o.out, volts: clamp(2.5 + (o.offset?.(c) ?? 0) + o.peak(c) * Math.sin((2 * Math.PI * o.hz(c) * ctx.now()) / S), 0, 5) }] : []),
        onChange() { w.poke(); },
        outputs: () => ({ powered: powered(ctx) }),
        ...keep(s),
      };
    },
  };
}

const ZMPT_PEAK_PER_VRMS = 1 / 230;     // the trimmer as shipped: about 1 V peak for 230 V mains
const zmpt101b = sine({
  type: 'zmpt101b', label: 'AC voltage sensor (ZMPT101B)', pins: ['VCC', 'OUT', 'GND', 'L', 'N'], out: 'OUT',
  controls: { volts: range(0, 260, 230, 'Mains voltage (RMS)', 'V'), hz: range(45, 65, 50, 'Mains frequency', 'Hz', 0.1) },
  peak: (c) => c('volts') * ZMPT_PEAK_PER_VRMS, hz: (c) => c('hz'),
});

function acs712(type: string, label: string, amps: number, mvPerA: number): PartDef {
  return sine({
    type, label, pins: ['VCC', 'OUT', 'GND', 'IP+', 'IP-'], out: 'OUT', joined: [['IP+', 'IP-']],
    controls: { current: range(-amps, amps, 0, 'Current', 'A', 0.01), ac: toggle('Alternating, 50 Hz (current is RMS)') },
    // 2.5 V at no current; DC shifts it, AC swings it.
    peak: (c) => (c('ac') ? Math.abs(c('current')) * Math.SQRT2 * mvPerA / 1000 : 0), hz: () => 50,
    offset: (c) => (c('ac') ? 0 : (c('current') * mvPerA) / 1000),
  });
}

const microphone = sine({
  type: 'microphone', label: 'Microphone amplifier (MAX4466)', pins: ['OUT', 'GND', 'VCC'], out: 'OUT',
  controls: { loudness: range(0, 100, 0, 'Loudness', '%'), hz: range(50, 2000, 440, 'Pitch', 'Hz') },
  peak: (c) => (c('loudness') / 100) * 2.4, hz: (c) => c('hz'),
});

export const sensorsTimed: PartDef[] = [
  ds18b20,
  pir('hc-sr501', 'Motion sensor (HC-SR501)', { hold: 5, adjustable: true }),
  pir('am312', 'Mini motion sensor (AM312)', { hold: 2, adjustable: false }),
  pir('hc-sr505', 'Mini motion sensor (HC-SR505)', { hold: 8, adjustable: false }),
  sw420, knock, piezo, ttp223,
  zmpt101b, acs712('acs712-5a', 'Current sensor (ACS712, 5 A)', 5, 185), acs712('acs712-20a', 'Current sensor (ACS712, 20 A)', 20, 100),
  acs712('acs712-30a', 'Current sensor (ACS712, 30 A)', 30, 66), microphone,
];
