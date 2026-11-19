import {
  CPU, avrInstruction, ATtinyTimer1, attinyTimer1Config, ADCReference, AVRIOPort, PinState, AVRTimer, AVRUSART, AVRADC, AVRTWI, AVRSPI,
  portAConfig, portBConfig, portCConfig, portDConfig, portEConfig, portFConfig, portGConfig,
  portHConfig, portJConfig, portKConfig, portLConfig,
  timer0Config, timer1Config, timer2Config, usart0Config, adcConfig, twiConfig, spiConfig, ADCMuxInputType,
} from 'avr8js';
import type { ADCConfig, AVRPortConfig, AVRTimerConfig, SPIConfig, TWIConfig, USARTConfig } from 'avr8js';
import type { ChipBackend, I2CHandler, Level, Ns, PinDrive } from '../types.ts';
import { SoftSerial, type ComparatorConfig } from './softserial.ts';
import { captureGraph, restoreGraph } from '../graphstate.ts';

/** Everything that differs between one AVR board and another. */
export interface AvrChip {
  freq: number;
  flashBytes: number;
  /** avr8js's SRAM size: data space above the 256 register and I/O bytes. */
  sramBytes: number;
  ports: Record<string, AVRPortConfig>;
  /** Board pin name -> [port letter, bit]. */
  pins: Record<string, [string, number]>;
  /** Board pin name -> ADC channel, for pins that read voltages. Some (Nano A6, A7) are analog only. */
  analog: Record<string, number>;
  timers: AVRTimerConfig[];
  /** USART configs; the first is Serial, the one the serial monitor talks to. */
  usarts: USARTConfig[];
  adc: ADCConfig;
  twi?: TWIConfig;
  spi?: SPIConfig;
  i2cPins?: { sda: string; scl: string };
  spiPins?: { mosi: string; miso: string; sck: string };
  /** Supply pins, always driven. */
  power: PinDrive[];
  /** For chips with no USART: Serial is the core's software serial, with TX and RX on these pins of `port`. */
  softSerial?: ComparatorConfig & { port: string; tx: string; rx: string };
  /** Peripherals avr8js has for this chip only (ATtiny Timer1); returned objects join the snapshots. */
  extra?: (cpu: CPU) => unknown[];
}

/** Intel HEX text -> program memory. Handles extended segment (02) and linear (04) address records. */
export function parseHex(text: string, flashBytes = 0x8000): Uint16Array {
  const prog = new Uint8Array(flashBytes);
  let base = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line[0] !== ':') continue;
    const n = parseInt(line.substr(1, 2), 16), addr = parseInt(line.substr(3, 4), 16), type = line.substr(7, 2);
    const data = (i: number) => parseInt(line.substr(9 + i * 2, 2), 16);
    if (type === '02') base = ((data(0) << 8) | data(1)) << 4;
    else if (type === '04') base = ((data(0) << 8) | data(1)) << 16;
    else if (type === '00') {
      for (let i = 0; i < n; i++) {
        const at = base + addr + i;
        if (at >= flashBytes) throw new Error(`the program does not fit: it writes byte ${at.toString(16)} of a ${flashBytes / 1024} KB flash`);
        prog[at] = data(i);
      }
    }
  }
  return new Uint16Array(prog.buffer);
}

/** A board built on an AVR chip, running real firmware on avr8js. */
export class AvrBackend implements ChipBackend {
  readonly id: string;
  private chip: AvrChip;
  private cpu: CPU;
  private ports: Record<string, AVRIOPort>;
  private usarts: AVRUSART[];
  private adc: AVRADC;
  private stateRoots: unknown[];
  /** Bytes waiting to go into each USART: a serial line carries one byte at a time. */
  private rx: { queues: number[][] };
  private run = { end: 0 };              // the cycle this runUntil stops at; interrupt() pulls it in
  private i2c: I2CHandler | null = null;
  private spi: ((byte: number) => number) | null = null;
  readonly i2cPins?: { sda: string; scl: string };
  readonly spiPins?: { mosi: string; miso: string; sck: string };
  private changeCbs: (() => void)[] = [];
  private serialCbs: ((byte: number) => void)[][];
  private soft: SoftSerial | null = null;

