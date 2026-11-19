// Circuit edits as pure functions: each returns a new project and leaves its
// input alone, so the editor can undo, and so they are testable without a UI.
import { library } from './parts/index.ts';
import type { ControlDef, UiEvent } from './part.ts';
import { canonicalPin, COLOR, ID, isBoard, partAttrs, validate, type Project } from './project.ts';

export interface CatalogEntry {
  type: string; label: string; tag: string; group: string; board?: boolean; attrs?: string[];
  show?: Record<string, string>; events?: UiEvent[]; paint?: string; controls?: Record<string, ControlDef>;
}

/** What the palette offers: the boards, then every library part. `tag` is the drawing. */
export const catalog: CatalogEntry[] = [
  { type: 'uno', label: 'Arduino Uno', tag: 'wokwi-arduino-uno', group: 'Boards', board: true },
  { type: 'nano', label: 'Arduino Nano', tag: 'wokwi-arduino-nano', group: 'Boards', board: true },
  { type: 'mega', label: 'Arduino Mega 2560', tag: 'wokwi-arduino-mega', group: 'Boards', board: true },
  { type: 'attiny85', label: 'ATtiny85 (Digispark-style)', tag: 'shibo-attiny85', group: 'Boards', board: true },
  ...Object.values(library).filter((d) => d.ui).map((d) => ({
    type: d.type, label: d.ui!.label, tag: d.ui!.tag, group: d.ui!.group,
    ...(d.attrs?.length ? { attrs: d.attrs } : {}), ...(d.ui!.show ? { show: d.ui!.show } : {}), ...(d.ui!.events ? { events: d.ui!.events } : {}),
    ...(d.ui!.paint ? { paint: d.ui!.paint } : {}), ...(d.controls ? { controls: d.controls } : {}),
  })),
];

const clone = (p: Project): Project => structuredClone(p);
const known = (type: unknown): type is string => typeof type === 'string' && (isBoard(type) || Object.hasOwn(library, type));
const number = (v: unknown, what: string): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} must be a number, got ${JSON.stringify(v)}`); return v; };

function part(p: Project, id: string) {
  const x = p.parts.find((q) => q.id === id);
  if (!x) throw new Error(`there is no part "${id}"`);
  return x;
}

export function addPart(p: Project, type: string, x: number, y: number): { project: Project; id: string } {
  if (!known(type)) throw new Error(`there is no part type "${String(type)}"`);
  number(x, 'x'); number(y, 'y');
  const project = clone(p);
  // An id must start with a letter; a few part types (7segment) do not.
  // A type that ends in a digit (lcd1602) gets a dash, so the first one is lcd1602-1 and not lcd16021.
  const base = (/^[A-Za-z_]/.test(type) ? type : `part-${type}`) + (/\d$/.test(type) ? '-' : '');
  let n = 1;
  while (project.parts.some((q) => q.id === `${base}${n}`)) n++;
  const id = `${base}${n}`;
  project.parts.push({ id, type, x, y });
  if (isBoard(type)) project.boards.push({ part: id, firmware: '' });
  return { project, id };
}

export function movePart(p: Project, id: string, x: number, y: number): Project {
  number(x, 'x'); number(y, 'y');
  const project = clone(p); const q = part(project, id);
  q.x = x; q.y = y;
  return project;
}

export function removePart(p: Project, id: string): Project {
  const project = clone(p); part(project, id);
  project.parts = project.parts.filter((q) => q.id !== id);
  project.wires = project.wires.filter((w) => !w.from.startsWith(id + ':') && !w.to.startsWith(id + ':'));
  project.boards = project.boards.filter((b) => b.part !== id);
  return project;
}

function checkEnd(p: Project, ref: string): void {
  if (typeof ref !== 'string') throw new Error('a wire end must be part:pin text');
  const i = ref.indexOf(':');
  if (i < 1) throw new Error(`"${ref}" is not a part:pin`);
  const q = part(p, ref.slice(0, i));
  if (q.type.startsWith('unknown:')) return;
  if (canonicalPin(q.type, ref.slice(i + 1)) === null) throw new Error(`part "${q.id}" (${q.type}) has no pin "${ref.slice(i + 1)}"`);
}

/** A sensible default colour, as on a real bench: ground black, supply red. */
function wireColor(a: string, b: string): string {
  const pins = [a, b].map((r) => r.slice(r.indexOf(':') + 1));
  if (pins.some((x) => /^GND/.test(x))) return 'black';
  if (pins.some((x) => /^(5V|3\.3V|VIN|VCC)/.test(x))) return 'red';
  return 'green';
}

export function addWire(p: Project, from: string, to: string): Project {
  if (from === to) throw new Error('a wire needs two different pins; that is the same pin');
  checkEnd(p, from); checkEnd(p, to);
  if (p.wires.some((w) => (w.from === from && w.to === to) || (w.from === to && w.to === from))) throw new Error(`${from} and ${to} are already wired`);
  const project = clone(p);
  project.wires.push({ from, to, color: wireColor(from, to) });
  return project;
}

export function removeWire(p: Project, index: number): Project {
  if (!Number.isInteger(index) || index < 0 || index >= p.wires.length) throw new Error(`there is no wire number ${index}`);
  const project = clone(p);
  project.wires.splice(index, 1);
  return project;
}

export function setAttr(p: Project, id: string, key: string, value: string): Project {
  const project = clone(p); const q = part(project, id);
  const allowed = Object.hasOwn(partAttrs, q.type) ? partAttrs[q.type] : [];
  if (!allowed.includes(key)) throw new Error(`a ${q.type} has no setting "${String(key)}"`);
  if (typeof value !== 'string' || !/^[\w#.-]{0,32}$/.test(value)) throw new Error(`"${String(value)}" is not a usable value for ${key}`);
  q.attrs = { ...(q.attrs ?? {}), [key]: value };
  return project;
}

/** Drop every wire that points at a part or pin that is not there. */
export function pruneWires(p: Project): Project {
  const project = clone(p);
  project.wires = project.wires.filter((w) => validate({ ...project, wires: [w] }).length === 0);
  return project;
}

/** Turn a part a quarter turn clockwise. */
export function rotatePart(p: Project, id: string): Project {
  const project = clone(p); const q = part(project, id);
  const rot = ((q.rot ?? 0) + 90) % 360;
  if (rot) q.rot = rot; else delete q.rot;
  return project;
}

/** Give a part a new name; its wires follow. */
export function renamePart(p: Project, id: string, name: string): Project {
  part(p, id);
  if (name === id) return p;
  if (typeof name !== 'string' || !ID.test(name)) throw new Error('that name cannot be used: start with a letter, then letters, digits, - or _');
  if (p.parts.some((q) => q.id === name)) throw new Error(`there is already a part called "${name}"`);
  const project = clone(p);
  part(project, id).id = name;
  const move = (ref: string) => (ref.startsWith(id + ':') ? name + ref.slice(id.length) : ref);
  for (const w of project.wires) { w.from = move(w.from); w.to = move(w.to); }
  for (const b of project.boards) if (b.part === id) b.part = name;
  return project;
}

export function setWireColor(p: Project, index: number, color: string): Project {
  if (!Number.isInteger(index) || index < 0 || index >= p.wires.length) throw new Error(`there is no wire number ${index}`);
  if (typeof color !== 'string' || !COLOR.test(color)) throw new Error('that is not a colour that can be used');
  const project = clone(p);
  project.wires[index].color = color;
  return project;
}
