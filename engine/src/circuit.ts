import type { Engine } from './engine.ts';
import type { ChipBackend, I2CHandler, Stateful } from './types.ts';
import { resolve, type Link, type Drive } from './nets.ts';
import { library } from './parts/index.ts';
import type { Device, OutputValue, PartCtx, PartDef } from './part.ts';
import { boardPins, canonicalPin, isBoard, type Project } from './project.ts';

export type Outputs = Record<string, Record<string, OutputValue>>;
interface CircuitState { parts: string; controls: Record<string, Record<string, number>>; outputs: Outputs; contended: string[]; devices: Record<string, unknown>; seen: string[] }

const POWER = /^(GND|5V|3\.3V|VIN|AREF|IOREF|RESET)$/;
const SETTLE_NS = 50e6;           // give setup() time to run before judging pin modes
const CONTENDED = (node: string) => `contended ${node}: two outputs are driving this net to different levels`;
const same = (a: OutputValue | undefined, b: OutputValue) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);

/** The wiring between boards and parts. Re-resolved whenever anything changes. */
export class Circuit implements Stateful {
  private engine: Engine;
  private project: Project;
  private backends: Record<string, ChipBackend>;
  private lib: Record<string, PartDef>;
  private controls: Record<string, Record<string, number>> = {};
  private devices: Record<string, Device> = {};
  private types: Map<string, string>;
  private nets = resolve([], []);
  private last: Outputs = {};
  private lastContended: string[] = [];
  private seen: string[] = [];        // wiring mistakes noticed so far in this run; they stay listed
  private busy = false;
  private again = false;

  constructor(engine: Engine, project: Project, backends: Record<string, ChipBackend>, lib: Record<string, PartDef> = library) {
    this.engine = engine; this.project = project; this.backends = backends; this.lib = lib;
    this.types = new Map(project.parts.map((p) => [p.id, p.type]));
    for (const p of project.parts) {
      const def = this.def(p.type);
      if (def?.controls) this.controls[p.id] = Object.fromEntries(Object.entries(def.controls).map(([k, c]) => [k, c.initial]));
      if (def?.device) this.devices[p.id] = def.device(this.ctx(p.id, p.attrs ?? {}));
    }
    for (const b of Object.values(backends)) {
      // While a board calls back it is ahead of the engine; its clock is the exact time.
      b.onChange(() => this.during(b, () => this.update(true)));
      b.onI2C?.(this.i2cFor(b));
      b.onSPI?.((byte) => this.during(b, () => this.spiTransfer(b, byte)));
    }
    engine.addStateful(this);
    this.update(false);
    // A short that is there from the start must not pass silently.
    for (const n of this.lastContended) this.engine.record(CONTENDED(n));
  }

  /** A part definition by type, ignoring names an object has by inheritance. */
  private def(type: string): PartDef | undefined { return Object.hasOwn(this.lib, type) ? this.lib[type] : undefined; }

  private during<T>(b: ChipBackend, fn: () => T): T {
    const before = this.engine.timeSource;
    if (b.nowNs) this.engine.timeSource = () => b.nowNs!();
    try { return fn(); } finally { this.engine.timeSource = before; }
  }

  private ctx(id: string, attrs: Record<string, string>): PartCtx {
    const pins = new Map<string, string>();
    return {
      id, attrs,
      level: (pin) => { let n = pins.get(pin); if (n === undefined) pins.set(pin, n = this.node(`${id}:${pin}`)); return this.nets.level(n); },
      control: (name) => this.controls[id]?.[name] ?? 0,
      now: () => this.engine.time(),
      after: (dt, fn) => this.engine.at(this.engine.time() + Math.max(0, Math.round(dt)), fn),
      changed: () => this.update(true),
    };
  }

  /** Throw unless this part has this control and the value is one it can take. */
  checkControl(partId: string, name: string, value: number): void {
    const controls = this.def(this.types.get(partId) ?? '')?.controls;
    const def = controls && Object.hasOwn(controls, name) ? controls[name] : undefined;
    if (!def) throw new Error(`part "${partId}" has no control "${name}"`);
    if (!Number.isFinite(value)) throw new Error(`${partId}.${name}: "${value}" is not a number`);
    const min = def.kind === 'range' ? def.min ?? 0 : 0, max = def.kind === 'range' ? def.max ?? 1 : 1;
    if (value < min || value > max) throw new Error(`${partId}.${name}: ${value} is outside its range ${min} to ${max}`);
  }

  setControl(partId: string, name: string, value: number): void {
    this.checkControl(partId, name, value);
    this.controls[partId][name] = value;
    this.update(true);
  }

  outputs(): Outputs { return this.last; }
  contended(): string[] { return this.lastContended; }

  /** Wiring mistakes noticed so far, as sentences. */
  warnings(): string[] { return this.seen; }
  private warn(text: string): void { if (!this.seen.includes(text)) this.seen.push(text); }