  constructor(id: string, hex: string, chip: AvrChip) {
    this.id = id; this.chip = chip;
    this.i2cPins = chip.i2cPins; this.spiPins = chip.spiPins;
    this.cpu = new CPU(parseHex(hex, chip.flashBytes), chip.sramBytes);
    this.ports = Object.fromEntries(Object.entries(chip.ports).map(([k, c]) => [k, new AVRIOPort(this.cpu, c)]));
    const timers = chip.timers.map((c) => new AVRTimer(this.cpu, c));
    this.usarts = chip.usarts.map((c) => new AVRUSART(this.cpu, c, chip.freq));
    this.rx = { queues: chip.usarts.map(() => []) };
    this.serialCbs = Array.from({ length: Math.max(1, chip.usarts.length) }, () => []);
    this.adc = new AVRADC(this.cpu, chip.adc);
    // Listeners are attached before the roots are captured so they are part of
    // every snapshot; the callback lists they call live outside the graph.
    for (const p of Object.values(this.ports)) p.addListener(() => { for (const cb of this.changeCbs) cb(); });
    this.usarts.forEach((u, n) => {
      u.onByteTransmit = (b) => { for (const cb of this.serialCbs[n]) cb(b); };
      u.onRxComplete = () => this.pumpSerial(n);
    });
    const roots: unknown[] = [this.cpu, this.ports, timers, this.usarts, this.adc, this.rx, ...(chip.extra?.(this.cpu) ?? [])];
    if (chip.softSerial) {
      this.soft = new SoftSerial(this.cpu, this.ports[chip.softSerial.port], chip.softSerial, chip.freq, (b) => { for (const cb of this.serialCbs[0]) cb(b); });
      roots.push(this.soft.state);
    }
    // I2C and SPI are handled as whole bytes: the chip's own peripheral does the
    // clocking, and the wired device answers through the circuit.
    if (chip.twi) {
      const twi = new AVRTWI(this.cpu, chip.twi, chip.freq);
      twi.eventHandler = {
        start: () => twi.completeStart(),
        stop: () => { this.i2c?.stop(); twi.completeStop(); },
        connectToSlave: (addr, write) => twi.completeConnect(this.i2c ? this.i2c.connect(addr, write) : false),
        writeByte: (value) => twi.completeWrite(this.i2c ? this.i2c.write(value) : false),
        readByte: (ack) => twi.completeRead(this.i2c ? this.i2c.read(ack) : 0xff),
      };
      roots.push(twi);
    }
    if (chip.spi) {
      const spi = new AVRSPI(this.cpu, chip.spi, chip.freq);
      spi.onByte = (value) => {
        const reply = this.spi ? this.spi(value) : 0xff;
        this.cpu.addClockEvent(() => spi.completeTransfer(reply), spi.transferCycles);
      };
      roots.push(spi);
    }
    this.stateRoots = roots;
  }

  runUntil(t: Ns): void {
    const cpu = this.cpu, run = this.run;
    run.end = Math.round((t * this.chip.freq) / 1e9);
    const soft = this.soft;
    if (!soft) { while (cpu.cycles < run.end) { avrInstruction(cpu); cpu.tick(); } return; }
    while (cpu.cycles < run.end) {
      const stop = Math.min(run.end, soft.nextAt());
      while (cpu.cycles < stop) { avrInstruction(cpu); cpu.tick(); }
      const rx = soft.due();
      if (rx !== null) this.setPin(this.chip.softSerial!.rx, rx);
    }
    soft.flush();
  }

  private setPin(pin: string, level: 0 | 1): void {
    const [port, bit] = this.chip.pins[pin];
    this.ports[port].setPin(bit, level === 1);
    this.soft?.compare();
  }

