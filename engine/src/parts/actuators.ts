// Motors and the modules that drive them: DC motors, fans, pumps, solenoids,
// H-bridge driver boards, relay modules and the 28BYJ-48 with its ULN2003 board.
import type { PartCtx, PartDef } from '../part.ts';
import type { Level } from '../types.ts';
import { fed, keep, powered } from './util.ts';

type LevelOf = (node: string) => Level;
const GROUP = 'Motors and switching';

/**
 * A first-order lag: what a motor's speed or a coil's pull does with the
 * drive across it. A PWM drive is averaged by it, as a real rotor's inertia does.
 */
interface Lag { v: number; target: number; t: number; tickAt: number }
const lag = (now: number): Lag => ({ v: 0, target: 0, t: now, tickAt: -1 });
function settle(l: Lag, now: number, tau: number): void {
  const dt = now - l.t;
  if (dt > 0) { l.v = l.target + (l.v - l.target) * Math.exp(-dt / tau); l.t = now; }
}
/** Keep the outputs moving while the lag is still catching up, even if no pin changes. */
function tick(ctx: PartCtx, l: Lag, every: number): void {
  if (Math.abs(l.v - l.target) < 1e-3 || l.tickAt > ctx.now()) return;
  l.tickAt = ctx.now() + every;
  ctx.after(every, () => ctx.changed());
}

/** -1, 0 or 1: which way current flows from pin a to pin b. Unconnected is no drive. */
const across = (ctx: PartCtx, a: string, b: string): number => {
  const x = ctx.level(a), y = ctx.level(b);
  return x === null || y === null ? 0 : x - y;
};

/** A load that must not hang straight off a board pin. */
const offPin = (a: string, b: string, why: (id: string, pin: string) => string) =>
  (id: string, see: { level: LevelOf; boardPin(node: string): string | null }): string[] => {
    const x = see.level(`${id}:${a}`), y = see.level(`${id}:${b}`);
    const pin = see.boardPin(`${id}:${a}`) ?? see.boardPin(`${id}:${b}`);
    return x !== null && y !== null && x !== y && pin ? [why(id, pin)] : [];
  };
const needsDriver = (what: string) => (id: string, pin: string) =>
  `${id} is driven straight from ${pin}: ${what} needs far more current than a pin can give (about 20 mA), and its electrical noise can reset the board. Use a motor driver (L298N, L9110) or a transistor with a diode.`;

const MOTOR_TAU = 60e6;           // a small motor reaches full speed in a few tenths of a second
const TICK = 20e6;
/** Below this share of full drive a small motor only hums: friction holds it. */
const STICTION = 0.1;

interface MotorSpec { type: string; label: string; tag: string; pins: [string, string]; rated: number; oneWay?: boolean; what: string; show?: Record<string, string>; outputs(speed: number, rated: number): Record<string, number | boolean> }
/** Anything with a brushed or brushless DC motor inside: speed follows the average drive. */
const motor = (m: MotorSpec): PartDef => ({
  type: m.type, pins: m.pins, attrs: ['rpm'],
  ui: { label: m.label, tag: m.tag, group: GROUP, show: m.show ?? { rpm: 'rpm' } },
  links: () => [],
  check: offPin(m.pins[0], m.pins[1], needsDriver(m.what)),
  device(ctx) {
    const rated = Number(ctx.attrs.rpm) > 0 ? Number(ctx.attrs.rpm) : m.rated;
    const s = lag(ctx.now());
    const speed = (): number => {
      settle(s, ctx.now(), MOTOR_TAU);
      const v = m.oneWay ? Math.max(0, s.v) : s.v;
      return Math.sign(v) * Math.max(0, Math.abs(v) - STICTION) / (1 - STICTION);
    };
    return {
      onChange() { settle(s, ctx.now(), MOTOR_TAU); s.target = across(ctx, m.pins[0], m.pins[1]); tick(ctx, s, TICK); },
      outputs: () => m.outputs(speed(), rated),
      ...keep(s),
    };
  },
});

const rpm = (speed: number, rated: number) => ({ rpm: Math.round(speed * rated) });

const dcMotor = motor({ type: 'dc-motor', label: 'DC motor', tag: 'shibo-dc-motor', pins: ['1', '2'], rated: 200, what: 'a motor', outputs: rpm });
const fan = motor({ type: 'fan', label: 'Fan (5V)', tag: 'shibo-fan', pins: ['+', '-'], rated: 6000, oneWay: true, what: 'a fan', outputs: rpm });
const vibration = motor({
  type: 'vibration-motor', label: 'Vibration motor', tag: 'shibo-vibration-motor', pins: ['1', '2'], rated: 12000, what: 'a vibration motor',
  show: { on: 'on' }, outputs: (sp, r) => ({ on: Math.abs(sp) > 0.05, rpm: Math.round(Math.abs(sp) * r) }),
});
const PUMP_LH = 120;              // the usual small 3 to 6 V submersible pump
const pump = motor({
  type: 'water-pump', label: 'Water pump', tag: 'shibo-water-pump', pins: ['+', '-'], rated: PUMP_LH, oneWay: true, what: 'a pump',
  show: { on: 'on' }, outputs: (sp) => ({ on: sp > 0.05, flow: Math.round(sp * PUMP_LH * 10) / 10 }),
});

