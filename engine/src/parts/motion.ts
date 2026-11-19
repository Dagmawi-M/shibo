// Things that turn.
import type { PartCtx, PartDef } from '../part.ts';
import type { Level } from '../types.ts';
import { keep, powered } from './util.ts';

const servo: PartDef = {
  type: 'servo', pins: ['GND', 'V+', 'PWM'], attrs: ['horn', 'hornColor'],
  ui: { label: 'Servo motor', tag: 'wokwi-servo', group: 'Motors and switching', show: { angle: 'angle' } },
  links: () => [],
  device(ctx) {
    const s = { angle: 0, upAt: -1, last: null as Level };
    const fed = () => powered(ctx, 'V+', 'GND');
    return {
      onChange() {
        const l = ctx.level('PWM');
        if (l === 1 && s.last !== 1) s.upAt = ctx.now();
        if (l !== 1 && s.last === 1 && s.upAt >= 0 && fed()) {
          // The usual hobby servo: 544 us is 0 degrees, 2400 us is 180.
          const us = (ctx.now() - s.upAt) / 1000;
          if (us > 300 && us < 2800) s.angle = Math.round(Math.min(180, Math.max(0, ((us - 544) / (2400 - 544)) * 180)));
        }
        s.last = l;
      },
      outputs: () => ({ angle: s.angle, powered: fed() }),
      ...keep(s),
    };
  },
};

// The eight positions of a two-coil motor, by the direction of current in coil A and coil B.
const PHASE: Record<string, number> = { '1,0': 0, '1,1': 1, '0,1': 2, '-1,1': 3, '-1,0': 4, '-1,-1': 5, '0,-1': 6, '1,-1': 7 };
const HALF_STEP_DEG = 0.9;        // a 200-step motor: 1.8 degrees a full step
interface Coils { phase: number; pos: number }
function turn(ctx: PartCtx, c: Coils, am: string, ap: string, bp: string, bm: string): void {
  const dir = (plus: string, minus: string) => Math.sign((ctx.level(plus) ?? 0) - (ctx.level(minus) ?? 0));
  const now = PHASE[`${dir(ap, am)},${dir(bp, bm)}`];
  if (now === undefined) return;                       // no current: the rotor stays where it is
  if (c.phase >= 0) { let d = (now - c.phase + 8) % 8; if (d > 4) d -= 8; if (Math.abs(d) < 4) c.pos += d; }
  c.phase = now;
}

const stepper: PartDef = {
  type: 'stepper-motor', pins: ['A-', 'A+', 'B+', 'B-'], attrs: ['size', 'arrow'],
  ui: { label: 'Stepper motor', tag: 'wokwi-stepper-motor', group: 'Motors and switching', show: { angle: 'angle' } },
  links: () => [],
  device(ctx) {
    const s: Coils = { phase: -1, pos: 0 };
    return { onChange() { turn(ctx, s, 'A-', 'A+', 'B+', 'B-'); }, outputs: () => ({ angle: Math.round(s.pos * HALF_STEP_DEG * 10) / 10, steps: s.pos / 2 }), ...keep(s) };
  },
};

const biaxial: PartDef = {
  type: 'biaxial-stepper', pins: ['A1-', 'A1+', 'B1+', 'B1-', 'A2-', 'A2+', 'B2+', 'B2-'],
  ui: { label: 'Two-hand stepper (clock)', tag: 'wokwi-biaxial-stepper', group: 'Motors and switching', show: { outerHandAngle: 'outer', innerHandAngle: 'inner' } },
  links: () => [],
  device(ctx) {
    const s = { a: { phase: -1, pos: 0 } as Coils, b: { phase: -1, pos: 0 } as Coils };
    return {
      onChange() { turn(ctx, s.a, 'A1-', 'A1+', 'B1+', 'B1-'); turn(ctx, s.b, 'A2-', 'A2+', 'B2+', 'B2-'); },
      outputs: () => ({ outer: Math.round(s.a.pos * HALF_STEP_DEG * 10) / 10, inner: Math.round(s.b.pos * HALF_STEP_DEG * 10) / 10 }),
      ...keep(s),
    };
  },
};

export const motion: PartDef[] = [servo, stepper, biaxial];