  nowNs(): Ns { return (this.cpu.cycles * 1e9) / this.chip.freq; }
  interrupt(t: Ns): void { this.run.end = Math.min(this.run.end, Math.ceil((t * this.chip.freq) / 1e9)); }
  onI2C(handler: I2CHandler): void { this.i2c = handler; }
  onSPI(transfer: (byte: number) => number): void { this.spi = transfer; }

  drives(): PinDrive[] {
    const out: PinDrive[] = this.chip.power.map((d) => ({ ...d }));
    for (const [pin, [port, bit]] of Object.entries(this.chip.pins)) {
      const st = this.ports[port].pinState(bit);
      if (st === PinState.High) out.push({ pin, level: 1 });
      else if (st === PinState.Low) out.push({ pin, level: 0 });
      else if (st === PinState.InputPullUp) out.push({ pin, level: null, pull: 'up' });
    }
    return out;
  }

  inputPins(): string[] {
    return Object.entries(this.chip.pins).filter(([, [port, bit]]) => this.ports[port].pinState(bit) === PinState.Input).map(([pin]) => pin);
  }

  setInput(pin: string, level: Level): void {
    if (!Object.hasOwn(this.chip.pins, pin)) return;
    const l: 0 | 1 = level === 1 ? 1 : 0;
    this.setPin(pin, this.soft && pin === this.chip.softSerial!.rx ? this.soft.external(l) : l);
  }

  setAnalog(pin: string, volts: number): void {
    if (Object.hasOwn(this.chip.analog, pin)) this.adc.channelValues[this.chip.analog[pin]] = volts;
  }

  onChange(cb: () => void): void { this.changeCbs.push(cb); }
  /** Serial: what the serial monitor shows. */
  onSerial(cb: (byte: number) => void): void { this.onSerialPort(0, cb); }
  serialWrite(byte: number): void { this.serialPortWrite(0, byte); }

  /** How many hardware serial ports the chip has (Serial, Serial1, ...). */
  get serialPorts(): number { return this.serialCbs.length; }
  /** Bytes the sketch sends on Serial<n> (0 is Serial). */
  onSerialPort(n: number, cb: (byte: number) => void): void {
    if (!this.serialCbs[n]) throw new Error(`${this.id} has no Serial${n || ''}`);
    this.serialCbs[n].push(cb);
  }
  /** Send a byte to the sketch on Serial<n>. */
  serialPortWrite(n: number, byte: number): void {
    if (n === 0 && this.soft) { this.soft.write(byte); return; }
    const u = this.usarts[n];
    if (!u) throw new Error(`${this.id} has no Serial${n || ''}`);
    // As on real hardware, bytes sent while the receiver is off are lost.
    if (!u.rxEnable) return;
    this.rx.queues[n].push(byte);
    this.pumpSerial(n);
  }

  private pumpSerial(n: number): void {
    const u = this.usarts[n], q = this.rx.queues[n];
    if (q.length && !u.rxBusy && u.writeByte(q[0])) q.shift();
  }

  saveState(): unknown { return captureGraph(this.stateRoots); }
  restoreState(s: unknown): void { restoreGraph(s as ReturnType<typeof captureGraph>); }
}

const POWER_5V: PinDrive[] = [{ pin: '5V', level: 1 }, { pin: '3.3V', level: 1 }, { pin: 'GND', level: 0 }];

// ---- ATmega328P: Uno and Nano ----
const UNO_PINS: Record<string, [string, number]> = {};
for (let i = 0; i < 8; i++) UNO_PINS[String(i)] = ['D', i];
for (let i = 8; i < 14; i++) UNO_PINS[String(i)] = ['B', i - 8];
for (let i = 0; i < 6; i++) UNO_PINS['A' + i] = ['C', i];

export const UNO: AvrChip = {
  freq: 16e6, flashBytes: 0x8000, sramBytes: 8192,
  ports: { B: portBConfig, C: portCConfig, D: portDConfig },
  pins: UNO_PINS,
  analog: Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['A' + i, i])),
  timers: [timer0Config, timer1Config, timer2Config],
  usarts: [usart0Config], adc: adcConfig, twi: twiConfig, spi: spiConfig,
  i2cPins: { sda: 'A4', scl: 'A5' }, spiPins: { mosi: '11', miso: '12', sck: '13' },
  power: POWER_5V,
};

