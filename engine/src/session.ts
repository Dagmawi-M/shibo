// One open project and at most one running simulation, driven by JSON
// messages. The browser page and the VS Code panel both talk to this, each
// over its own transport, so neither contains any simulation logic.
import { MAX_SKETCH } from './share.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from './engine.ts';
import { Circuit } from './circuit.ts';
import { createBackend, runnableBoards } from './backends/index.ts';
import type { ChipBackend } from './types.ts';
import { importWokwi, parseProject, validate, type Project } from './project.ts';
import * as edit from './edit.ts';
import { buildSketch, NO_SKETCH } from './build.ts';
import { generateSketch } from './sketchgen.ts';
import { generateGuide } from './guide.ts';
import { templates, sharedFolder, OWN_FOLDER } from './templates.ts';
import { Electrical, Spice, type Report } from './electrical/index.ts';
import { Instruments, INSTRUMENT_MESSAGES, type InstrumentIn, type InstrumentOut } from './instruments/index.ts';
import { exportBom, loadPrices, savePrice, PRICES_FILE } from './prices.ts';
import type { PriceBook, PriceEntry } from './bom.ts';
import { scriptProblems, setScript } from './instruments/envscript.ts';

export type InMsg =
  | { t: 'hello' }
  | { t: 'open'; dir: string }
  | { t: 'edit'; op: string; args: unknown[] }
  | { t: 'save' }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'createSketch' }
  | { t: 'template'; id: string }
  | { t: 'guide' }
  | { t: 'start' }
  | { t: 'stop' }
  | { t: 'control'; part: string; name: string; value: number }
  | { t: 'serial'; text: string; part?: string }
  | { t: 'shareInfo' }
  | { t: 'openShared'; project: unknown; sketch: string | null; embed?: boolean }
  | { t: 'prices' }
  | { t: 'exportBom'; format: 'csv' | 'md' }
  | { t: 'setPrice'; key: string; entry: PriceEntry; currency?: string }
  | InstrumentIn;

import type { Outputs } from './circuit.ts';
export type { Outputs };
export type OutMsg =
  | { t: 'project'; project: Project; catalog: edit.CatalogEntry[]; dirty: boolean; unmapped: string[]; dir: string; canUndo: boolean; canRedo: boolean; sketch: string | null; templates: { id: string; label: string; detail: string }[] }
  | { t: 'guideCreated'; path: string }
  | { t: 'sketchCreated'; path: string }
  | { t: 'status'; state: 'idle' | 'building' | 'running'; timeMs: number }
  | { t: 'outputs'; outputs: Outputs }
  | { t: 'serial'; text: string }
  | { t: 'problems'; items: string[] }
  | { t: 'dirty'; dirty: boolean }
  /** Voltages and currents from the circuit solver: per wire (in project order) and a status per part. */
  | { t: 'electrical'; state: Report['state']; reason?: string; wires: Report['wires']; parts: Report['parts'] }
  | { t: 'error'; message: string }
  | { t: 'shareInfo'; project: Project; sketch: string | null }
  | { t: 'shared'; ok: boolean; message: string }
  | { t: 'prices'; book: PriceBook; file: string }
  | { t: 'bomExported'; path: string }
  | InstrumentOut;

/** Compile the sketch in a folder for a board type ("uno", "mega", ...). */
type Build = (dir: string, board: string) => Promise<{ ok: boolean; log: string; hex?: string }>;
interface Run { engine: Engine; chip: ChipBackend; circuit: Circuit; electrical: Electrical; inst: Instruments; serial: string; lastOutputs: string; lastProblems: string; lastStatusMs: number }

const MS = 1e6;
const MAX_STEP_MS = 50;           // a stalled host must not make the simulation leap ahead
const FILE = 'shibo.json';
const MAX_SERIAL = 4096;          // bytes accepted in one message from the page
const EDITS = new Map<string, (p: Project, ...a: any[]) => Project>([
  ['addPart', (p, type, x, y) => edit.addPart(p, type, x, y).project],
  ['movePart', edit.movePart], ['removePart', edit.removePart], ['addWire', edit.addWire],
  ['removeWire', edit.removeWire], ['setAttr', edit.setAttr], ['pruneWires', edit.pruneWires],
  ['rotatePart', edit.rotatePart], ['renamePart', edit.renamePart], ['setWireColor', edit.setWireColor],
  ['setScript', setScript],
  ['setWirePoints', edit.setWirePoints], ['moveParts', edit.moveParts], ['removeParts', edit.removeParts], ['pasteParts', edit.pasteParts],
]);

