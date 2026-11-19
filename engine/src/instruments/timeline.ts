// Rewind: the engine takes a snapshot every so often while it runs. To go
// back to any moment, restore the last snapshot before it and run forward to
// it exactly; the engine is deterministic, so that moment comes back as it was.
import type { Engine, Snapshot } from '../engine.ts';
import type { Ns } from '../types.ts';

export class Timeline {
  private snaps: Snapshot[] = [];
  private engine: Engine;
  private everyNs: Ns;
  private keepNs: Ns;
  /** The furthest time the run has reached. While scrubbing back it stays ahead of the engine. */
  head: Ns;

  constructor(engine: Engine, opts: { everyMs?: number; keepMs?: number } = {}) {
    this.engine = engine;
    this.everyNs = (opts.everyMs ?? 250) * 1e6; this.keepNs = (opts.keepMs ?? 60e3) * 1e6;
    this.head = engine.now;
    this.snaps.push(engine.snapshot());
  }

  /** The earliest moment that can be gone back to. */
  get start(): Ns { return this.snaps[0].now; }
  get count(): number { return this.snaps.length; }

  /** Call as the run moves forward: takes a snapshot when one is due, and forgets the oldest. */
  advance(): void {
    const now = this.engine.now;
    this.head = Math.max(this.head, now);
    if (now - this.snaps[this.snaps.length - 1].now >= this.everyNs) this.snaps.push(this.engine.snapshot());
    while (this.snaps.length > 1 && now - this.snaps[1].now > this.keepNs) this.snaps.shift();
  }

  /** Put the run at time t (clamped to what was recorded). Returns the time it is now at. */
  seek(t: Ns): Ns {
    t = Math.round(Math.min(this.head, Math.max(this.start, t)));
    let i = this.snaps.length - 1;
    while (i > 0 && this.snaps[i].now > t) i--;
    // Already between that snapshot and t: just run on, no restore needed.
    if (!(this.engine.now >= this.snaps[i].now && this.engine.now <= t)) this.engine.restore(this.snaps[i]);
    this.engine.runUntil(t);
    return this.engine.now;
  }

  /** Carry on from here: what was recorded after now will not happen any more. */
  branch(): void {
    const now = this.engine.now;
    while (this.snaps.length > 1 && this.snaps[this.snaps.length - 1].now > now) this.snaps.pop();
    this.head = now;
  }
}
