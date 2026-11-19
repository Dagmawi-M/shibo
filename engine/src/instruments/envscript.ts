// Environment scripts: control changes on a schedule, saved in the project.
//   at 5s set ntc1.temperature to 40
//   at 2s ramp ntc1.temperature to 60 over 8s
// A step sets a part's control (what a slider or button would set) at an
// exact simulated time. A ramp moves it in a straight line from wherever it
// is when the ramp starts.
import type { Circuit } from '../circuit.ts';
import type { Engine } from '../engine.ts';
import { library } from '../parts/index.ts';
import type { Project } from '../project.ts';

import { fmtTime, type ScriptStep } from './scripttext.ts';
export { formatScript, parseScript, type ScriptStep } from './scripttext.ts';

export const MAX_STEPS = 500;
const MAX_MS = 24 * 3600e3;
const RAMP_STEP_MS = 20;
const PART = /^[A-Za-z_][\w-]{0,63}$/, CONTROL = /^\w{1,32}$/;

/** Clean anything claiming to be a script, as read from a project file. Returns null if there is none to keep. */
export function cleanScript(raw: unknown, source: string): ScriptStep[] | null {
  if (raw === undefined) return null;
  const fail = (what: string): never => { throw new Error(`${source} is not a usable project: ${what}`); };
  if (!Array.isArray(raw)) fail('"script" must be a list of steps');
  const list = raw as unknown[];
  if (list.length > MAX_STEPS) fail(`"script" has ${list.length} steps; the limit is ${MAX_STEPS}`);
  const steps = list.map((x, n) => {
    const s = x as Record<string, unknown>;
    const ok = s && typeof s === 'object' && typeof s.part === 'string' && PART.test(s.part) && typeof s.control === 'string' && CONTROL.test(s.control)
      && typeof s.at === 'number' && Number.isFinite(s.at) && s.at >= 0 && s.at <= MAX_MS && typeof s.value === 'number' && Number.isFinite(s.value)
      && (s.over === undefined || (typeof s.over === 'number' && Number.isFinite(s.over) && s.over >= 0 && s.over <= MAX_MS));
    if (!ok) fail(`script step ${n + 1} needs "at" (ms), "part", "control" and "value"`);
    return { at: s.at as number, part: s.part as string, control: s.control as string, value: s.value as number, ...(s.over ? { over: s.over as number } : {}) };
  });
  return steps.length ? steps : null;
}

/** The edit that replaces a project's script. */
export function setScript(p: Project & { script?: ScriptStep[] }, steps: unknown): Project {
  const clean = cleanScript(steps, 'the script');
  const { script: _old, ...rest } = structuredClone(p);
  return (clean ? { ...rest, script: clean } : rest) as Project;
}

/** Steps that cannot work in this circuit, as sentences. */
export function scriptProblems(p: Project & { script?: ScriptStep[] }): string[] {
  const out: string[] = [];
  for (const s of p.script ?? []) {
    const part = p.parts.find((x) => x.id === s.part);
    const where = `Environment script, at ${fmtTime(s.at)}`;
    if (!part) { out.push(`${where}: there is no part "${s.part}"`); continue; }
    const controls = Object.hasOwn(library, part.type) ? library[part.type].controls ?? {} : {};
    const def = Object.hasOwn(controls, s.control) ? controls[s.control] : undefined;
    if (!def) { out.push(`${where}: ${s.part} has no control "${s.control}"${Object.keys(controls).length ? ` (it has ${Object.keys(controls).join(', ')})` : ''}`); continue; }
    const min = def.kind === 'range' ? def.min ?? 0 : 0, max = def.kind === 'range' ? def.max ?? 1 : 1;
    if (s.value < min || s.value > max) out.push(`${where}: ${s.part}.${s.control} can be ${min} to ${max}, not ${s.value}`);
  }
  return out;
}

/** Put a script's steps on the engine's clock. Steps that cannot apply are skipped and told to `fail`. */
export function schedule(engine: Engine, circuit: Circuit, steps: ScriptStep[], fail: (msg: string) => void): void {
  const apply = (s: ScriptStep, v: number) => {
    try { circuit.setControl(s.part, s.control, v); } catch (err) { fail(`Environment script: ${(err as Error).message}`); }
  };
  for (const s of steps) {
    const t0 = s.at * 1e6;
    if (!s.over) { engine.at(Math.max(t0, engine.now), () => apply(s, s.value)); continue; }
    // A ramp starts from where the control is at its start. That start value travels with the steps
    // still queued (they are placed by the first step), so a snapshot's event queue carries it and a
    // rewind restores it along with everything else.
    const n = Math.max(1, Math.ceil(s.over / RAMP_STEP_MS));
    const stepAt = (i: number) => Math.max(t0 + (s.over! * 1e6 * i) / n, engine.now);
    engine.at(stepAt(0), () => {
      const from = circuit.controlValues()[s.part]?.[s.control] ?? s.value;
      apply(s, Number(from.toPrecision(6)));
      for (let i = 1; i <= n; i++) {
        engine.at(stepAt(i), () => apply(s, i === n ? s.value : Number((from + ((s.value - from) * i) / n).toPrecision(6))));
      }
    });
  }
}