export class Session {
  private build: Build;
  private listeners: ((m: OutMsg) => void)[] = [];
  private dir = '';
  private project: Project = { version: 1, parts: [], wires: [], boards: [] };
  private dirty = false;
  private run: Run | null = null;
  private starting = false;
  private startId = 0;              // bumped by anything that should cancel a start in progress
  private lastWarnings: string[] = [];   // what the last run found, kept on show until the circuit changes or runs again
  private spice: Spice | null = null;   // one solver process for the whole session, started on the first run
  private ngspice: string | null | undefined;
  private loadError = '';           // why the project file could not be read, if it could not
  private disposed = false;

  private past: Project[] = [];
  private future: Project[] = [];
  private watching: boolean;
  private watcher: fs.FSWatcher | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private home: string | undefined;

  /**
   * `watch`: upload again whenever the sketch is saved during a run.
   * `ngspice`: the circuit solver's path (default $SHIBO_NGSPICE, else ngspice on the PATH); without it parts show unchecked.
   */
  constructor(opts: { build?: Build; watch?: boolean; ngspice?: string | null; home?: string } = {}) {
    this.home = opts.home;
    this.build = opts.build ?? ((d, b) => buildSketch(d, b)); this.watching = opts.watch ?? false; this.ngspice = opts.ngspice;
  }

  onMessage(cb: (m: OutMsg) => void): void { this.listeners.push(cb); }
  private send(m: OutMsg): void { if (!this.disposed) for (const cb of this.listeners) cb(m); }

  async handle(m: InMsg): Promise<void> {
    if (this.disposed) return;
    try {
      switch (m.t) {
        case 'hello': this.hello(); break;
        case 'open': this.open(m.dir); break;
        case 'edit': this.edit(m.op, m.args); break;
        case 'save': this.save(); break;
        case 'undo': this.step(this.past, this.future); break;
        case 'redo': this.step(this.future, this.past); break;
        case 'createSketch': this.createSketch(); break;
        case 'template': this.useTemplate(m.id); break;
        case 'guide': this.writeGuide(); break;
        case 'start': await this.start(); break;
        case 'stop': this.stop(); break;
        case 'prices': this.send({ t: 'prices', book: loadPrices(this.dir), file: path.join(this.dir, PRICES_FILE) }); break;
        case 'setPrice': this.send({ t: 'prices', book: savePrice(this.dir, m.key, m.entry, m.currency), file: path.join(this.dir, PRICES_FILE) }); break;
        case 'exportBom': this.send({ t: 'bomExported', path: exportBom(this.dir, this.project, m.format === 'md' ? 'md' : 'csv') }); break;
        case 'control': this.run?.circuit.setControl(String(m.part), String(m.name), Number(m.value)); break;
        case 'shareInfo': this.send({ t: 'shareInfo', project: this.project, sketch: this.sketchText() }); break;
        case 'openShared': this.openShared(m.project, m.sketch, m.embed === true); break;
        case 'serial': {
          if (typeof m.text !== 'string') throw new Error('serial text must be text');
          const bytes = new TextEncoder().encode(m.text);
          if (bytes.length > MAX_SERIAL) throw new Error(`that is too long to send at once (${bytes.length} bytes; the limit is ${MAX_SERIAL})`);
          if (m.part) this.run?.circuit.sendText(String(m.part), m.text);
          else if (this.run) for (const b of bytes) this.run.chip.serialWrite(b);
          break;
        }
        default:
          if (INSTRUMENT_MESSAGES.has(m.t)) { this.run?.inst.handle(m as InstrumentIn); break; }
          throw new Error(`unknown message ${(m as { t: string }).t}`);
      }
    } catch (err) { this.send({ t: 'error', message: (err as Error).message }); }
  }

  /** Send everything a page needs to draw itself (used when a page connects). */
  hello(): void {
    this.sendProject(); this.sendStatus();
    if (this.run) { this.send({ t: 'outputs', outputs: this.run.circuit.display() }); this.run.inst.hello(); }
    const r = this.run?.electrical.report();
    if (r) this.sendElectrical(r);
  }

  private sendElectrical(r: Report): void { this.send({ t: 'electrical', state: r.state, ...(r.reason ? { reason: r.reason } : {}), wires: r.wires, parts: r.parts }); }

