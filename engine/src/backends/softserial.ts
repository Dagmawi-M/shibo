// Serial for chips with no USART, such as the ATtiny85. ATTinyCore's Serial
// is software: it bit-bangs TX on AIN0 and catches the start bit of RX with
// the analog comparator (bandgap against AIN1). avr8js has no comparator, so
// this provides one, decodes the TX pin into bytes, and plays bytes into the
// RX pin bit by bit at the baud rate the sketch is sending at.
import type { CPU, AVRIOPort } from 'avr8js';

/** The analog comparator, enough for a software UART: ACSR, ACO, ACI, ACIE and the edge modes. */
export interface ComparatorConfig { ACSR: number; vector: number; PIN: number; ain0Bit: number; ain1Bit: number }

const ACD = 0x80, ACBG = 0x40, ACO = 0x20, ACI = 0x10, ACIE = 0x08, ACIS = 0x03;
const BANDGAP = 1.1, VCC = 5;
/** Bauds a sketch is likely to use; a measured bit time is snapped to the nearest within 6%. */
const BAUDS = [300, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 76800, 115200, 230400];

export class SoftSerial {
  private cpu: CPU;
  private cfg: ComparatorConfig;
  private freq: number;
  private int: { address: number; flagRegister: number; flagMask: number; enableRegister: number; enableMask: number };
  /** Plain data, so the backend's snapshots carry it. */
  readonly state = {
    tx: { level: 1, edges: [] as number[], start: -1 },   // falling/rising edge cycles of the burst being received
    bitCycles: 0,                                          // the sketch's bit time, once it has sent something
    rx: { line: 1, ext: 1 as 0 | 1, queue: [] as [number, 0 | 1][] },   // RX transitions due, by cycle
  };
  private emit: (byte: number) => void;

  constructor(cpu: CPU, port: AVRIOPort, cfg: ComparatorConfig, freq: number, emit: (byte: number) => void) {
    this.cpu = cpu; this.cfg = cfg; this.freq = freq; this.emit = emit;
    this.int = { address: cfg.vector, flagRegister: cfg.ACSR, flagMask: ACI, enableRegister: cfg.ACSR, enableMask: ACIE };
    cpu.writeHooks[cfg.ACSR] = (value) => {
      const old = cpu.data[cfg.ACSR];
      // ACO is read-only; writing 1 to ACI clears it.
      cpu.data[cfg.ACSR] = (value & ~(ACO | ACI)) | (old & ACO) | (old & ACI);
      cpu.clearInterruptByFlag(this.int, value);
      cpu.updateInterruptEnable(this.int, value);
      this.compare();
      return true;
    };
    port.addListener(() => { this.watchTx(); this.compare(); });
  }

  /** Recompute the comparator output from the pins, raising ACI on the chosen edge. */
  compare(): void {
    const { cpu, cfg } = this, acsr = cpu.data[cfg.ACSR];
    if (acsr & ACD) return;
    const pin = (bit: number) => ((cpu.data[cfg.PIN] >> bit) & 1 ? VCC : 0);
    const plus = acsr & ACBG ? BANDGAP : pin(cfg.ain0Bit);
    const out = plus > pin(cfg.ain1Bit) ? ACO : 0;
    if (out === (acsr & ACO)) return;
    cpu.data[cfg.ACSR] = (acsr & ~ACO) | out;
    const mode = acsr & ACIS;               // 00 toggle, 10 falling, 11 rising
    if (mode === 0 || (mode === 2 && !out) || (mode === 3 && out)) cpu.setInterruptFlag(this.int);
  }

  /** Software serial is on once the sketch turns on the bandgap reference (Serial.begin). */
  private get on(): boolean { return (this.cpu.data[this.cfg.ACSR] & ACBG) !== 0; }

  private watchTx(): void {
    const { cpu, cfg } = this, tx = this.state.tx;
    const ddr = cpu.data[cfg.PIN + 1], portv = cpu.data[cfg.PIN + 2];
    const level = (ddr >> cfg.ain0Bit) & 1 ? (portv >> cfg.ain0Bit) & 1 : 1;
    if (level === tx.level) return;
    tx.level = level;
    if (!this.on) return;
    tx.edges.push(cpu.cycles);
  }

