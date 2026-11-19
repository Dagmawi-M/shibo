// Read a solved operating point back as readings and plain-language warnings.
import type { Netlist } from './netlist.ts';

export interface Reading { volts: number; amps: number | null }
export type PartStatus = 'ok' | 'warn' | 'unchecked';
export interface Report {
  state: 'ok' | 'unchecked';
  /** Why nothing was checked, when state is unchecked. */
  reason?: string;
  warnings: string[];
  /** Per project wire, in order: voltage to GND at its ends, and the current along it (from → to). */
  wires: (Reading | null)[];
  parts: Record<string, PartStatus>;
  pins: { board: string; pin: string; ma: number }[];
  leds: { part: string; name: string; ma: number }[];
  rails: { board: string; pin: string; ma: number; volts: number }[];
}

const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
/** The standard resistor value at or above r. */
export function e12Up(r: number): number {
  if (!(r > 0)) return 10;
  const dec = 10 ** Math.floor(Math.log10(r));
  for (const m of E12) if (m * dec >= r * 0.999) return Math.round(m * dec * 100) / 100;
  return 10 * dec;
}
export const fmtOhms = (r: number): string => (r >= 1e6 ? `${+(r / 1e6).toPrecision(3)} MΩ` : r >= 1e3 ? `${+(r / 1e3).toPrecision(3)} kΩ` : `${+r.toPrecision(3)} Ω`);
const ma = (a: number): string => { const m = Math.abs(a) * 1000; return m >= 1000 ? `${(m / 1000).toFixed(1)} A` : m >= 10 ? `${Math.round(m)} mA` : `${m.toFixed(1)} mA`; };
/** Rounded to `places`, without a minus sign on zero. */
const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places || 0;
const volts = (v: number): string => `${v.toFixed(1)} V`;
const SHORT_A = 2;                // more than this out of a rail is a short, not a load
const SLACK_V = 0.05;

export function unchecked(reason: string, partIds: string[], wires: number): Report {
  return { state: 'unchecked', reason, warnings: [], wires: Array(wires).fill(null), parts: Object.fromEntries(partIds.map((id) => [id, 'unchecked'])), pins: [], leds: [], rails: [] };
}