/** The Nano is the same chip; A6 and A7 are analog-only inputs with no port pin. */
export const NANO: AvrChip = { ...UNO, analog: { ...UNO.analog, A6: 6, A7: 7 } };

/** An Arduino Uno (ATmega328P at 16 MHz). */
export class UnoBackend extends AvrBackend {
  constructor(id: string, hex: string) { super(id, hex, UNO); }
}

// ---- ATmega2560: Mega ----
// Interrupt vectors are word addresses: vector n (avr-libc numbering) is at 2n.
const V = (n: number) => 2 * n;
const timerBitsC = { TOV: 1, OCFA: 2, OCFB: 4, OCFC: 8, TOIE: 1, OCIEA: 2, OCIEB: 4, OCIEC: 8 };

/** 16-bit timers 1, 3, 4 and 5 differ only in addresses, vectors and pins. */
function timer16(base: number, tifr: number, timsk: number, vec: number, port: AVRPortConfig, pins: [number, number, number], clock: [AVRPortConfig, number], cport = port): AVRTimerConfig {
  return {
    ...timer1Config, ...timerBitsC,
    TCCRA: base, TCCRB: base + 1, TCCRC: base + 2, TCNT: base + 4, ICR: base + 6, OCRA: base + 8, OCRB: base + 10, OCRC: base + 12,
    TIFR: tifr, TIMSK: timsk,
    captureInterrupt: V(vec), compAInterrupt: V(vec + 1), compBInterrupt: V(vec + 2), compCInterrupt: V(vec + 3), ovfInterrupt: V(vec + 4),
    compPortA: port.PORT, compPinA: pins[0], compPortB: port.PORT, compPinB: pins[1], compPortC: cport.PORT, compPinC: pins[2],
    externalClockPort: clock[0].PORT, externalClockPin: clock[1],
  };
}

const EXT = (index: number, EICR: number): NonNullable<AVRPortConfig['externalInterrupts'][number]> =>
  ({ EICR, EIMSK: 0x3d, EIFR: 0x3c, index, iscOffset: (index % 4) * 2, interrupt: V(index + 1) });
const PC = (n: number, mask: number, offset: number) => ({ PCIE: n, PCICR: 0x68, PCIFR: 0x3b, PCMSK: 0x6b + n, pinChangeInterrupt: V(9 + n), mask, offset });

const MEGA_PORTS: Record<string, AVRPortConfig> = {
  A: portAConfig,
  B: { ...portBConfig, pinChange: PC(0, 0xff, 0) },
  C: { ...portCConfig, pinChange: undefined },
  D: { ...portDConfig, pinChange: undefined, externalInterrupts: [0, 1, 2, 3].map((i) => EXT(i, 0x69)) },
  E: { ...portEConfig, pinChange: PC(1, 0x01, 0), externalInterrupts: [null, null, null, null, ...[4, 5, 6, 7].map((i) => EXT(i, 0x6a))] },
  F: portFConfig, G: portGConfig, H: portHConfig,
  J: { ...portJConfig, pinChange: PC(1, 0x7f, 1) },
  K: { ...portKConfig, pinChange: PC(2, 0xff, 0) },
  L: portLConfig,
};

// From the Arduino core's variants/mega/pins_arduino.h, digital pins 0-69.
const MEGA_ORDER = 'E0 E1 E4 E5 G5 E3 H3 H4 H5 H6 B4 B5 B6 B7 J1 J0 H1 H0 D3 D2 D1 D0 ' +
  'A0 A1 A2 A3 A4 A5 A6 A7 C7 C6 C5 C4 C3 C2 C1 C0 D7 G2 G1 G0 L7 L6 L5 L4 L3 L2 L1 L0 B3 B2 B1 B0 ' +
  'F0 F1 F2 F3 F4 F5 F6 F7 K0 K1 K2 K3 K4 K5 K6 K7';
