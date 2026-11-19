// The electrical layer: watches the circuit, and whenever what is connected
// or driven changes, solves it with ngspice in the background and checks the
// answer against the parts' ratings. Without ngspice, parts show unchecked.
import type { Picture } from '../circuit.ts';
import type { PartDef } from '../part.ts';
import { library } from '../parts/index.ts';
import { buildNetlist } from './netlist.ts';
import { interpret, unchecked, type Report } from './checks.ts';
import { Spice } from './spice.ts';

export type { Report, Reading, PartStatus } from './checks.ts';
export { Spice, findNgspice } from './spice.ts';
export { buildNetlist } from './netlist.ts';

export interface ElectricalOptions {
  /** Path to the ngspice program; default $SHIBO_NGSPICE, else "ngspice" on the PATH. */
  ngspice?: string | null;
  /** A solver to share (one process for many circuits). */
  spice?: Spice;
  lib?: Record<string, PartDef>;
}

/** The same warning with different numbers in it is the same problem. */
const gist = (w: string) => w.replace(/-?\d+(\.\d+)?/g, '#');

export class Electrical {
  private spice: Spice;
  private ownSpice: boolean;
  private lib: Record<string, PartDef>;
  private last: Report | null = null;
  private lastKey = '';
  private busy: Promise<void> | null = null;
  private pending: Picture | null = null;
  private seen = new Map<string, string>();
  private listeners: ((r: Report) => void)[] = [];
  private closed = false;

  constructor(opts: ElectricalOptions = {}) {
    this.spice = opts.spice ?? new Spice(opts.ngspice);
    this.ownSpice = !opts.spice;
    this.lib = opts.lib ?? library;
  }

  onReport(cb: (r: Report) => void): void { this.listeners.push(cb); }
  /** The latest report, or null before the first one. */
  report(): Report | null { return this.last; }
  /** Every problem found so far in this run, each with its latest numbers. */
  warnings(): string[] { return [...this.seen.values()]; }

  /** Look at the circuit again. Solving happens in the background; only the latest picture is solved. */
  update(pic: Picture): void {
    if (this.closed) return;
    if (this.busy) { this.pending = pic; return; }
    this.busy = this.solve(pic).finally(() => {
      this.busy = null;
      const next = this.pending; this.pending = null;
      if (next) this.update(next);
    });
  }

  /** Resolves when nothing is waiting to be solved. */
  async settled(): Promise<void> { while (this.busy) await this.busy; }

  /** Solve one picture now and return its report. */
  async check(pic: Picture): Promise<Report> {
    const net = buildNetlist(pic, this.lib);
    const ids = pic.project.parts.map((p) => p.id);
    if (this.spice.unavailable) return unchecked(this.spice.unavailable, ids, pic.project.wires.length);
    const r = await this.spice.op(net.lines);
    return r.ok ? interpret(net, r.values, ids) : unchecked(r.reason, ids, pic.project.wires.length);
  }

  private async solve(pic: Picture): Promise<void> {
    const net = buildNetlist(pic, this.lib);
    const key = net.lines.join('\n');
    if (key === this.lastKey && this.last) return;
    const report = await this.check(pic);
    if (this.closed) return;
    // Only a real answer is kept for reuse: after a failure, the same circuit is tried again next time.
    this.lastKey = report.state === 'ok' ? key : '';
    this.last = report;
    for (const w of report.warnings) this.seen.set(gist(w), w);
    for (const cb of this.listeners) cb(report);
  }

  close(): void { this.closed = true; this.listeners = []; if (this.ownSpice) this.spice.close(); }
}