export function interpret(net: Netlist, values: Map<string, number>, partIds: string[]): Report {
  const v = (n: string): number => (n === '0' ? 0 : values.get(n) ?? 0);
  const i = (branch: string): number => values.get(branch) ?? 0;
  const warnings: string[] = [];
  const parts: Record<string, PartStatus> = Object.fromEntries(partIds.map((id) => [id, 'unchecked' as PartStatus]));
  for (const id of net.modelled) parts[id] = 'ok';
  for (const b of net.boards) parts[b.id] = 'ok';
  const warn = (id: string, text: string) => { warnings.push(text); if (id in parts) parts[id] = 'warn'; };
  for (const n of net.notes) warn(n.slice(0, n.indexOf(' ')), n);

  // ---- board pins ----
  const pins: Report['pins'] = [];
  const totals = new Map<string, number>();
  for (const p of net.pins) {
    const board = net.boards.find((b) => b.id === p.board)!.rating;
    const amps = ((p.from === '0' ? 0 : v(p.from)) - v(p.node)) / p.ohms;          // positive: out of the pin
    pins.push({ board: p.board, pin: p.pin, ma: round(amps * 1000, 2) });
    totals.set(p.board, (totals.get(p.board) ?? 0) + Math.abs(amps));
    const m = Math.abs(amps) * 1000, way = amps > 0 ? 'supplying' : 'sinking';
    if (m > board.pinMaxMa) warn(p.board, `${p.board} pin ${p.pin} is ${way} ${ma(amps)}: over the ${board.chip}'s ${board.pinMaxMa} mA absolute limit, which can damage the pin. Add a resistor, or switch the load with a transistor.`);
    else if (m > board.pinOkMa) warn(p.board, `${p.board} pin ${p.pin} is ${way} ${ma(amps)}: more than the ${board.pinOkMa} mA recommended for a pin (${board.pinMaxMa} mA is the absolute limit). Use a larger resistor, or a transistor for loads like this.`);
  }
  for (const b of net.boards) {
    const t = (totals.get(b.id) ?? 0) * 1000;
    if (t > b.rating.totalMaxMa) warn(b.id, `${b.id}'s pins are carrying ${Math.round(t)} mA together: the ${b.rating.chip} allows ${b.rating.totalMaxMa} mA in total through its pins.`);
    for (const io of b.io) {
      const x = v(io.node);
      if (x > b.rating.pinMaxV + SLACK_V) warn(b.id, `${b.id} pin ${io.pin} sees ${volts(x)}: the ${b.rating.chip}'s pins take at most ${b.rating.pinMaxV} V. Use a divider or a level shifter.`);
      else if (x < -0.5) warn(b.id, `${b.id} pin ${io.pin} sees ${volts(x)}: a pin must not go below GND.`);
    }
  }

  // ---- rails ----
  const rails: Report['rails'] = [];
  const draw = new Map<string, number>();         // board:pin -> amps drawn, including rails fed from it
  for (const r of net.rails) draw.set(`${r.board}:${r.rail.pin}`, -i(r.branch));
  for (const r of net.rails) if (r.rail.from) draw.set(`${r.board}:${r.rail.from}`, (draw.get(`${r.board}:${r.rail.from}`) ?? 0) + Math.max(0, -i(r.branch)));
  for (const r of net.rails) {
    const own = -i(r.branch), total = draw.get(`${r.board}:${r.rail.pin}`) ?? own;
    rails.push({ board: r.board, pin: r.rail.pin, ma: round(total * 1000, 2), volts: round(v(r.node), 3) });
    if (Math.abs(own) > SHORT_A) warn(r.board, `Short circuit: ${r.board}'s ${r.rail.pin} pin is wired straight to GND or to another supply (about ${ma(own)} would flow). A real board would cut out or be damaged.`);
    else if (own < -0.01) warn(r.board, `${r.board}'s ${r.rail.pin} pin has ${ma(own)} pushed into it from a higher voltage: a supply pin can only give current. Check what is wired to ${r.rail.pin}.`);
    else if (total * 1000 > r.rail.maxMa) warn(r.board, `${r.board}'s ${r.rail.pin} supply is asked for ${ma(total)}, more than ${r.rail.what} can give. Power the hungry parts (motors, servos, LED strips) from their own supply, with GND shared.`);
  }

  // ---- LEDs ----
  const leds: Report['leds'] = [];
  for (const l of net.leds) {
    const amps = i(l.branch), m = amps * 1000;
    leds.push({ part: l.part, name: l.name, ma: round(m, 2) });
    const who = l.name ? `${l.part} (${l.name})` : l.part;
    // What a resistor should be for about 10 mA, from the voltage across the LED and its resistor now.
    const across = v(l.a) - v(l.k);
    const want = (drop: number, target: number) => fmtOhms(e12Up(Math.max(1, drop / target)));
    const supply = 5;
    if (m > l.spec.maxMa) warn(l.part, `${who} has ${ma(amps)} through it: over its ${l.spec.maxMa} mA limit, so a real LED would burn out. Put ${want(supply - l.spec.vf, 0.01)} or more in series with it (about 10 mA from 5 V).`);
    else if (m > l.spec.okMa) warn(l.part, `${who} has ${ma(amps)} through it: more than the ${l.spec.okMa} mA it is rated for, so it will wear out early. ${want(supply - l.spec.vf, l.spec.okMa / 1000)} or more in series keeps it within its rating.`);
    else if (m > 0.02 && m < l.spec.dimMa && across > 0) warn(l.part, `${who} has only ${ma(amps)} through it, so it will barely glow. Its resistor is too large: about ${want(supply - l.spec.vf, 0.01)} gives a clear 10 mA from 5 V.`);
  }

  // ---- part supplies and signal levels ----
  for (const s of net.supplies) {
    const x = v(s.vcc) - v(s.gnd);
    if (Math.abs(x) < 0.3) continue;                // not powered at all: the logic layer already says so
    if (x < 0) warn(s.part, `${s.part} is powered backwards (${volts(x)} on ${s.vccPin}): swap its supply wires.`);
    else if (x > s.max + SLACK_V) warn(s.part, `${s.part} gets ${volts(x)} on ${s.vccPin}, but it takes at most ${s.max} V: a real one would be damaged.${s.max < 4 ? ' Power it from 3.3V.' : ''}`);
    else if (x < s.min - SLACK_V) warn(s.part, `${s.part} gets only ${volts(x)} on ${s.vccPin}, but it needs ${s.min} to ${s.max} V, so a real one may not work.${s.min > 4 ? ' Power it from 5V.' : ''}`);
  }
  for (const s of net.signals) {
    const x = v(s.node);
    if (x > s.max + SLACK_V) warn(s.part, `${s.part} pin ${s.pin} sees ${volts(x)}, but ${s.max < 4 ? 'it is a 3.3 V part and ' : ''}takes at most ${s.max} V on its pins. Use a level shifter, or a divider (1 kΩ over 2 kΩ) on lines going into it.`);
  }

  const wires = net.wires.map((w) => (w ? { volts: round(v(w.node), 3), amps: w.branch ? i(w.branch) : null } : null));
  return { state: 'ok', warnings, wires, parts, pins, leds, rails };
}