const MEGA_PINS: Record<string, [string, number]> = {};
MEGA_ORDER.split(' ').forEach((pb, i) => { MEGA_PINS[i < 54 ? String(i) : 'A' + (i - 54)] = [pb[0], +pb[1]]; });

// A8-A15 are selected with MUX5 (ADCSRB bit 3): mux values 0x20-0x27.
const megaChannels: ADCConfig['muxChannels'] = {
  ...adcConfig.muxChannels,
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [0x20 + i, { type: ADCMuxInputType.SingleEnded, channel: 8 + i }])),
};

const megaUsart = (vec: number, base: number): USARTConfig => ({
  rxCompleteInterrupt: V(vec), dataRegisterEmptyInterrupt: V(vec + 1), txCompleteInterrupt: V(vec + 2),
  UCSRA: base, UCSRB: base + 1, UCSRC: base + 2, UBRRL: base + 4, UBRRH: base + 5, UDR: base + 6,
});

export const MEGA: AvrChip = {
  freq: 16e6, flashBytes: 0x40000,
  sramBytes: 0x2100,                     // RAMEND is 0x21FF: 512 bytes of registers and I/O, then 8 KB
  ports: MEGA_PORTS,
  pins: MEGA_PINS,
  analog: Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['A' + i, i])),
  timers: [
    { ...timer0Config, compAInterrupt: V(21), compBInterrupt: V(22), ovfInterrupt: V(23),
      compPortA: portBConfig.PORT, compPinA: 7, compPortB: portGConfig.PORT, compPinB: 5, externalClockPort: portDConfig.PORT, externalClockPin: 7 },
    timer16(0x80, 0x36, 0x6f, 16, portBConfig, [5, 6, 7], [portDConfig, 6]),
    { ...timer2Config, compAInterrupt: V(13), compBInterrupt: V(14), ovfInterrupt: V(15),
      compPortA: portBConfig.PORT, compPinA: 4, compPortB: portHConfig.PORT, compPinB: 6 },
    timer16(0x90, 0x38, 0x71, 31, portEConfig, [3, 4, 5], [portEConfig, 6]),
    timer16(0xa0, 0x39, 0x72, 41, portHConfig, [3, 4, 5], [portHConfig, 7]),
    timer16(0x120, 0x3a, 0x73, 46, portLConfig, [3, 4, 5], [portLConfig, 2]),
  ],
  usarts: [megaUsart(25, 0xc0), megaUsart(36, 0xc8), megaUsart(51, 0xd0), megaUsart(54, 0x130)],
  adc: { ...adcConfig, adcInterrupt: V(29), numChannels: 16, muxInputMask: 0x3f, muxChannels: megaChannels },
  twi: { ...twiConfig, twiInterrupt: V(39) },
  spi: { ...spiConfig, spiInterrupt: V(24) },
  i2cPins: { sda: '20', scl: '21' }, spiPins: { mosi: '51', miso: '50', sck: '52' },
  power: POWER_5V,
};

/** An Arduino Mega 2560 (ATmega2560 at 16 MHz). */
export class MegaBackend extends AvrBackend {
  constructor(id: string, hex: string) { super(id, hex, MEGA); }
}

// ---- ATtiny85: Digispark-style board, ATTinyCore at 16 MHz (PLL) ----
// Pins are named by their Arduino numbers: pin n is PBn. ADC0-3 are on PB5, PB2, PB4, PB3.
// Interrupt vectors are one word each on an 8 KB chip: vector n is at n.
const TINY_PORT_B: AVRPortConfig = {
  PIN: 0x36, DDR: 0x37, PORT: 0x38,
  pinChange: { PCIE: 5, PCICR: 0x5b, PCIFR: 0x5a, PCMSK: 0x35, pinChangeInterrupt: 2, mask: 0x3f, offset: 0 },
  externalInterrupts: [null, null, { EICR: 0x55, EIMSK: 0x5b, EIFR: 0x5a, index: 6, iscOffset: 0, interrupt: 1 }],
};