const SOL_TAU = 5e6;
const solenoid: PartDef = {
  type: 'solenoid', pins: ['1', '2'],
  ui: { label: 'Solenoid', tag: 'shibo-solenoid', group: GROUP, show: { on: 'on' } },
  links: () => [],
  check: offPin('1', '2', (id, pin) => `${id} is driven straight from ${pin}: a solenoid coil draws far more current than a pin can give. Switch it with a transistor (and a diode across the coil), or a relay module.`),
  device(ctx) {
    const s = { ...lag(ctx.now()), on: false };
    const look = (): boolean => {
      settle(s, ctx.now(), SOL_TAU);
      // It pulls in at well over half its drive, and lets go only once that falls a long way: a held PWM keeps it in.
      if (!s.on && s.v > 0.6) s.on = true; else if (s.on && s.v < 0.25) s.on = false;
      return s.on;
    };
    return {
      onChange() { look(); s.target = Math.abs(across(ctx, '1', '2')); tick(ctx, s, 2e6); },
      outputs: () => ({ on: look() }),
      ...keep(s),
    };
  },
};

// ---------- driver boards ----------
const hi = (l: Level) => (l === 1 ? 1 : 0);
const l298n: PartDef = {
  type: 'l298n', pins: ['ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB', 'OUT1', 'OUT2', 'OUT3', 'OUT4', '12V', 'GND', '5V'],
  ui: { label: 'Motor driver (L298N)', tag: 'shibo-l298n', group: GROUP, show: { powered: 'powered' } },
  links: () => [],
  drives(id, _s, level) {
    if (level(`${id}:12V`) !== 1 || level(`${id}:GND`) !== 0) return [];
    // With its 5V jumper on, the board's own regulator feeds the 5V pin from the motor supply.
    const out: { pin: string; level: Level }[] = [{ pin: '5V', level: 1 }];
    // An enable pin with nothing wired to it has its jumper on: always enabled.
    // Enabled, each output follows its input; disabled, both let go and the motor coasts.
    if (level(`${id}:ENA`) !== 0) out.push({ pin: 'OUT1', level: hi(level(`${id}:IN1`)) }, { pin: 'OUT2', level: hi(level(`${id}:IN2`)) });
    if (level(`${id}:ENB`) !== 0) out.push({ pin: 'OUT3', level: hi(level(`${id}:IN3`)) }, { pin: 'OUT4', level: hi(level(`${id}:IN4`)) });
    return out;
  },
  outputs: (id, level) => ({ powered: fed(level, id, '12V') }),
  check(id, see) {
    if (see.level(`${id}:12V`) === 1) return [];
    const driven = ['IN1', 'IN2', 'IN3', 'IN4'].some((p) => see.level(`${id}:${p}`) === 1 && see.boardPin(`${id}:${p}`));
    return driven ? [`${id} has no motor supply: its outputs stay off until a battery or supply (7 to 12 V) is wired to its 12V pin, with its GND joined to the board's GND.`] : [];
  },
};

const l9110: PartDef = {
  type: 'l9110', pins: ['B-IA', 'B-IB', 'GND', 'VCC', 'A-IA', 'A-IB', 'MOTOR-A1', 'MOTOR-A2', 'MOTOR-B1', 'MOTOR-B2'],
  ui: { label: 'Motor driver (L9110)', tag: 'shibo-l9110', group: GROUP, show: { powered: 'powered' } },
  links: () => [],
  drives(id, _s, level) {
    if (!fed(level, id)) return [];
    // IA high and IB low: forward. IB high and IA low: reverse. Both the same: both outputs low, stopped.
    const ch = (a: string, b: string, o1: string, o2: string) => {
      const x = hi(level(`${id}:${a}`)), y = hi(level(`${id}:${b}`));
      return [{ pin: o1, level: (x && !y ? 1 : 0) as Level }, { pin: o2, level: (y && !x ? 1 : 0) as Level }];
    };
    return [...ch('A-IA', 'A-IB', 'MOTOR-A1', 'MOTOR-A2'), ...ch('B-IA', 'B-IB', 'MOTOR-B1', 'MOTOR-B2')];
  },
  outputs: (id, level) => ({ powered: fed(level, id) }),
};

