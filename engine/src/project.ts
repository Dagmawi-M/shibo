import { library } from './parts/index.ts';

export interface Project {
  version: 1;
  parts: { id: string; type: string; x: number; y: number; rot?: number; attrs?: Record<string, string> }[];
  wires: { from: string; to: string; color?: string }[];
  boards: { part: string; firmware: string }[];
}

/** Pins of each board type the engine can run. */
export const boardPins: Record<string, string[]> = {
  uno: [...Array.from({ length: 14 }, (_, i) => String(i)), 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', '5V', '3.3V', 'GND', 'VIN', 'AREF', 'IOREF', 'RESET'],
  nano: [...Array.from({ length: 14 }, (_, i) => String(i)), 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', '5V', '3.3V', 'GND', 'VIN', 'AREF', 'RESET'],
};

const WOKWI_BOARDS: Record<string, string> = { 'wokwi-arduino-uno': 'uno', 'wokwi-arduino-nano': 'nano' };
const UNKNOWN = 'unknown:';

export const isBoard = (type: string): boolean => Object.hasOwn(boardPins, type);
const isPart = (type: string): boolean => Object.hasOwn(library, type);

/** Pins a part type has, or null if the type is not one we know. */
export function pinsOf(type: string): string[] | null {
  return isBoard(type) ? boardPins[type] : isPart(type) ? library[type].pins : null;
}

/**
 * The only attributes a part may carry, per type. A project file can come
 * from anyone, and attributes end up on page elements, so nothing else
 * (event handlers, id, style) is ever let through.
 */
export const partAttrs: Record<string, string[]> = Object.fromEntries(Object.entries(library).filter(([, d]) => d.attrs?.length).map(([t, d]) => [t, d.attrs!]));
const ATTR_VALUE = /^[\w#.-]{0,32}$/;
export const ID = /^[A-Za-z_][\w-]{0,63}$/;
export const COLOR = /^[a-zA-Z#][\w#]{0,31}$/;

/**
 * Check and clean anything claiming to be a project. Every project enters
 * the engine through here, whether read from disk or imported.
 */
export function parseProject(raw: unknown, source: string): Project {
  const fail = (what: string): never => { throw new Error(`${source} is not a usable project: ${what}`); };
  const r = raw as any;
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail('expected a project object');
  if (r.version !== 1) fail(`unsupported version ${JSON.stringify(r.version)}`);
  if (!Array.isArray(r.parts) || !Array.isArray(r.wires) || !Array.isArray(r.boards)) fail('it needs "parts", "wires" and "boards" lists');
  const seen = new Set<string>();
  const parts = (r.parts as any[]).map((q, n) => {
    if (!q || typeof q !== 'object') fail(`part ${n + 1} is not an object`);
    if (typeof q.id !== 'string' || !ID.test(q.id)) fail(`part ${n + 1} has an unusable id ${JSON.stringify(q.id)} (letters, digits, - and _ only)`);
    if (seen.has(q.id)) fail(`part id "${q.id}" is used twice`);
    seen.add(q.id);
    if (typeof q.type !== 'string' || !q.type || q.type.length > 80) fail(`part "${q.id}" has no usable type`);
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) fail(`part "${q.id}" has no usable position`);
    const type = isBoard(q.type) || isPart(q.type) || q.type.startsWith('unknown:') ? q.type : `unknown:${q.type}`;
    const attrs: Record<string, string> = {};
    if (q.attrs && typeof q.attrs === 'object') {
      for (const k of Object.hasOwn(partAttrs, type) ? partAttrs[type] : []) {
        if (Object.hasOwn(q.attrs, k) && ATTR_VALUE.test(String(q.attrs[k]))) attrs[k] = String(q.attrs[k]);
      }
    }
    const rot = [90, 180, 270].includes(q.rot) ? { rot: q.rot as number } : {};      // quarter turns only
    return { id: q.id as string, type: type as string, x: q.x as number, y: q.y as number, ...rot, ...(Object.keys(attrs).length ? { attrs } : {}) };
  });
  const wires = (r.wires as any[]).map((w, n) => {
    if (!w || typeof w !== 'object' || typeof w.from !== 'string' || typeof w.to !== 'string' || w.from.length > 160 || w.to.length > 160) fail(`wire ${n + 1} needs "from" and "to" as part:pin text`);
    return { from: w.from as string, to: w.to as string, ...(typeof w.color === 'string' && COLOR.test(w.color) ? { color: w.color as string } : {}) };
  });
  const boards = (r.boards as any[]).map((b, n) => {
    if (!b || typeof b !== 'object' || typeof b.part !== 'string' || !seen.has(b.part)) fail(`board ${n + 1} does not name a part in this project`);
    return { part: b.part as string, firmware: typeof b.firmware === 'string' ? b.firmware : '' };
  });
  return { version: 1, parts, wires, boards };
}

/**
 * The pin a pin name stands for, or null if the part has no such pin.
 * Boards repeat some pins (GND.1, GND.2, A4.2): electrically they are one pin.
 * A wire keeps the name it was drawn to; nets are resolved on this name.
 */
export function canonicalPin(type: string, pin: string): string | null {
  const pins = pinsOf(type);
  if (!pins) return null;
  if (pins.includes(pin)) return pin;
  const base = pin.replace(/\.\d+$/, '');
  return isBoard(type) && base !== pin && pins.includes(base) ? base : null;
}

/** Read a Wokwi diagram.json. Part types we have no model for are kept, inert, and listed. */
export function importWokwi(diagram: any): { project: Project; unmapped: string[] } {
  if (!diagram || typeof diagram !== 'object' || !Array.isArray(diagram.parts)) throw new Error('diagram.json: expected an object with a "parts" list');
  const unmapped: string[] = [];
  const parts = (diagram.parts ?? []).map((p: any) => {
    const short = String(p.type).replace(/^wokwi-/, '');
    if (!p || typeof p !== 'object' || typeof p.type !== 'string') throw new Error('diagram.json: every part needs a "type"');
    let type = (Object.hasOwn(WOKWI_BOARDS, p.type) ? WOKWI_BOARDS[p.type] : '') || (isPart(short) ? short : '');
    if (!type) { type = UNKNOWN + p.type; unmapped.push(`${p.id} (${p.type})`); }
    return { id: p.id, type, x: Number.isFinite(p.left) ? p.left : 0, y: Number.isFinite(p.top) ? p.top : 0, ...(Number.isFinite(p.rotate) ? { rot: ((Math.round(p.rotate) % 360) + 360) % 360 } : {}), ...(p.attrs ? { attrs: p.attrs } : {}) };
  });
  const wires: Project['wires'] = [];
  (diagram.connections ?? []).forEach((c: unknown, n: number) => {
    if (!Array.isArray(c) || typeof c[0] !== 'string' || typeof c[1] !== 'string') throw new Error(`diagram.json: connection ${n + 1} is not a ["part:pin", "part:pin", ...] entry`);
    const [a, b, color] = c as string[];
    if (a.startsWith('$') || b.startsWith('$')) return;                       // "$serialMonitor" is not a part
    wires.push({ from: a, to: b, ...(color ? { color } : {}) });
  });
  const boards = parts.filter((p: any) => isBoard(p.type)).map((p: any) => ({ part: p.id, firmware: '' }));
  return { project: parseProject({ version: 1, parts, wires, boards }, 'diagram.json'), unmapped };
}

/** One message per wire end that names a part or pin that does not exist. */
export function validate(p: Project): string[] {
  const byId = new Map(p.parts.map((x) => [x.id, x]));
  const msgs: string[] = [];
  for (const w of p.wires) for (const end of [w.from, w.to]) {
    const i = end.indexOf(':'); const id = end.slice(0, i), pin = end.slice(i + 1);
    const part = byId.get(id);
    if (!part) { msgs.push(`wire ${w.from} -> ${w.to}: there is no part "${id}"`); continue; }
    if (part.type.startsWith(UNKNOWN)) continue;
    if (!pinsOf(part.type)) msgs.push(`wire ${w.from} -> ${w.to}: part "${id}" has unknown type "${part.type}"`);
    else if (canonicalPin(part.type, pin) === null) msgs.push(`wire ${w.from} -> ${w.to}: part "${id}" (${part.type}) has no pin "${pin}"`);
  }
  return msgs;
}