  private open(dir: string): void {
    this.stop();
    const own = path.join(dir, FILE), wokwi = path.join(dir, 'diagram.json');
    this.dir = dir; this.dirty = false; this.loadError = ''; this.past = []; this.future = [];
    this.watch();
    this.project = { version: 1, parts: [], wires: [], boards: [] };
    const source = fs.existsSync(own) ? own : fs.existsSync(wokwi) ? wokwi : '';
    try {
      if (source === own) this.project = parseProject(JSON.parse(fs.readFileSync(own, 'utf8')), FILE);
      else if (source === wokwi) this.project = importWokwi(JSON.parse(fs.readFileSync(wokwi, 'utf8'))).project;
    } catch (err) {
      // Keep saying so: an empty canvas with no explanation would invite overwriting the file.
      this.loadError = `${path.basename(source)} could not be read, so nothing is shown and nothing will be saved over it: ${(err as Error).message}`;
    }
    this.sendProject(); this.sendStatus();
  }

  private unmapped(): string[] {
    return this.project.parts.filter((p) => p.type.startsWith('unknown:')).map((p) => `${p.id} (${p.type.slice(8)})`);
  }

  private sendProject(): void {
    this.send({ t: 'project', project: this.project, catalog: edit.catalog, dirty: this.dirty, unmapped: this.unmapped(), dir: this.dir,
      canUndo: this.past.length > 0, canRedo: this.future.length > 0, sketch: this.sketchFile(),
      templates: templates.map(({ id, label, detail }) => ({ id, label, detail })) });
    this.send({ t: 'problems', items: this.problems() });
  }

  private problems(): string[] {
    const items = this.loadError ? [this.loadError] : [];
    items.push(...validate(this.project), ...scriptProblems(this.project), ...(this.run?.inst.problems() ?? []));
    for (const b of this.project.boards.slice(1)) items.push(`${b.part} will not run: only one board runs at a time so far, and ${this.project.boards[0].part} is the one`);
    for (const u of this.unmapped()) items.push(`${u} has no model yet: it is drawn but does nothing`);
    for (const [id, o] of Object.entries(this.run?.circuit.outputs() ?? {})) {
      if (o.powered === false) items.push(`${id} has no power: wire its supply pin to 5V and its GND pin to GND`);
    }
    items.push(...(this.run ? [...this.run.circuit.warnings(), ...this.run.electrical.warnings()] : this.lastWarnings));
    for (const n of this.run?.circuit.contended() ?? []) items.push(`Short circuit at ${n}: two outputs are driving the same wire to different levels`);
    return items;
  }

  private sendStatus(state?: 'building'): void {
    this.send({ t: 'status', state: state ?? (this.run ? 'running' : 'idle'), timeMs: this.run ? this.run.engine.now / MS : 0 });
  }

  private edit(op: string, args: unknown[]): void {
    const fn = typeof op === 'string' ? EDITS.get(op) : undefined;
    if (!fn) throw new Error(`unknown edit "${String(op)}"`);
    if (!Array.isArray(args)) throw new Error(`edit "${op}" needs a list of arguments`);
    if (this.loadError) throw new Error(this.loadError);
    const next = parseProject(fn(this.project, ...args), 'the edited project');
    this.stop();                       // never keep running a circuit that is being changed
    this.lastWarnings = [];
    this.past.push(this.project); if (this.past.length > 200) this.past.shift();
    this.future = [];
    this.project = next; this.dirty = true;
    this.sendProject();
  }

  private save(): void {
    if (!this.dir) throw new Error('no project folder is open');
    if (this.loadError) throw new Error(this.loadError);
    fs.writeFileSync(path.join(this.dir, FILE), JSON.stringify(this.project, null, 2) + '\n');
    this.dirty = false;
    this.send({ t: 'dirty', dirty: false });      // the circuit did not change, so the page must not redraw it
  }

