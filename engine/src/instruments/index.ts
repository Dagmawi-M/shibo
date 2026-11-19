// The bench instruments for one run: pause, rewind and scrub; a probe for
// pin hover; a logic analyzer feed; buzzer pitches for the page to play; and
// the project's environment script on the clock.
import type { Circuit } from '../circuit.ts';
import type { Engine } from '../engine.ts';
import type { Project } from '../project.ts';
import type { Level } from '../types.ts';
import { Probe, type PinReading, type Signal } from './probe.ts';
import { Timeline } from './timeline.ts';
import { schedule, type ScriptStep } from './envscript.ts';

export type InstrumentIn =
  | { t: 'pause' }
  | { t: 'resume' }
  | { t: 'seek'; ms: number }
  | { t: 'probe'; node: string }
  | { t: 'watch'; signals: string[] };

export interface TraceData { start: Level; times: number[]; levels: Level[] }
export type InstrumentOut =
  | { t: 'timeline'; fromMs: number; toMs: number; nowMs: number; paused: boolean }
  | { t: 'signals'; list: Signal[] }
  | { t: 'trace'; reset: boolean; nowNs: number; data: Record<string, TraceData> }
  | { t: 'probe'; reading: PinReading }
  | { t: 'tones'; tones: Record<string, number> }
  | { t: 'controls'; values: Record<string, Record<string, number>> }
  | { t: 'serial'; text: string };

export const INSTRUMENT_MESSAGES = new Set(['pause', 'resume', 'seek', 'probe', 'watch']);
const MS = 1e6;
/** How much history a newly watched signal arrives with. */
const BACKLOG_NS = 20e9;
const MAX_WATCH = 16;

export class Instruments {
  readonly probe: Probe;
  readonly timeline: Timeline;
  paused = false;
  private engine: Engine;
  private circuit: Circuit;
  private send: (m: InstrumentOut) => void;
  private watched: string[] = [];
  private cursor = 0;                        // trace sent up to this time
  private lastTones = '';
  private lastControls = '';
  private lastTimelineMs = -Infinity;
  private failures: string[] = [];
  /** Called when the run's visible state jumped (a seek): the session resends outputs and status. */
  private jumped: () => void;

  constructor(engine: Engine, circuit: Circuit, project: Project & { script?: ScriptStep[] }, send: (m: InstrumentOut) => void, jumped: () => void = () => {}) {
    this.engine = engine; this.circuit = circuit; this.send = send; this.jumped = jumped;
    this.probe = new Probe(engine, circuit, project);
    schedule(engine, circuit, project.script ?? [], (msg) => { if (!this.failures.includes(msg)) this.failures.push(msg); });
    this.timeline = new Timeline(engine);          // after scheduling: a rewind to the start keeps the script
    this.lastControls = JSON.stringify(circuit.controlValues());
    send({ t: 'signals', list: this.probe.signals() });
    this.sendTimeline();
  }

  /** Script steps that failed while running. */
  problems(): string[] { return this.failures; }

  handle(m: InstrumentIn): void {
    switch (m.t) {
      case 'pause': this.paused = true; this.probe.recording = false; this.sendTimeline(); break;
      case 'resume': this.resume(); break;
      case 'seek': {
        if (!Number.isFinite(m.ms)) throw new Error('seek needs a time in milliseconds');
        if (!this.paused) this.handle({ t: 'pause' });
        this.timeline.seek(m.ms * MS);
        this.engine.log.length = 0;
        this.sendTimeline(); this.sendTones(); this.sendControls(); this.jumped();
        break;
      }
      case 'probe': if (typeof m.node === 'string' && m.node.includes(':')) this.send({ t: 'probe', reading: this.probe.read(m.node) }); break;
      case 'watch': {
        const known = new Set(this.probe.signals().map((s) => s.id));
        this.watched = (Array.isArray(m.signals) ? m.signals : []).filter((s) => typeof s === 'string' && known.has(s)).slice(0, MAX_WATCH);
        this.sendTrace(true);
        break;
      }
    }
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.engine.now < this.timeline.head) this.send({ t: 'serial', text: `\n--- rewound to ${(this.engine.now / 1e9).toFixed(2)} s ---\n` });
    this.timeline.branch();
    this.probe.cutAfter(this.engine.now);
    this.sendTrace(true); this.sendTimeline();
  }

  /** After the session moved the run forward. */
  afterTick(): void {
    this.timeline.advance();
    this.probe.trim();
    this.sendTones();
    this.sendTrace(false);
    this.sendControls();
    if (this.engine.now / MS - this.lastTimelineMs >= 100) this.sendTimeline();
  }

  private sendTimeline(): void {
    this.lastTimelineMs = this.engine.now / MS;
    this.send({ t: 'timeline', fromMs: this.timeline.start / MS, toMs: this.timeline.head / MS, nowMs: this.engine.now / MS, paused: this.paused });
  }

  private sendTones(): void {
    const tones = this.paused ? {} : this.probe.tones();
    for (const k of Object.keys(tones)) tones[k] = Math.round(tones[k] * 10) / 10;
    const key = JSON.stringify(tones);
    if (key !== this.lastTones) { this.lastTones = key; this.send({ t: 'tones', tones }); }
  }

  private sendControls(): void {
    const values = this.circuit.controlValues(), key = JSON.stringify(values);
    if (key !== this.lastControls) { this.lastControls = key; this.send({ t: 'controls', values }); }
  }

  private sendTrace(reset: boolean): void {
    if (!this.watched.length) return;
    const now = this.timeline.head;
    const from = reset ? now - BACKLOG_NS : this.cursor;
    const data: Record<string, TraceData> = {};
    for (const id of this.watched) {
      const e = this.probe.edges(id, from);
      // Changes exactly at the cursor were in the last message.
      if (!reset) while (e.times.length && e.times[0] <= from) { e.times.shift(); e.levels.shift(); }
      if (reset || e.times.length) data[id] = e;
    }
    this.cursor = now;
    if (reset || Object.keys(data).length) this.send({ t: 'trace', reset, nowNs: now, data });
  }
}
