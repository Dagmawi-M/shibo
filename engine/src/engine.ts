import type { ChipBackend, Ns, Stateful } from './types.ts';

interface Scheduled { t: Ns; seq: number; fn: () => void }

export interface Snapshot {
  /** The engine that took it. In-memory state can only go back into the objects it came from. */
  owner: Engine;
  now: Ns; log: string[]; seq: number;
  backends: Record<string, unknown>; extras: unknown[]; events: Scheduled[];
}

/** Owns the one virtual clock. Backends and events only move when it says so. */
export class Engine {
  now: Ns = 0;
  log: string[] = [];
  readonly quantumNs: Ns;
  private backends: ChipBackend[] = [];
  private extras: Stateful[] = [];
  private events: Scheduled[] = [];
  private seq = 0;
  /** While backends are running: the time this step will stop at. An earlier event pulls it in. */
  private target: Ns | null = null;
  /** Set by whoever is calling back from inside a backend, so log times are exact. */
  timeSource: (() => Ns) | null = null;

  constructor(opts: { quantumNs?: Ns } = {}) { this.quantumNs = opts.quantumNs ?? 100_000; }

  addBackend(b: ChipBackend): void { this.backends.push(b); }
  /** Register other state (the circuit) to be included in snapshots. */
  addStateful(s: Stateful): void { this.extras.push(s); }

  at(t: Ns, fn: () => void): void {
    if (!Number.isFinite(t)) throw new Error(`cannot schedule an event at ${t}: not a time`);
    if (t < this.now) t = t >= this.now - 1 ? this.now : t;
    if (t < this.now) throw new Error(`cannot schedule an event at ${t} ns: time is already ${this.now} ns`);
    this.events.push({ t, seq: this.seq++, fn });
    this.events.sort((a, b) => a.t - b.t || a.seq - b.seq);
    if (this.target !== null && t < this.target) {
      this.target = t;
      for (const b of this.backends) b.interrupt?.(t);
    }
  }

  /** The most exact time available: a running board's own clock, else the engine's. */
  time(): Ns { return Math.max(this.now, this.timeSource?.() ?? 0); }

  record(line: string): void { this.log.push(`${this.time()} ${line}`); }

  runUntil(end: Ns): void {
    while (this.now < end) {
      // Next stop: the quantum boundary, a scheduled event, or the end, whichever is first.
      let next = Math.min(end, (Math.floor(this.now / this.quantumNs) + 1) * this.quantumNs);
      if (this.events.length && this.events[0].t < next) next = this.events[0].t;
      this.target = next;
      for (const b of this.backends) b.runUntil(this.target);
      this.now = this.target; this.target = null;
      while (this.events.length && this.events[0].t <= this.now) this.events.shift()!.fn();
    }
  }

  snapshot(): Snapshot {
    return {
      owner: this, now: this.now, log: [...this.log], seq: this.seq,
      backends: Object.fromEntries(this.backends.map((b) => [b.id, b.saveState()])),
      extras: this.extras.map((s) => s.saveState()),
      events: [...this.events],
    };
  }

  restore(s: Snapshot): void {
    // Check everything first: a restore either fully applies or changes nothing.
    if (s.owner !== this) throw new Error('snapshot was taken by a different engine (a different or reloaded project) and cannot be restored here');
    for (const b of this.backends) {
      if (!(b.id in s.backends)) throw new Error(`snapshot has no state for board "${b.id}": it was taken from a different project`);
    }
    if (s.extras.length !== this.extras.length) throw new Error('snapshot was taken from a different project: it holds a different set of state');
    this.extras.forEach((x, i) => x.checkState?.(s.extras[i]));
    for (const b of this.backends) b.restoreState(s.backends[b.id]);
    this.extras.forEach((x, i) => x.restoreState(s.extras[i]));
    this.now = s.now; this.seq = s.seq; this.log = [...s.log]; this.events = [...s.events];
  }
}
