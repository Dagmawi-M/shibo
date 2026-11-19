// Watches the resolved circuit and remembers every level change on the
// board's signal pins and on each buzzer, with exact simulated times. The
// logic analyzer draws from this, a pin hover reads its live state from it,
// and a buzzer's pitch is the rate its drive toggles.
import type { Circuit } from '../circuit.ts';
import type { Engine } from '../engine.ts';
import { boardPins, type Project } from '../project.ts';
import type { Level, Ns } from '../types.ts';

const POWER = /^(GND|5V|3\.3V|VIN|AREF|IOREF|RESET)$/;
/** How far back level changes are kept. */
export const KEEP_NS = 60e9;
const MAX_EDGES = 400_000;            // per signal; a 4 kHz tone for 50 s

export interface Signal { id: string; label: string; kind: 'pin' | 'buzzer' }
export interface PinReading { node: string; level: Level; volts: number | null; freq: number | null; duty: number | null; signal: string | null }

interface Track { sig: Signal; read: () => Level; times: number[]; levels: Level[]; last: Level }

/** One signal's recent shape: how often it repeats and how much of the time it is high. */
export function rhythm(times: number[], levels: Level[], now: Ns): { freq: number; duty: number } | null {
  // Find the last two rising edges and the fall between them.
  let r2 = -1, r1 = -1;
  for (let i = times.length - 1; i > 0; i--) {
    if (levels[i] === 1 && levels[i - 1] === 0) { if (r2 < 0) r2 = i; else { r1 = i; break; } }
  }
  if (r1 < 0) return null;
  const period = times[r2] - times[r1];
  if (!(period > 0)) return null;
  const lastChange = times[times.length - 1];
  if (now - lastChange > 3 * period) return null;      // it has stopped toggling
  let fall = -1;
  for (let i = r1 + 1; i < r2; i++) if (levels[i] === 0) { fall = i; break; }
  const duty = fall < 0 ? 1 : (times[fall] - times[r1]) / period;
  return { freq: 1e9 / period, duty };
}

export class Probe {
  private tracks = new Map<string, Track>();
  private engine: Engine;
  private circuit: Circuit;
  /** While scrubbing back through time, what happens is a replay and is not recorded again. */
  recording = true;

  constructor(engine: Engine, circuit: Circuit, project: Project) {
    this.engine = engine; this.circuit = circuit;
    for (const p of project.parts) {
      if (Object.hasOwn(boardPins, p.type)) {
        for (const pin of boardPins[p.type]) if (!POWER.test(pin)) this.add({ id: `${p.id}:${pin}`, label: `${p.id} ${/^\d/.test(pin) ? 'D' + pin : pin}`, kind: 'pin' }, () => circuit.levelAt(`${p.id}:${pin}`));
      } else if (p.type === 'buzzer') {
        this.add({ id: p.id, label: `${p.id} (buzzer)`, kind: 'buzzer' }, () => {
          const a = circuit.levelAt(`${p.id}:1`), b = circuit.levelAt(`${p.id}:2`);
          return a !== null && b !== null && a !== b ? 1 : 0;
        });
      }
    }
    circuit.onSettle(() => this.sample());
    this.sample();
  }

  private add(sig: Signal, read: () => Level): void { this.tracks.set(sig.id, { sig, read, times: [], levels: [], last: undefined as unknown as Level }); }

  signals(): Signal[] { return [...this.tracks.values()].map((t) => t.sig); }

  private sample(): void {
    if (!this.recording) return;
    const now = this.engine.time();
    for (const t of this.tracks.values()) {
      const l = t.read();
      if (l === t.last) continue;
      t.last = l;
      // Two changes at the same instant: the later one is what the net settled to.
      if (t.times.length && t.times[t.times.length - 1] === now) { t.levels[t.levels.length - 1] = l; continue; }
      t.times.push(now); t.levels.push(l);
      if (t.times.length > MAX_EDGES) { t.times.splice(0, t.times.length - MAX_EDGES); t.levels.splice(0, t.levels.length - MAX_EDGES); }
    }
  }

  /** Drop what is older than the window kept. */
  trim(): void {
    const cut = this.engine.now - KEEP_NS;
    for (const t of this.tracks.values()) {
      let i = 0;
      while (i < t.times.length - 1 && t.times[i + 1] < cut) i++;      // keep the change that sets the level at the cut
      if (i) { t.times.splice(0, i); t.levels.splice(0, i); }
    }
  }

  /** Forget everything after a time: history from there on is being rewritten. Then pick up the present level. */
  cutAfter(at: Ns): void {
    for (const t of this.tracks.values()) {
      let n = t.times.length;
      while (n && t.times[n - 1] > at) n--;
      t.times.length = n; t.levels.length = n;
      t.last = n ? t.levels[n - 1] : (undefined as unknown as Level);
    }
    this.recording = true;
    this.sample();
  }

  /** Level changes of a signal at or after a time, as [t, level] pairs, plus the level just before. */
  edges(id: string, from: Ns = 0, to: Ns = Infinity): { start: Level; times: number[]; levels: Level[] } {
    const t = this.tracks.get(id);
    if (!t) return { start: null, times: [], levels: [] };
    let lo = 0, hi = t.times.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t.times[m] < from) lo = m + 1; else hi = m; }
    let end = lo;
    while (end < t.times.length && t.times[end] <= to) end++;
    return { start: lo > 0 ? t.levels[lo - 1] : null, times: t.times.slice(lo, end), levels: t.levels.slice(lo, end) };
  }

  /** How a signal is behaving right now. */
  rhythmOf(id: string): { freq: number; duty: number } | null {
    const t = this.tracks.get(id);
    if (!t) return null;
    // While scrubbing back, what was recorded after this moment has not happened yet.
    const now = this.engine.time();
    let lo = 0, hi = t.times.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t.times[m] <= now) lo = m + 1; else hi = m; }
    const k = Math.max(0, lo - 6);
    return rhythm(t.times.slice(k, lo), t.levels.slice(k, lo), now);
  }

  /** The signal a node is on: a buzzer itself, or a board pin on the same net. */
  signalFor(node: string): string | null {
    const id = node.slice(0, node.indexOf(':'));
    if (this.tracks.get(id)?.sig.kind === 'buzzer') return id;
    if (this.tracks.has(node)) return node;
    for (const t of this.tracks.values()) if (t.sig.kind === 'pin' && this.circuit.sameNet(t.sig.id, node)) return t.sig.id;
    return null;
  }

  /** What a pin is doing: its level, any voltage put on it, and its rhythm if it is toggling. */
  read(node: string): PinReading {
    const signal = this.signalFor(node);
    const level = this.circuit.levelAt(node);
    const r = signal && this.tracks.get(signal)?.sig.kind === 'pin' ? this.rhythmOf(signal) : null;
    return { node, level, volts: this.circuit.voltsAt(node), freq: r ? r.freq : null, duty: r ? r.duty : null, signal };
  }

  /** The pitch each buzzer is sounding, in Hz; 0 for silent. A steady voltage only clicks. */
  tones(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of this.tracks.values()) if (t.sig.kind === 'buzzer') {
      const r = this.rhythmOf(t.sig.id);
      out[t.sig.id] = r && r.freq >= 20 && r.freq <= 20000 ? r.freq : 0;
    }
    return out;
  }
}