  /** The board signal pin on the same net as a node, if there is one. */
  private boardPin(node: string): string | null {
    const net = this.nets.net(this.node(node));
    for (const p of this.project.parts) {
      if (!isBoard(p.type) || !this.backends[p.id]) continue;
      for (const pin of boardPins[p.type]) if (!POWER.test(pin) && this.nets.net(`${p.id}:${pin}`) === net) return `${p.id} pin ${pin}`;
    }
    return null;
  }

  private checkParts(): void {
    const see = { level: (n: string) => this.nets.level(this.node(n)), strong: (n: string) => this.nets.strong(this.node(n)), boardPin: (n: string) => this.boardPin(n) };
    for (const p of this.project.parts) for (const w of this.def(p.type)?.check?.(p.id, see, this.controls[p.id] ?? {}) ?? []) this.warn(w);
  }

  /**
   * Checks that only make sense once the sketch has set its pins up. Call it
   * now and then while running.
   */
  audit(): void {
    if (this.engine.time() < SETTLE_NS) return;
    for (const b of Object.values(this.backends)) for (const pin of b.inputPins?.() ?? []) {
      const node = `${b.id}:${pin}`;
      if (this.nets.level(node) !== null) continue;
      const net = this.nets.net(node);
      const sw = this.project.parts.find((p) => { const d = this.def(p.type); return d?.contact && d.pins.some((x) => this.nets.net(`${p.id}:${x}`) === net); });
      if (sw) this.warn(`${b.id} pin ${pin} is floating while ${sw.id} is open: nothing holds it high or low, so it reads at random. Use pinMode(${pin}, INPUT_PULLUP), or add a pull resistor.`);
    }
  }

  /** What the page should draw: outputs, with each device's time-averaged view where it has one. */
  display(): Outputs {
    const out: Outputs = { ...this.last };
    for (const [id, d] of Object.entries(this.devices)) if (d.display) out[id] = d.display();
    return out;
  }

  // ---- buses ----
  private onBus(b: ChipBackend, mine: string, theirs: string, partId: string): boolean {
    return this.nets.net(this.node(`${b.id}:${mine}`)) === this.nets.net(this.node(`${partId}:${theirs}`));
  }

  private i2cFor(b: ChipBackend): I2CHandler {
    let active: NonNullable<Device['i2c']> | null = null;
    return {
      connect: (address, write) => this.during(b, () => {
        active = null;
        const pins = b.i2cPins;
        if (!pins) return false;
        for (const [id, d] of Object.entries(this.devices)) {
          if (d.i2c && d.i2c.address() === address && this.onBus(b, pins.sda, d.i2c.sda, id) && this.onBus(b, pins.scl, d.i2c.scl, id)) { active = d.i2c; break; }
        }
        active?.start?.(write);
        return active !== null;
      }),
      write: (byte) => this.during(b, () => { const ok = active ? active.write(byte) : false; this.update(true); return ok; }),
      read: (ack) => this.during(b, () => (active ? active.read(ack) : 0xff)),
      stop: () => this.during(b, () => { active?.stop?.(); active = null; this.update(true); }),
    };
  }

  private spiTransfer(b: ChipBackend, byte: number): number {
    const pins = b.spiPins;
    let reply = 0xff;
    this.spiParts ??= Object.entries(this.devices).filter(([, d]) => d.spi);
    if (pins) for (const [id, d] of this.spiParts) {
      if (!d.spi || this.nets.level(this.node(`${id}:${d.spi.cs}`)) !== 0) continue;
      if (d.spi.sck && !this.onBus(b, pins.sck, d.spi.sck, id)) continue;
      reply = d.spi.transfer(byte) & 0xff;
    }
    // A screen takes thousands of bytes a frame: a part whose pins change because of a byte says so itself.
    return reply;
  }

