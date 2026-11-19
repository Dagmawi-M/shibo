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

export interface ScriptStep { at: number; part: string; control: string; value: number; over?: number }

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

// ---- text form, for the panel ----
const TIME = String.raw`(\d+(?:\.\d+)?)\s*(ms|s|sec|min|m)?`;
const SET = new RegExp(String.raw`^at\s+${TIME}\s+set\s+([\w-]+)\.(\w+)\s+(?:to\s+)?(-?\d+(?:\.\d+)?)$`, 'i');
const RAMP = new RegExp(String.raw`^at\s+${TIME}\s+ramp\s+([\w-]+)\.(\w+)\s+(?:to\s+)?(-?\d+(?:\.\d+)?)\s+over\s+${TIME}$`, 'i');
const ms = (n: string, unit = 's') => Number(n) * ({ ms: 1, s: 1000, sec: 1000, m: 60e3, min: 60e3 }[unit.toLowerCase()] ?? 1000);
const fmtTime = (t: number) => (t % 1000 === 0 ? `${t / 1000}s` : t < 1000 ? `${t}ms` : `${Number((t / 1000).toFixed(3))}s`);

/** Read the panel's text. Blank lines and lines starting with # are ignored. */
export function parseScript(text: string): { steps: ScriptStep[]; errors: string[] } {
  const steps: ScriptStep[] = [], errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim().replace(/\s+/g, ' ');
    if (!line || line.startsWith('#')) return;
    let m = RAMP.exec(line);
    if (m) { steps.push({ at: ms(m[1], m[2]), part: m[3], control: m[4], value: Number(m[5]), over: ms(m[6], m[7]) }); return; }
    m = SET.exec(line);
    if (m) { steps.push({ at: ms(m[1], m[2]), part: m[3], control: m[4], value: Number(m[5]) }); return; }
    errors.push(`line ${i + 1}: "${raw.trim()}" is not a step. Write "at 5s set ntc1.temperature to 40" or "at 2s ramp ntc1.temperature to 60 over 8s".`);
  });
  return { steps, errors };
}

export function formatScript(steps: ScriptStep[]): string {
  return steps.map((s) => `at ${fmtTime(s.at)} ${s.over ? 'ramp' : 'set'} ${s.part}.${s.control} to ${s.value}${s.over ? ` over ${fmtTime(s.over)}` : ''}`).join('\n');
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
    // A ramp starts from where the control is at its start; every step is placed now, so a rewind replays them all.
    const from = { v: NaN };
    const n = Math.max(1, Math.ceil(s.over / RAMP_STEP_MS));
    for (let i = 0; i <= n; i++) {
      engine.at(Math.max(t0 + (s.over * 1e6 * i) / n, engine.now), () => {
        if (i === 0) from.v = circuit.controlValues()[s.part]?.[s.control] ?? s.value;
        const v = i === n ? s.value : from.v + ((s.value - from.v) * i) / n;
        apply(s, Number(v.toPrecision(6)));
      });
    }
  }
}