// ---------- relay modules ----------
const OPERATE_NS = 10e6, RELEASE_NS = 5e6;     // a small relay's armature takes this long to move
const relayModule = (type: string, label: string, active: 0 | 1): PartDef => ({
  type, pins: ['VCC', 'GND', 'IN', 'COM', 'NO', 'NC'],
  ui: { label, tag: `shibo-${type}`, group: GROUP, show: { on: 'on' } },
  links: () => [],
  device(ctx) {
    const s = { on: false, want: false, seq: 0 };
    return {
      // Active low: IN goes through the optocoupler's LED to VCC, so it rests high. Active high: a resistor holds it low.
      drives: () => [{ pin: 'IN', level: null, pull: active ? 'down' as const : 'up' as const }],
      links: () => [{ a: `${ctx.id}:COM`, b: `${ctx.id}:${s.on ? 'NO' : 'NC'}`, kind: 'wire' as const }],
      onChange() {
        const want = powered(ctx) && ctx.level('IN') === active;
        if (want === s.want) return;
        s.want = want;
        const seq = ++s.seq;
        ctx.after(want ? OPERATE_NS : RELEASE_NS, () => { if (s.seq === seq && s.on !== want) { s.on = want; ctx.changed(); } });
      },
      outputs: () => ({ on: s.on, powered: powered(ctx) }),
      ...keep(s),
    };
  },
});

// ---------- 28BYJ-48 with ULN2003 ----------
// Coil directions A, B, C, D as an electrical angle, in eighths: energising A then A+B then B ... is a half step each.
const PHASE: Record<string, number> = { '1,0': 0, '1,1': 1, '0,1': 2, '-1,1': 3, '-1,0': 4, '-1,-1': 5, '0,-1': 6, '1,-1': 7 };
const HALF_STEPS = 4096;          // per turn of the output shaft, through its 1:64 gearbox
const SETTLE_NS = 100e3;          // coil current takes time to build; glitches shorter than this move nothing
const MIN_HALF_STEP_NS = 0.8e6;   // at 5 V it loses steps above about 18 rpm (2048 full steps a turn)
const byj48: PartDef = {
  type: 'stepper-28byj48', pins: ['IN1', 'IN2', 'IN3', 'IN4', 'VCC', 'GND'],
  ui: { label: 'Stepper 28BYJ-48 (ULN2003)', tag: 'shibo-28byj48', group: GROUP, show: { angle: 'angle', coils: 'coils' } },
  links: () => [],
  device(ctx) {
    const s = { rotor: -1, pos: 0, lastMove: -1e18, pattern: -2, seq: 0, hist: [] as number[] };
    // The ULN2003 sinks a coil to ground while its input is high; the coils' common is VCC.
    const coils = (): number[] => ['IN1', 'IN2', 'IN3', 'IN4'].map((p) => (powered(ctx) && ctx.level(p) === 1 ? 1 : 0));
    const phase = (): number => { const [a, b, c, d] = coils(); return PHASE[`${a - c},${b - d}`] ?? -1; };
    const note = (missed: boolean) => { s.hist.push(missed ? 1 : 0); if (s.hist.length > 8) s.hist.shift(); };
    const apply = (p: number): void => {
      if (p < 0) return;                                   // no field: the detent holds the rotor where it is
      if (s.rotor < 0) { s.rotor = p; s.lastMove = ctx.now(); return; }
      let d = (p - s.rotor + 8) % 8; if (d > 4) d -= 8;
      if (d === 0) return;
      // Opposite the rotor, or asked to move faster than it can follow: it stays put and the step is lost.
      if (Math.abs(d) === 4 || ctx.now() - s.lastMove < Math.abs(d) * MIN_HALF_STEP_NS) { note(true); return; }
      s.pos += d; s.rotor = p; s.lastMove = ctx.now(); note(false);
      ctx.changed();
    };
    return {
      onChange() {
        const p = phase();
        if (p === s.pattern) return;
        s.pattern = p;
        const seq = ++s.seq;
        ctx.after(SETTLE_NS, () => { if (s.seq === seq) apply(p); });
      },
      outputs: () => ({
        angle: Math.round((s.pos * 360 / HALF_STEPS) * 100) / 100, steps: s.pos / 2, coils: coils(),
        stalled: s.hist.filter(Boolean).length >= 3, powered: powered(ctx),
      }),
      ...keep(s),
    };
  },
};

export const actuators: PartDef[] = [dcMotor, l298n, l9110, relayModule('relay-module', 'Relay module (active low)', 0), relayModule('relay-module-high', 'Relay module (active high)', 1),
  solenoid, vibration, fan, pump, byj48];
