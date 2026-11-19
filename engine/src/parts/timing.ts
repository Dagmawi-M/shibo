// Parts whose behaviour is a matter of microseconds: they answer a pulse
// with pulses of their own.
import type { PartCtx, PartDef } from '../part.ts';
import type { Link } from '../nets.ts';
import type { Level } from '../types.ts';
import { keep, powered } from './util.ts';

/** Run each step at its time (ns from now). */
const timeline = (ctx: PartCtx, steps: [number, () => void][]): void => { for (const [t, fn] of steps) ctx.after(t, fn); };

const hcsr04: PartDef = {
  type: 'hc-sr04', pins: ['VCC', 'TRIG', 'ECHO', 'GND'],
  ui: { label: 'Ultrasonic distance (HC-SR04)', tag: 'wokwi-hc-sr04', group: 'Sensors' },
  controls: { distance: { kind: 'range', min: 2, max: 400, initial: 100, step: 1, label: 'Distance', unit: 'cm' } },
  links: () => [],
  device(ctx) {
    const s = { echo: 0 as Level, trig: null as Level, upAt: -1, busy: false };
    return {
      drives: () => (powered(ctx) ? [{ pin: 'ECHO', level: s.echo }] : []),
      onChange() {
        const t = ctx.level('TRIG');
        if (t === 1 && s.trig !== 1) s.upAt = ctx.now();
        // A trigger is TRIG held high for about 10 us. The echo pulse lasts 58 us per centimetre.
        if (t !== 1 && s.trig === 1 && !s.busy && powered(ctx) && ctx.now() - s.upAt >= 5_000) {
          s.busy = true;
          const width = ctx.control('distance') * 58_000;
          timeline(ctx, [[300_000, () => { s.echo = 1; ctx.changed(); }], [300_000 + width, () => { s.echo = 0; s.busy = false; ctx.changed(); }]]);
        }
        s.trig = t;
      },
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

const dht22: PartDef = {
  type: 'dht22', pins: ['VCC', 'SDA', 'NC', 'GND'],
  ui: { label: 'Temperature and humidity (DHT22)', tag: 'wokwi-dht22', group: 'Sensors' },
  controls: {
    temperature: { kind: 'range', min: -40, max: 80, initial: 24, step: 0.1, label: 'Temperature', unit: '°C' },
    humidity: { kind: 'range', min: 0, max: 100, initial: 40, step: 0.1, label: 'Humidity', unit: '%' },
  },
  links: () => [],
  device(ctx) {
    const s = { drive: null as Level, lowAt: -1, busy: false };
    const reply = (): void => {
      const h = Math.round(ctx.control('humidity') * 10), c = ctx.control('temperature');
      const t = Math.round(Math.abs(c) * 10) | (c < 0 ? 0x8000 : 0);
      const bytes = [h >> 8, h & 255, t >> 8, t & 255];
      bytes.push(bytes.reduce((a, b) => a + b, 0) & 255);
      const steps: [number, () => void][] = []; let at = 30_000;
      const low = (ns: number) => { steps.push([at, () => { s.drive = 0; ctx.changed(); }]); at += ns; };
      const high = (ns: number) => { steps.push([at, () => { s.drive = null; ctx.changed(); }]); at += ns; };
      low(80_000); high(80_000);                                   // "here I am"
      for (const b of bytes) for (let i = 7; i >= 0; i--) { low(50_000); high((b >> i) & 1 ? 70_000 : 26_000); }
      low(50_000);
      steps.push([at, () => { s.drive = null; s.busy = false; ctx.changed(); }]);
      s.busy = true; timeline(ctx, steps);
    };
    return {
      // One wire both ways: the sensor pulls it low or lets go, and a pull-up holds it high.
      drives: () => (powered(ctx) ? [{ pin: 'SDA', level: s.drive, pull: 'up' as const }] : []),
      onChange() {
        if (s.busy || !powered(ctx)) return;
        const l = ctx.level('SDA');
        if (l === 0 && s.lowAt < 0) s.lowAt = ctx.now();
        // The board asks by holding the line low for a millisecond or more, then letting go.
        if (l === 1 && s.lowAt >= 0) { const held = ctx.now() - s.lowAt; s.lowAt = -1; if (held >= 500_000) reply(); }
      },
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

const UNIT = 562_500;             // the NEC infrared protocol's basic pulse, in ns
const irReceiver: PartDef = {
  type: 'ir-receiver', pins: ['GND', 'VCC', 'DAT'],
  ui: { label: 'Infrared receiver', tag: 'wokwi-ir-receiver', group: 'Sensors' },
  controls: { command: { kind: 'range', min: -1, max: 255, initial: -1, step: 1 } },
  links: () => [],
  device(ctx) {
    const s = { out: 1 as Level, busy: false, seen: -1 };
    const send = (cmd: number): void => {
      const bytes = [0x00, 0xff, cmd & 255, ~cmd & 255];
      const steps: [number, () => void][] = []; let at = 0;
      const mark = (ns: number) => { steps.push([at, () => { s.out = 0; ctx.changed(); }]); at += ns; };       // the receiver's output is low while it sees light
      const space = (ns: number) => { steps.push([at, () => { s.out = 1; ctx.changed(); }]); at += ns; };
      mark(16 * UNIT); space(8 * UNIT);
      for (const b of bytes) for (let i = 0; i < 8; i++) { mark(UNIT); space((b >> i) & 1 ? 3 * UNIT : UNIT); }
      mark(UNIT);
      steps.push([at, () => { s.out = 1; s.busy = false; ctx.changed(); }]);
      s.busy = true; timeline(ctx, steps);
    };
    return {
      drives: () => (powered(ctx) ? [{ pin: 'DAT', level: s.out }] : []),
      onChange() {
        const c = Math.round(ctx.control('command'));
        if (c >= 0 && c !== s.seen && !s.busy && powered(ctx)) send(c);
        s.seen = c;
      },
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

const irRemote: PartDef = {
  type: 'ir-remote', pins: [],
  ui: { label: 'Infrared remote', tag: 'wokwi-ir-remote', group: 'Modules', events: [{ on: 'button-press', from: 'ir' }] },
  links: () => [],
};

const hx711: PartDef = {
  type: 'hx711', pins: ['VCC', 'DT', 'SCK', 'GND'],
  ui: { label: 'Load cell amplifier (HX711)', tag: 'wokwi-hx711', group: 'Sensors' },
  controls: { reading: { kind: 'range', min: -8388608, max: 8388607, initial: 0, step: 1, label: 'Reading (raw)' } },
  links: () => [],
  device(ctx) {
    const s = { dt: 0 as Level, bit: 0, sck: null as Level };
    return {
      drives: () => (powered(ctx) ? [{ pin: 'DT', level: s.dt }] : []),
      onChange() {
        const k = ctx.level('SCK');
        if (k === 1 && s.sck === 0) {
          // Each clock pulse shifts out one bit, most significant first; a 25th ends the reading.
          s.dt = s.bit < 24 ? ((((Math.round(ctx.control('reading')) & 0xffffff) >> (23 - s.bit)) & 1) as Level) : 1;
          s.bit++; ctx.changed();
        }
        if (k === 0 && s.sck === 1 && s.bit >= 25) { s.bit = -1; ctx.after(1_000_000, () => { s.bit = 0; s.dt = 0; ctx.changed(); }); }
        s.sck = k;
      },
      outputs: () => ({ powered: powered(ctx) }),
      ...keep(s),
    };
  },
};

const dialer: PartDef = {
  type: 'rotary-dialer', pins: ['GND', 'DIAL', 'PULSE'],
  ui: { label: 'Rotary phone dial', tag: 'wokwi-rotary-dialer', group: 'Modules', events: [{ on: 'dial-end', control: 'digit', from: 'digit' }] },
  controls: { digit: { kind: 'range', min: -1, max: 9, initial: -1, step: 1 } },
  links: () => [],
  device(ctx) {
    const s = { dialing: false, open: false, seen: -1 };
    return {
      // DIAL is joined to ground while the dial turns back; PULSE is joined except during each pulse.
      links: () => [...(s.dialing ? [{ a: `${ctx.id}:DIAL`, b: `${ctx.id}:GND`, kind: 'wire' } as Link] : []), ...(s.open ? [] : [{ a: `${ctx.id}:PULSE`, b: `${ctx.id}:GND`, kind: 'wire' } as Link])],
      onChange() {
        const d = Math.round(ctx.control('digit'));
        if (d >= 0 && d !== s.seen && !s.dialing) {
          const n = d === 0 ? 10 : d, steps: [number, () => void][] = [];
          s.dialing = true;
          for (let i = 0; i < n; i++) { steps.push([100e6 + i * 100e6, () => { s.open = true; ctx.changed(); }], [160e6 + i * 100e6, () => { s.open = false; ctx.changed(); }]); }
          steps.push([200e6 + n * 100e6, () => { s.dialing = false; ctx.changed(); }]);
          timeline(ctx, steps); ctx.changed();
        }
        s.seen = d;
      },
      ...keep(s),
    };
  },
};

export const timing: PartDef[] = [hcsr04, dht22, irReceiver, irRemote, hx711, dialer];