  private async start(): Promise<void> {
    if (this.starting) return;
    this.stop();
    const bad = validate(this.project);
    if (bad.length) throw new Error(`fix the wiring first: ${bad[0]}`);
    const board = this.project.boards[0];
    if (!board) throw new Error('add a board to the circuit first');
    const type = this.project.parts.find((p) => p.id === board.part)!.type;
    if (!runnableBoards.includes(type)) throw new Error(`${board.part} cannot run yet: Shibo runs ${runnableBoards.join(', ')} boards so far`);
    if (this.loadError) throw new Error(this.loadError);
    this.lastWarnings = [];
    const project = this.project, id = ++this.startId;
    this.starting = true; this.sendStatus('building');
    try {
      const built = await this.build(this.dir, type);
      if (this.disposed) return;
      if (id !== this.startId || project !== this.project) return;        // stopped or edited while building
      if (!built.ok || !built.hex) throw new Error(built.log === NO_SKETCH ? NO_SKETCH : `the sketch did not build:\n${built.log}`);
      const engine = new Engine();
      const chip = createBackend(type, board.part, built.hex);
      engine.addBackend(chip);
      const circuit = new Circuit(engine, project, { [board.part]: chip });
      this.spice ??= new Spice(this.ngspice);
      const electrical = new Electrical({ spice: this.spice });
      const inst = new Instruments(engine, circuit, project, (m) => this.send(m), () => {
        if (this.run) this.run.serial = '';       // a replay while scrubbing prints what was already printed
        this.flush(); this.sendStatus();
      });
      const run: Run = { engine, chip, circuit, electrical, inst, serial: '', lastOutputs: '', lastProblems: '', lastStatusMs: 0 };
      chip.onSerial((b) => { run.serial += String.fromCharCode(b); });
      this.run = run;
      electrical.onReport((r) => { if (this.run === run) { this.sendElectrical(r); this.flush(); } });
    } finally {
      // Whatever happened, the page must not be left showing "building".
      this.starting = false;
      if (!this.disposed) this.sendStatus();
    }
    this.flush();
  }

  private stop(): void {
    this.startId++;
    if (!this.run) return;
    const timeMs = this.run.engine.now / MS;
    this.flush();
    this.lastWarnings = [...this.run.circuit.warnings(), ...this.run.electrical.warnings()];
    this.run.electrical.close();
    this.run = null;
    this.send({ t: 'status', state: 'idle', timeMs });
    this.send({ t: 'problems', items: this.problems() });
  }

  /** The host calls this with the wall time that passed; the engine decides what that means. */
  tick(wallMs: number): void {
    const run = this.run;
    if (!run || this.disposed || !(wallMs > 0) || run.inst.paused) return;
    try {
      run.engine.runUntil(run.engine.now + Math.round(Math.min(wallMs, MAX_STEP_MS) * MS));
    } catch (err) {
      this.stop();
      this.send({ t: 'error', message: `the simulation stopped: ${(err as Error).message}` });
      return;
    }
    run.engine.log.length = 0;         // the live view shows state, not the event log
    run.circuit.audit();
    run.inst.afterTick();
    this.flush();
    if (run.engine.now / MS - run.lastStatusMs >= 200) { run.lastStatusMs = run.engine.now / MS; this.sendStatus(); }
  }

  /** Send what changed since the last tick: at most one message of each kind. */
  private flush(): void {
    const run = this.run;
    if (!run) return;
    if (run.serial) { this.send({ t: 'serial', text: run.serial }); run.serial = ''; }
    run.electrical.update(run.circuit.picture());           // solved in the background; the answer comes back as its own message
    const outputs = run.circuit.display(), key = JSON.stringify(outputs);
    if (key !== run.lastOutputs) { run.lastOutputs = key; this.send({ t: 'outputs', outputs }); }
    const problems = this.problems(), pkey = problems.join('\n');
    if (pkey !== run.lastProblems) { run.lastProblems = pkey; this.send({ t: 'problems', items: problems }); }
  }

  /** Move one step between the undo and redo stacks. Nothing to step to is not an error. */
  private step(from: Project[], to: Project[]): void {
    const next = from.pop();
    if (!next) return;
    this.stop();
    to.push(this.project);
    this.project = next; this.dirty = true;
    this.sendProject();
  }

  /** Replace the circuit with a starter one, and add its sketch if the folder has none. */
  private useTemplate(id: string): void {
    const t = templates.find((x) => x.id === id);
    if (!t) throw new Error(`there is no template "${String(id)}"`);
    if (!this.dir) throw new Error('no project folder is open');
    if (this.loadError) throw new Error(this.loadError);
    if (!this.sketchFile()) this.newSketch();
    this.stop();
    this.past.push(this.project); this.future = [];
    this.project = parseProject(structuredClone(t.project), 'the template'); this.dirty = true;
    let made = '';
    if (!this.sketchFile()) {
      made = this.newSketch();
      fs.writeFileSync(made, t.sketch, { flag: 'wx' });
    }
    this.sendProject();
    if (made) this.send({ t: 'sketchCreated', path: made });
  }

  private writeGuide(): void {
    if (!this.dir) throw new Error('no project folder is open');
    const file = path.join(this.dir, 'wiring-guide.html');
    fs.writeFileSync(file, generateGuide(this.project, path.basename(this.dir)));
    this.send({ t: 'guideCreated', path: file });
  }

