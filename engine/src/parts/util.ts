import type { Level } from '../types.ts';
import type { PartCtx } from '../part.ts';

type LevelOf = (node: string) => Level;

/** save/restore for a device whose whole memory is one plain object. */
export const keep = <T extends object>(s: T) => ({
  save: (): unknown => structuredClone(s),
  restore: (x: unknown): void => { for (const k of Object.keys(s)) delete (s as Record<string, unknown>)[k]; Object.assign(s, structuredClone(x)); },
});

/** Is a part with no memory powered: supply pin high and ground pin low? */
export const fed = (level: LevelOf, id: string, vcc = 'VCC', gnd = 'GND'): boolean => level(`${id}:${vcc}`) === 1 && level(`${id}:${gnd}`) === 0;
/** The same, for a device. */
export const powered = (ctx: PartCtx, vcc = 'VCC', gnd = 'GND'): boolean => ctx.level(vcc) === 1 && ctx.level(gnd) === 0;

/** Tracks what fraction of the time something is on, so a PWM-dimmed LED can be drawn dim. */
export interface DutyState { lit: boolean; t0: number; on: number; win: number; frac: number }
export const duty = (now: number): DutyState => ({ lit: false, t0: now, on: 0, win: now, frac: 0 });
export function dutyEdge(d: DutyState, lit: boolean, now: number): void {
  if (lit === d.lit) return;
  if (d.lit) d.on += now - d.t0;
  d.lit = lit; d.t0 = now;
}
/** The on-fraction since the last read (kept if less than 1 ms has passed). */
export function dutyRead(d: DutyState, now: number): number {
  const span = now - d.win;
  if (span >= 1e6) { d.frac = (d.on + (d.lit ? now - d.t0 : 0)) / span; d.on = 0; d.win = now; d.t0 = now; }
  return d.frac;
}

export const press = [{ on: 'button-press', control: 'pressed', value: 1 }, { on: 'button-release', control: 'pressed', value: 0 }];