  // ---- resolving ----
  /** Resolve the nets, feed the boards and parts, and note what changed. */
  private update(log: boolean): void {
    // Feeding a board or part can make it report a change; fold that into another pass.
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      let passes = 0;
      do {
        this.again = false;
        if (++passes > 50) throw new Error('the circuit does not settle: a part and a pin keep changing each other');
        const g = this.gather();
        const links: Link[] = [...this.project.wires.map((w) => ({ a: this.node(w.from), b: this.node(w.to), kind: 'wire' as const })), ...g.links];
        const drives: Drive[] = [...g.drives];
        const driven = new Set<string>();
        for (const [id, b] of Object.entries(this.backends)) for (const d of b.drives()) {
          drives.push({ node: `${id}:${d.pin}`, level: d.level, pull: d.pull });
          if (d.level !== null) driven.add(`${id}:${d.pin}`);
        }
        const nets = this.nets = resolve(links, drives);

        for (const p of this.project.parts) {
          const b = this.backends[p.id], pins = isBoard(p.type) ? boardPins[p.type] : undefined;
          if (!b || !pins) continue;
          for (const pin of pins) if (!driven.has(`${p.id}:${pin}`)) b.setInput(pin, nets.level(`${p.id}:${pin}`));
        }
        // What parts connect and drive can depend on levels (is it powered? is the coil on?).
        // If resolving changed that, resolve again with the new picture.
        if (this.gather().key !== g.key) { this.again = true; continue; }
        // An analog input on a net held high or low with no analog source reads the rail.
        const sourced = new Set(g.analog.map((a) => nets.net(this.node(a.node))));
        for (const p of this.project.parts) {
          const b = this.backends[p.id];
          if (b && isBoard(p.type)) for (const pin of boardPins[p.type]) {
            const node = `${p.id}:${pin}`, l = nets.level(node);
            if (/^A\d$/.test(pin) && l !== null && !sourced.has(nets.net(node))) b.setAnalog(pin, l * 5);
          }
        }
        for (const a of g.analog) {
          const net = nets.net(this.node(a.node));
          for (const q of this.project.parts) {
            const b = this.backends[q.id];
            if (b) for (const pin of isBoard(q.type) ? boardPins[q.type] : []) if (nets.net(`${q.id}:${pin}`) === net) b.setAnalog(pin, a.volts);
          }
        }
        for (const dev of Object.values(this.devices)) dev.onChange?.();
        if (this.again) continue;

        const out: Outputs = {};
        for (const p of this.project.parts) {
          const def = this.def(p.type), dev = this.devices[p.id];
          if (dev?.outputs) out[p.id] = dev.outputs();
          else if (def?.outputs) out[p.id] = def.outputs(p.id, (n) => nets.level(this.node(n)), this.controls[p.id] ?? {});
        }
        if (log) {
          for (const [id, o] of Object.entries(out)) for (const [k, v] of Object.entries(o)) {
            if (!same(this.last[id]?.[k], v)) this.engine.record(`out ${id}.${k}=${Array.isArray(v) ? JSON.stringify(v) : v}`);
          }
          for (const n of nets.contended) if (!this.lastContended.includes(n)) this.engine.record(CONTENDED(n));
        }
        this.last = out; this.lastContended = nets.contended;
        this.checkParts();
      } while (this.again);
    } finally { this.busy = false; }
  }

  /** Everything the parts contribute, as they stand with the levels last resolved. */
  private gather(): { links: Link[]; drives: Drive[]; analog: { node: string; volts: number }[]; key: string } {
    const links: Link[] = [], drives: Drive[] = [], analog: { node: string; volts: number }[] = [];
    const level = (n: string) => this.nets.level(this.node(n));
    for (const p of this.project.parts) {
      const def = this.def(p.type), dev = this.devices[p.id], state = this.controls[p.id] ?? {};
      if (dev?.links) links.push(...dev.links()); else if (def?.links) links.push(...def.links(p.id, state, level));
      for (const d of dev?.drives?.() ?? def?.drives?.(p.id, state, level) ?? []) drives.push({ node: `${p.id}:${d.pin}`, level: d.level, pull: d.pull });
      if (dev?.analog) for (const a of dev.analog()) analog.push({ node: `${p.id}:${a.pin}`, volts: a.volts });
      else for (const a of def?.analog?.(p.id, state, level) ?? []) analog.push(a);
    }
    return { links, drives, analog, key: JSON.stringify([links, drives, analog]) };
  }

  /** A wire end as a net node: numbered copies of a board pin become the one pin. */
  private node(ref: string): string {
    // Asked for on every pin read; the answer never changes for one circuit.
    let n = this.nodes.get(ref);
    if (n !== undefined) return n;
    const i = ref.indexOf(':'); const id = ref.slice(0, i);
    const type = this.types.get(id);
    const pin = type ? canonicalPin(type, ref.slice(i + 1)) : null;
    n = pin === null ? ref : `${id}:${pin}`;
    this.nodes.set(ref, n);
    return n;
  }
  private nodes = new Map<string, string>();
  private spiParts: [string, Device][] | null = null;

  private partsKey(): string { return this.project.parts.map((p) => `${p.id}:${p.type}`).sort().join(','); }

  saveState(): unknown {
    const s: CircuitState = {
      parts: this.partsKey(), controls: structuredClone(this.controls), outputs: structuredClone(this.last), contended: [...this.lastContended],
      devices: Object.fromEntries(Object.entries(this.devices).map(([id, d]) => [id, structuredClone(d.save())])), seen: [...this.seen],
    };
    return s;
  }

  checkState(state: unknown): void {
    const s = state as CircuitState;
    if (!s || s.parts !== this.partsKey()) throw new Error('snapshot was taken from a different project and cannot be restored here');
  }

  restoreState(state: unknown): void {
    this.checkState(state);
    const s = state as CircuitState;
    this.controls = structuredClone(s.controls); this.last = structuredClone(s.outputs); this.lastContended = [...s.contended]; this.seen = [...(s.seen ?? [])];
    for (const [id, d] of Object.entries(this.devices)) d.restore(structuredClone(s.devices[id]));
    this.update(false);
  }
}