  /** The sketch that Run uploads: the first .ino in the folder, by name. */
  /** Where a new sketch goes. Refuses a folder shared with other things. */
  private newSketch(): string {
    if (sharedFolder(this.dir, this.home)) throw new Error(OWN_FOLDER);
    return path.join(this.dir, `${path.basename(this.dir).replace(/[^\w-]+/g, '-') || 'sketch'}.ino`);
  }

  private sketchFile(): string | null {
    try { return this.dir ? fs.readdirSync(this.dir).filter((f) => f.endsWith('.ino')).sort()[0] ?? null : null; } catch { return null; }
  }

  private sketchText(): string | null {
    const f = this.sketchFile();
    try { return f ? fs.readFileSync(path.join(this.dir, f), 'utf8') : null; } catch { return null; }
  }

  /**
   * Load a project from a share link. The circuit replaces this one as an
   * edit (Undo brings the old one back; nothing is saved). A different sketch
   * is written over the folder's only after the old one is copied into
   * .shibo-backup. An embed never touches unsaved work or a different sketch.
   */
  private openShared(raw: unknown, sketch: unknown, embed: boolean): void {
    const refuse = (message: string) => this.send({ t: 'shared', ok: false, message });
    if (!this.dir) return refuse('no project folder is open');
    if (this.loadError) return refuse(this.loadError);
    let next: Project;
    try { next = parseProject(raw, 'the link'); } catch (err) { return refuse((err as Error).message); }
    if (sketch != null && (typeof sketch !== 'string' || sketch.length > MAX_SKETCH)) return refuse('the sketch in the link is not usable');
    const file = this.sketchFile(), old = this.sketchText();
    if (typeof sketch === 'string' && !file && sharedFolder(this.dir, this.home)) return refuse(OWN_FOLDER);
    const replaces = typeof sketch === 'string' && old !== null && old !== sketch && old.trim() !== '';
    if (embed && (this.dirty || replaces)) return refuse('this Shibo has other work open, so the embed will not replace it. Use "Open in Shibo" to load the circuit.');
    this.stop();
    this.lastWarnings = [];
    this.past.push(this.project); if (this.past.length > 200) this.past.shift();
    this.future = [];
    this.project = next; this.dirty = true;
    let note = 'Opened the shared circuit. Undo brings back what was here; Save keeps the new one.';
    if (typeof sketch === 'string' && old !== sketch) {
      if (replaces) {
        const backup = path.join(this.dir, '.shibo-backup');
        fs.mkdirSync(backup, { recursive: true });
        const kept = path.join(backup, `${new Date().toISOString().replace(/[:.]/g, '-')}-${file}`);
        fs.copyFileSync(path.join(this.dir, file!), kept);
        note += ` Your old sketch was kept as .shibo-backup/${path.basename(kept)}.`;
      }
      const target = file ?? path.basename(this.newSketch());
      fs.writeFileSync(path.join(this.dir, target), sketch);
    }
    this.sendProject();
    this.send({ t: 'shared', ok: true, message: note });
  }

  private createSketch(): void {
    if (!this.dir) throw new Error('no project folder is open');
    const existing = this.sketchFile();
    if (existing) throw new Error(`${existing} is already here; it was left as it is`);
    const file = this.newSketch();
    fs.writeFileSync(file, generateSketch(this.project), { flag: 'wx' });      // wx: never over an existing file
    this.sendProject();
    this.send({ t: 'sketchCreated', path: file });
  }

  private watch(): void {
    this.watcher?.close(); this.watcher = null;
    if (!this.watching || !this.dir) return;
    let sketch = this.sketchFile();
    try {
      this.watcher = fs.watch(this.dir, (_event, name) => {
        if (!name || !/\.(ino|h|hpp|c|cpp)$/.test(String(name))) return;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        // Editors write a file in several steps; wait for them to finish.
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          if (this.disposed) return;
          if (this.run) void this.handle({ t: 'start' });
          else if (this.sketchFile() !== sketch) { sketch = this.sketchFile(); this.sendProject(); }
        }, 300);
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch { /* a folder that cannot be watched still works; it just will not re-upload on save */ }
  }

  dispose(): void {
    this.run?.electrical.close();
    this.run = null; this.disposed = true; this.listeners = [];
    this.spice?.close(); this.spice = null;
    this.watcher?.close(); this.watcher = null;
    if (this.saveTimer) clearTimeout(this.saveTimer);
  }
}
