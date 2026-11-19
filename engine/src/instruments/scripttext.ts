// The text form of an environment script, as written in the panel. Plain
// text handling with no imports, so the page and the engine share it.
export interface ScriptStep { at: number; part: string; control: string; value: number; over?: number }

const TIME = String.raw`(\d+(?:\.\d+)?)\s*(ms|s|sec|min|m)?`;
const SET = new RegExp(String.raw`^at\s+${TIME}\s+set\s+([\w-]+)\.(\w+)\s+(?:to\s+)?(-?\d+(?:\.\d+)?)$`, 'i');
const RAMP = new RegExp(String.raw`^at\s+${TIME}\s+ramp\s+([\w-]+)\.(\w+)\s+(?:to\s+)?(-?\d+(?:\.\d+)?)\s+over\s+${TIME}$`, 'i');
const ms = (n: string, unit = 's') => Number(n) * ({ ms: 1, s: 1000, sec: 1000, m: 60e3, min: 60e3 }[unit.toLowerCase()] ?? 1000);
export const fmtTime = (t: number) => (t % 1000 === 0 ? `${t / 1000}s` : t < 1000 ? `${t}ms` : `${Number((t / 1000).toFixed(3))}s`);

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