/**
 * avr8js's ATtiny Timer1 counts and interrupts correctly, but in PWM mode
 * (PWM1A/PWM1B, what analogWrite uses) it never drives OC1A/OC1B. On the
 * chip, with COM1x = 10 the pin is set when TCNT1 wraps to 0 and cleared on
 * the compare match; COM1x = 11 is the inverse. This adds that.
 */
function tinyTimer1(cpu: CPU): ATtinyTimer1 {
  const t = new ATtinyTimer1(cpu, attinyTimer1Config) as any;
  const SET = 2, CLEAR = 3;                       // avr8js PinOverrideMode values
  const base = t.timerUpdated.bind(t);
  t.timerUpdated = (value: number, prev: number) => {
    base(value, prev);
    const wrapped = prev > value;
    for (const ch of ['A', 'B'] as const) {
      const pwm = ch === 'A' ? t.pwmA : t.pwmB, com = ch === 'A' ? t.comA : t.comB, ocr = ch === 'A' ? t.ocrA : t.ocrB;
      if (!pwm || com < 2) continue;
      const pin = ch === 'A' ? attinyTimer1Config.compPinA : attinyTimer1Config.compPinB;
      const port = cpu.gpioByPort[attinyTimer1Config.compPortB];
      const matched = ((prev < ocr || wrapped) && value >= ocr) || (prev < ocr && wrapped);
      // A match after the wrap wins: the pin ends the step in the state the later event leaves it.
      if (wrapped) port?.timerOverridePin(pin, com === 2 ? SET : CLEAR);
      if (matched && ocr <= t.TOP) port?.timerOverridePin(pin, com === 2 ? CLEAR : SET);
    }
  };
  return t;
}

export const ATTINY85: AvrChip = {
  freq: 16e6, flashBytes: 0x2000,
  sramBytes: 0x160,                      // RAMEND is 0x25F: 96 bytes of registers and I/O, then 512 bytes
  ports: { B: TINY_PORT_B },
  pins: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i), ['B', i] as [string, number]])),
  analog: { 5: 0, 2: 1, 4: 2, 3: 3 },
  timers: [{
    ...timer0Config, TCCRA: 0x4a, TCCRB: 0x53, TCNT: 0x52, OCRA: 0x49, OCRB: 0x48, TIFR: 0x58, TIMSK: 0x59,
    TOV: 0x02, OCFA: 0x10, OCFB: 0x08, TOIE: 0x02, OCIEA: 0x10, OCIEB: 0x08,
    ovfInterrupt: 5, compAInterrupt: 10, compBInterrupt: 11,
    compPortA: 0x38, compPinA: 0, compPortB: 0x38, compPinB: 1, externalClockPort: 0x38, externalClockPin: 2,
  }],
  // Timer1 is the ATtiny's own; it chains onto timer 0's TIFR and TIMSK hooks, so it comes after.
  extra: (cpu) => [tinyTimer1(cpu)],
  usarts: [],
  adc: {
    ADMUX: 0x27, ADCSRA: 0x26, ADCSRB: 0x23, ADCL: 0x24, ADCH: 0x25, DIDR0: 0x34, adcInterrupt: 8,
    numChannels: 4, muxInputMask: 0x0f,
    muxChannels: {
      0: { type: ADCMuxInputType.SingleEnded, channel: 0 }, 1: { type: ADCMuxInputType.SingleEnded, channel: 1 },
      2: { type: ADCMuxInputType.SingleEnded, channel: 2 }, 3: { type: ADCMuxInputType.SingleEnded, channel: 3 },
      12: { type: ADCMuxInputType.Constant, voltage: 1.1 }, 13: { type: ADCMuxInputType.Constant, voltage: 0 },
      15: { type: ADCMuxInputType.Temperature },
    },
    adcReferences: [ADCReference.AVCC, ADCReference.AREF, ADCReference.Internal1V1, ADCReference.Reserved],
  },
  softSerial: { ACSR: 0x28, vector: 7, PIN: 0x36, ain0Bit: 0, ain1Bit: 1, port: 'B', tx: '0', rx: '1' },
  power: [{ pin: '5V', level: 1 }, { pin: 'GND', level: 0 }],
};