  /** Decode the TX edges seen so far, keeping any frame not yet complete. Called as time passes. */
  flush(): void {
    const tx = this.state.tx, e = tx.edges;
    if (!e.length) return;
    // Pulses far shorter than any baud's bit are not data (Serial.begin turning the pin round).
    this.deglitch(this.freq / 300000);
    let min = Infinity;
    for (let i = 1; i < e.length; i++) min = Math.min(min, e[i] - e[i - 1]);
    if (Number.isFinite(min)) this.state.bitCycles = this.snap(min, this.state.bitCycles, e);
    const bit = this.state.bitCycles;
    if (!bit) return;
    this.deglitch(bit / 2);
    // e[0] is a falling edge, so the line is low after even-numbered edges.
    const levelAt = (c: number) => {
      let n = 0; while (n < e.length && e[n] <= c) n++;
      return n === 0 ? 1 : (n % 2 === 1 ? 0 : 1);
    };
    // Decode every frame that is complete by now; keep the rest for later.
    while (e.length && e[0] + bit * 10 <= this.cpu.cycles) {
      const start = e[0];
      let byte = 0;
      for (let b = 0; b < 8; b++) byte |= levelAt(start + bit * (1.5 + b)) << b;
      if (levelAt(start + bit * 9.5) === 1) this.emit(byte);
      // The next start bit is the first falling edge after this frame's stop bit began.
      let i = 1;
      while (i < e.length && (e[i] <= start + bit * 9.5 || i % 2 === 1)) i++;
      e.splice(0, i);
    }
  }

  /** Drop pulses shorter than `cycles`: both edges go, so the line levels around them still alternate. */
  private deglitch(cycles: number): void {
    const e = this.state.tx.edges;
    for (let i = 0; i + 1 < e.length;) {
      if (e[i + 1] - e[i] < cycles) e.splice(i, 2); else i++;
    }
  }

  /**
   * The bit time, from the shortest gap between edges. That gap can span several bits ("0" is
   * 0x30: its shortest run is two bits), so of the bauds within reach, the slowest whose bit time
   * puts every edge of the first frame on a whole bit is taken.
   */
  private snap(cycles: number, known: number, e: number[]): number {
    if (known && cycles >= known * 0.9) return known;
    const fits = (bit: number) => {
      for (let i = 1; i < e.length && e[i] - e[0] < bit * 9.75; i++) {
        const k = (e[i] - e[0]) / bit;
        if (Math.abs(k - Math.round(k)) > 0.25) return false;
      }
      return true;
    };
    for (const baud of BAUDS) {                 // slowest first: the longest bit time that fits
      const bit = this.freq / baud;
      if (bit > cycles * 1.06 || (known && bit >= known * 0.9)) continue;
      // The gap must be a whole number of these bits, and so must every edge of the frame.
      const k = Math.round(cycles / bit);
      if (k < 1 || Math.abs(cycles / bit - k) > 0.06 * k) continue;
      if (this.cpu.cycles < e[0] + bit * 10) return known;      // its frame is not all here yet: wait for it
      if (!fits(bit)) continue;
      return Math.round(bit);
    }
    return known;
  }

  /** Queue a byte for RX: start bit, 8 data bits LSB first, stop bit. */
  write(byte: number): void {
    if (!this.on) return;                       // as on real hardware, nobody is listening
    const bit = this.state.bitCycles || Math.round(this.freq / 9600);
    const q = this.state.rx.queue;
    let t = Math.max(this.cpu.cycles, q.length ? q[q.length - 1][0] : 0) + 1;
    const bits = [0, ...Array.from({ length: 8 }, (_, i) => (byte >> i) & 1), 1] as (0 | 1)[];
    bits.forEach((b, i) => q.push([t + i * bit, b]));
    q.push([t + 10 * bit, 1]);
  }

  /** The next cycle an RX transition is due, or Infinity. */
  nextAt(): number { const q = this.state.rx.queue; return q.length ? q[0][0] : Infinity; }

  /** Apply RX transitions that are due; returns the line level the RX pin should now show. */
  due(): 0 | 1 | null {
    const q = this.state.rx.queue, rx = this.state.rx;
    let changed = false;
    while (q.length && q[0][0] <= this.cpu.cycles) { rx.line = q.shift()![1]; changed = true; }
    return changed ? (rx.ext && rx.line ? 1 : 0) : null;
  }

  /** The level the circuit puts on the RX pin; the injected line can only pull it low. */
  external(level: 0 | 1): 0 | 1 { this.state.rx.ext = level; return level && this.state.rx.line ? 1 : 0; }
}
