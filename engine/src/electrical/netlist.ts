// Turn the circuit as it stands (wires, part contacts, board pin states) into
// a SPICE netlist, and remember what each element stands for so the answer
// can be read back as pin currents, LED currents and wire readings.
import type { Picture } from '../circuit.ts';
import type { PartDef } from '../part.ts';
import { canonicalPin, isBoard } from '../project.ts';
import { boardRating, partRatings, type BoardRating, type Electrical, type LedSpec, type Rail } from './ratings.ts';

export interface PinMap { board: string; pin: string; node: string; level: 0 | 1 | 'pullup'; from: string; ohms: number }
export interface LedMap { part: string; name: string; branch: string; spec: LedSpec; a: string; k: string }
export interface RailMap { board: string; rail: Rail; branch: string; node: string }
export interface Netlist {
  lines: string[];
  /** Per project wire: the ammeter in it (null if it closes a loop of wires), and the spice node at its ends. */
  wires: ({ branch: string | null; node: string } | null)[];
  pins: PinMap[];
  leds: LedMap[];
  rails: RailMap[];
  boards: { id: string; type: string; rating: BoardRating; io: { pin: string; node: string }[] }[];
  supplies: { part: string; vcc: string; gnd: string; vccPin: string; min: number; max: number }[];
  signals: { part: string; pin: string; node: string; max: number }[];
  /** Parts the solver has a model for, and parts it does not. */
  modelled: string[]; unmodelled: string[];
  /** Things that stop a part being modelled properly, as sentences. */
  notes: string[];
}

const DRIVE_OHMS = 50;            // a part's own logic output
const ANALOG_OHMS = 100;          // a sensor module's analog output
const PULL_OHMS = 10_000;
const VT = 0.025852;              // thermal voltage at 27 °C
const N = 2, RS = 5;

/** A diode model that drops spec.vf at 20 mA. */
function ledModel(spec: LedSpec): string {
  const is = 0.02 / (Math.exp((spec.vf - 0.02 * RS) / (N * VT)) - 1);
  return `D(IS=${is.toExponential(4)} N=${N} RS=${RS})`;
}

export const ratingOf = (def: PartDef | undefined, type: string): Electrical | undefined =>
  def?.electrical ?? (Object.hasOwn(partRatings, type) ? partRatings[type] : undefined);

