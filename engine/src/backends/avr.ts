import {
  CPU, avrInstruction, AVRIOPort, portBConfig, portCConfig, portDConfig,
  AVRTimer, timer0Config, timer1Config, timer2Config,
  AVRUSART, usart0Config, AVRADC, adcConfig, PinState, AVRTWI, twiConfig, AVRSPI, spiConfig,
} from 'avr8js';
import type { ChipBackend, I2CHandler, Level, Ns, PinDrive } from '../types.ts';
import { captureGraph, restoreGraph } from '../graphstate.ts';

const FREQ = 16e6;

// Uno pin name -> [port, bit]
const PINS: Record<string, [string, number]> = {};
for (let i = 0; i < 8; i++) PINS[String(i)] = ['D', i];
for (let i = 8; i < 14; i++) PINS[String(i)] = ['B', i - 8];
for (let i = 0; i < 6; i++) PINS['A' + i] = ['C', i];

/** Intel HEX text -> program memory. */
export function parseHex(text: string): Uint16Array {
  const prog = new Uint8Array(0x8000);
  for (const line of text.split('\n')) {
    if (line[0] !== ':' || line.substr(7, 2) !== '00') continue;
    const n = parseInt(line.substr(1, 2), 16), addr = parseInt(line.substr(3, 4), 16);
    for (let i = 0; i < n; i++) prog[addr + i] = parseInt(line.substr(9 + i * 2, 2), 16);
  }
  return new Uint16Array(prog.buffer);
}

/** An Arduino Uno (ATmega328P at 16 MHz) running real firmware on avr8js. */
export class UnoBackend implements ChipBackend {
  readonly id: string;
  private cpu: CPU;
  private ports: Record<string, AVRIOPort>;
  private usart: AVRUSART;
  private adc: AVRADC;
  private stateRoots: unknown[];
  /** Bytes waiting to go into the chip: a serial line carries one byte at a time. */
  private rx: { queue: number[] } = { queue: [] };
  private run = { end: 0 };              // the cycle this runUntil stops at; interrupt() pulls it in
  private i2c: I2CHandler | null = null;
  private spi: ((byte: number) => number) | null = null;
  readonly i2cPins = { sda: 'A4', scl: 'A5' };
  readonly spiPins = { mosi: '11', miso: '12', sck: '13' };
  private changeCbs: (() => void)[] = [];
  private serialCbs: ((byte: number) => void)[] = [];

  constructor(id: string, hex: string) {
    this.id = id;
    this.cpu = new CPU(parseHex(hex));
    this.ports = {
      B: new AVRIOPort(this.cpu, portBConfig), C: new AVRIOPort(this.cpu, portCConfig), D: new AVRIOPort(this.cpu, portDConfig),
    };
    const timers = [timer0Config, timer1Config, timer2Config].map((c) => new AVRTimer(this.cpu, c));
    this.usart = new AVRUSART(this.cpu, usart0Config, FREQ);
    this.adc = new AVRADC(this.cpu, adcConfig);
    // Listeners are attached before the roots are captured so they are part of
    // every snapshot; the callback lists they call live outside the graph.
    for (const p of Object.values(this.ports)) p.addListener(() => { for (const cb of this.changeCbs) cb(); });
    this.usart.onByteTransmit = (b) => { for (const cb of this.serialCbs) cb(b); };
    this.usart.onRxComplete = () => this.pumpSerial();
    // I2C and SPI are handled as whole bytes: the chip's own peripheral does the
    // clocking, and the wired device answers through the circuit.
    const twi = new AVRTWI(this.cpu, twiConfig, FREQ);
    twi.eventHandler = {
      start: () => twi.completeStart(),
      stop: () => { this.i2c?.stop(); twi.completeStop(); },
      connectToSlave: (addr, write) => twi.completeConnect(this.i2c ? this.i2c.connect(addr, write) : false),
      writeByte: (value) => twi.completeWrite(this.i2c ? this.i2c.write(value) : false),
      readByte: (ack) => twi.completeRead(this.i2c ? this.i2c.read(ack) : 0xff),
    };
    const spi = new AVRSPI(this.cpu, spiConfig, FREQ);
    spi.onByte = (value) => {
      const reply = this.spi ? this.spi(value) : 0xff;
      this.cpu.addClockEvent(() => spi.completeTransfer(reply), spi.transferCycles);
    };
    this.stateRoots = [this.cpu, this.ports, timers, this.usart, this.adc, this.rx, twi, spi];
  }

  runUntil(t: Ns): void {
    const cpu = this.cpu, run = this.run;
    run.end = Math.round((t * FREQ) / 1e9);
    while (cpu.cycles < run.end) { avrInstruction(cpu); cpu.tick(); }
  }

  nowNs(): Ns { return (this.cpu.cycles * 1e9) / FREQ; }
  interrupt(t: Ns): void { this.run.end = Math.min(this.run.end, Math.ceil((t * FREQ) / 1e9)); }
  onI2C(handler: I2CHandler): void { this.i2c = handler; }
  onSPI(transfer: (byte: number) => number): void { this.spi = transfer; }

  drives(): PinDrive[] {
    const out: PinDrive[] = [{ pin: '5V', level: 1 }, { pin: '3.3V', level: 1 }, { pin: 'GND', level: 0 }];
    for (const [pin, [port, bit]] of Object.entries(PINS)) {
      const st = this.ports[port].pinState(bit);
      if (st === PinState.High) out.push({ pin, level: 1 });
      else if (st === PinState.Low) out.push({ pin, level: 0 });
      else if (st === PinState.InputPullUp) out.push({ pin, level: null, pull: 'up' });
    }
    return out;
  }

  inputPins(): string[] {
    return Object.entries(PINS).filter(([, [port, bit]]) => this.ports[port].pinState(bit) === PinState.Input).map(([pin]) => pin);
  }

  setInput(pin: string, level: Level): void {
    const m = PINS[pin];
    if (m) this.ports[m[0]].setPin(m[1], level === 1);
  }

  setAnalog(pin: string, volts: number): void {
    const m = /^A([0-7])$/.exec(pin);
    if (m) this.adc.channelValues[+m[1]] = volts;
  }

  onChange(cb: () => void): void { this.changeCbs.push(cb); }
  onSerial(cb: (byte: number) => void): void { this.serialCbs.push(cb); }
  serialWrite(byte: number): void {
    // As on real hardware, bytes sent while the receiver is off are lost.
    if (!this.usart.rxEnable) return;
    this.rx.queue.push(byte);
    this.pumpSerial();
  }

  private pumpSerial(): void {
    if (this.rx.queue.length && !this.usart.rxBusy && this.usart.writeByte(this.rx.queue[0])) this.rx.queue.shift();
  }

  saveState(): unknown { return captureGraph(this.stateRoots); }
  restoreState(s: unknown): void { restoreGraph(s as ReturnType<typeof captureGraph>); }
}