export function buildNetlist(pic: Picture, lib: Record<string, PartDef>): Netlist {
  const types = new Map(pic.project.parts.map((p) => [p.id, p.type]));
  const canon = (ref: string): string => {
    const i = ref.indexOf(':'), id = ref.slice(0, i), type = types.get(id);
    const pin = type ? canonicalPin(type, ref.slice(i + 1)) : null;
    return pin === null ? ref : `${id}:${pin}`;
  };

  // Union-find over pin refs, for which wires are a tree and which close a loop.
  const parent = new Map<string, string>();
  const find = (x: string): string => { if (!parent.has(x)) parent.set(x, x); let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };

  // Spice node names: ground is 0, everything else n1, n2, ...
  const names = new Map<string, string>();
  const ground = new Set<string>(), alias = new Map<string, string>();
  const node = (ref: string): string => {
    let r = canon(ref);
    r = alias.get(r) ?? r;
    if (ground.has(r)) return '0';
    let n = names.get(r);
    if (!n) { n = `n${names.size + 1}`; names.set(r, n); }
    return n;
  };

  const lines: string[] = ['shibo circuit', '.options rshunt=1e9'];
  const out: Netlist = { lines, wires: [], pins: [], leds: [], rails: [], boards: [], supplies: [], signals: [], modelled: [], unmodelled: [], notes: [] };
  let k = 0;
  const models = new Map<string, string>();

  // ---- boards that are running ----
  for (const [id, drives] of Object.entries(pic.boards)) {
    const type = types.get(id) ?? 'uno', rating = boardRating(type);
    ground.add(`${id}:GND`);
    for (const [from, to] of Object.entries(rating.aliases ?? {})) alias.set(`${id}:${from}`, `${id}:${to}`);
    const vccInt = `vcc_${k++}`;
    const railPins = new Set(rating.rails.map((r) => r.pin));
    const chipRail = rating.rails.find((r) => r.volts === rating.vcc);       // the chip runs off this rail
    for (const rail of rating.rails) {
      const src = `vrail${k++}`, int = rail === chipRail ? vccInt : `rint${k++}`;
      lines.push(`${src} ${int} 0 ${rail.volts}`, `rrail${k++} ${int} ${node(`${id}:${rail.pin}`)} ${rail.ohms}`);
      out.rails.push({ board: id, rail, branch: `${src}#branch`, node: node(`${id}:${rail.pin}`) });
    }
    if (!chipRail) lines.push(`vchip${k++} ${vccInt} 0 ${rating.vcc}`);
    const skip = new Set(['GND', ...railPins, ...Object.keys(rating.aliases ?? {}), ...(rating.other ?? [])]);
    if (rating.other?.includes('RESET')) lines.push(`rreset${k++} ${vccInt} ${node(`${id}:RESET`)} 10000`);
    const io: { pin: string; node: string }[] = [];
    const pinsOf = new Map(drives.map((d) => [d.pin, d]));
    // Every I/O pin that is driven or wired, for the current and over-voltage checks.
    const all = new Set(drives.map((d) => d.pin));
    for (const ref of pic.project.wires.flatMap((w) => [w.from, w.to])) if (ref.startsWith(`${id}:`)) all.add(canon(ref).slice(id.length + 1));
    for (const pin of all) {
      if (skip.has(pin)) continue;
      const n = node(`${id}:${pin}`);
      io.push({ pin, node: n });
      const d = pinsOf.get(pin);
      if (!d) continue;
      const level = d.level === 1 ? 1 : d.level === 0 ? 0 : d.pull === 'up' ? 'pullup' as const : null;
      if (level === null) continue;
      const from = level === 0 ? '0' : vccInt, ohm = level === 'pullup' ? rating.pullupOhms : rating.pinOhms;
      lines.push(`rpin${k++} ${from} ${n} ${ohm}`);
      out.pins.push({ board: id, pin, node: n, level, from, ohms: ohm });
    }
    out.boards.push({ id, type, rating, io });
  }

  // ---- parts ----
  const drivesByPart = new Map<string, Picture['drives']>();
  for (const d of pic.drives) { const id = d.node.slice(0, d.node.indexOf(':')); if (!drivesByPart.has(id)) drivesByPart.set(id, []); drivesByPart.get(id)!.push(d); }
  const analogByPart = new Map<string, Picture['analog']>();
  for (const a of pic.analog) { const id = a.node.slice(0, a.node.indexOf(':')); if (!analogByPart.has(id)) analogByPart.set(id, []); analogByPart.get(id)!.push(a); }

  for (const p of pic.project.parts) {
    if (isBoard(p.type)) continue;
    const def = Object.hasOwn(lib, p.type) ? lib[p.type] : undefined;
    const rating = ratingOf(def, p.type);
    if (!rating) { out.unmodelled.push(p.id); continue; }
    out.modelled.push(p.id);
    const ref = (pin: string) => node(`${p.id}:${pin}`);
    for (const e of rating.elements?.(p.attrs ?? {}, pic.controls[p.id] ?? {}, pic.outputs[p.id] ?? {}) ?? []) {
      if (e.kind === 'R') {
        if (!Number.isFinite(e.ohms) || e.ohms <= 0) { out.notes.push(`${p.id} has a value Shibo does not understand as a resistance, so it is left out of the electrical check. Write it like 220, 4.7k or 1M.`); continue; }
        lines.push(`r${k++} ${ref(e.a)} ${ref(e.b)} ${e.ohms}`);
      } else if (e.kind === 'load') {
        if (e.ma > 0) lines.push(`rload${k++} ${ref(e.vcc)} ${ref(e.gnd)} ${(e.volts / (e.ma / 1000)).toPrecision(6)}`);
      } else {
        const key = ledModel(e.spec);
        if (!models.has(key)) { models.set(key, `dled${models.size + 1}`); lines.push(`.model ${models.get(key)} ${key}`); }
        const v = `vled${k++}`, mid = `m${k++}`;
        lines.push(`${v} ${ref(e.a)} ${mid} 0`, `d${k++} ${mid} ${ref(e.k)} ${models.get(key)}`);
        out.leds.push({ part: p.id, name: e.name, branch: `${v}#branch`, spec: e.spec, a: ref(e.a), k: ref(e.k) });
      }
    }
    const sup = rating.supplies?.[0];
    for (const s of rating.supplies ?? []) out.supplies.push({ part: p.id, vcc: ref(s.vcc), gnd: ref(s.gnd), vccPin: s.vcc, min: s.min, max: s.max });
    if (rating.logicMax !== undefined) {
      const supplyPins = new Set((rating.supplies ?? []).flatMap((s) => [s.vcc, s.gnd]));
      for (const pin of rating.signals ?? (def?.pins ?? []).filter((x) => !supplyPins.has(x))) out.signals.push({ part: p.id, pin, node: ref(pin), max: rating.logicMax });
    }
    // What the part itself drives: logic outputs swing to its own supply.
    for (const d of drivesByPart.get(p.id) ?? []) {
      const pin = d.node.slice(p.id.length + 1), n = ref(pin);
      const hi = sup ? `e${k++}` : '', hiNode = `h${k++}`;
      if (d.level === 1 || (d.level === null && d.pull === 'up')) {
        if (sup) lines.push(`${hi} ${hiNode} 0 ${ref(sup.vcc)} ${ref(sup.gnd)} 1`); else lines.push(`vdrv${k++} ${hiNode} 0 5`);
        lines.push(`rdrv${k++} ${hiNode} ${n} ${d.level === 1 ? DRIVE_OHMS : PULL_OHMS}`);
      } else if (d.level === 0 || d.pull === 'down') {
        lines.push(`rdrv${k++} ${sup ? ref(sup.gnd) : '0'} ${n} ${d.level === 0 ? DRIVE_OHMS : PULL_OHMS}`);
      }
    }
    if (!rating.ownAnalog) for (const a of analogByPart.get(p.id) ?? []) {
      const src = `va${k++}`, int = `a${k++}`;
      lines.push(`${src} ${int} 0 ${a.volts}`, `ranalog${k++} ${int} ${ref(a.node.slice(p.id.length + 1))} ${ANALOG_OHMS}`);
    }
  }

  // ---- wires: a tree of ammeters; a wire that closes a loop of wires carries no meter ----
  const ammeter = (a: string, b: string): string | null => {
    const na = node(a), nb = node(b);
    if (na === nb) return null;
    const ra = find(na), rb = find(nb);
    if (ra === rb) return null;
    parent.set(ra, rb);
    const v = `vw${k++}`;
    lines.push(`${v} ${na} ${nb} 0`);
    return `${v}#branch`;
  };
  for (const w of pic.project.wires) {
    const known = (ref: string) => types.has(ref.slice(0, ref.indexOf(':')));
    if (!known(w.from) || !known(w.to)) { out.wires.push(null); continue; }
    out.wires.push({ branch: ammeter(w.from, w.to), node: node(w.from) });
  }
  for (const l of pic.links) if (l.kind === 'wire') ammeter(l.a, l.b);
  return out;
}
