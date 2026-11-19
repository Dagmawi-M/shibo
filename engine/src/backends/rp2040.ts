import { GPIOPinState, RP2040, USBCDC } from 'rp2040js';
import type { ChipBackend, Level, Ns, PinDrive } from '../types.ts';
import { bootromB1 } from './rp2040-bootrom.ts';

const FLASH_START = 0x10000000;

/** Intel HEX text (as objcopy writes it for the Pico, based at 0x10000000) -> bytes in flash. */
export function loadHexToFlash(text: string, flash: Uint8Array): void {
  let base = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line[0] !== ':') continue;
    const n = parseInt(line.substr(1, 2), 16), addr = parseInt(line.substr(3, 4), 16), type = line.substr(7, 2);
    const data = (i: number) => parseInt(line.substr(9 + i * 2, 2), 16);
    if (type === '04') base = ((data(0) << 8) | data(1)) << 16;
    else if (type === '02') base = ((data(0) << 8) | data(1)) << 4;
    else if (type === '00') {
      for (let i = 0; i < n; i++) {
        const at = base + addr + i - FLASH_START;
        if (at < 0 || at >= flash.length) throw new Error(`the program writes outside flash at ${(base + addr + i).toString(16)}`);
        flash[at] = data(i);
      }
    }
  }
}

/** Pico pin names GP0-GP28; GP23-25 and GP29 are used on the board (GP25 is the LED, LED_BUILTIN). */
const PICO_PINS = Array.from({ length: 29 }, (_, i) => `GP${i}`);

/**
 * A Raspberry Pi Pico (RP2040) running arduino-pico firmware on rp2040js.
 * Spike: GPIO and Serial (USB CDC, which is what `Serial` is in arduino-pico)
 * work; ADC, I2C and SPI are not wired to the circuit yet.
 */
export class Rp2040Backend implements ChipBackend {
  readonly id: string;
  private clock: any;
  private mcu: RP2040;
  private cdc: USBCDC;
  private run = { end: 0 };
  private changeCbs: (() => void)[] = [];
  private serialCbs: ((byte: number) => void)[] = [];
  private connected = false;
  private pending: number[] = [];

  constructor(id: string, hex: string) {
    this.id = id;
    this.mcu = new RP2040(); this.clock = this.mcu.clock;
    this.mcu.loadBootrom(bootromB1);
    loadHexToFlash(hex, this.mcu.flash);
    for (const p of this.mcu.gpio) p.addListener(() => { for (const cb of this.changeCbs) cb(); });
    this.cdc = new USBCDC(this.mcu.usbCtrl);
    this.cdc.onDeviceConnected = () => { this.connected = true; for (const b of this.pending.splice(0)) this.cdc.sendSerialByte(b); };
    this.cdc.onSerialData = (buf) => { for (const b of buf) for (const cb of this.serialCbs) cb(b); };
    this.mcu.reset();
  }

  runUntil(t: Ns): void {
    const { mcu, clock, run } = this;
    run.end = t;
    while (clock.nanos < run.end) {
      if (mcu.core.waiting) {
        // Asleep (WFI/WFE): skip ahead to the next timer alarm, but not past the target.
        clock.tick(Math.max(1, Math.min(clock.nanosToNextAlarm, run.end - clock.nanos)));
      } else {
        const cycles = mcu.core.executeInstruction();
        clock.tick((cycles * 1e9) / mcu.clkSys);
      }
    }
  }

  nowNs(): Ns { return this.clock.nanos; }
  interrupt(t: Ns): void { this.run.end = Math.min(this.run.end, t); }

  drives(): PinDrive[] {
    const out: PinDrive[] = [{ pin: '3V3', level: 1 }, { pin: 'VBUS', level: 1 }, { pin: 'GND', level: 0 }];
    PICO_PINS.forEach((pin, i) => {
      const st = this.mcu.gpio[i].value;
      if (st === GPIOPinState.High) out.push({ pin, level: 1 });
      else if (st === GPIOPinState.Low) out.push({ pin, level: 0 });
      else if (st === GPIOPinState.InputPullUp) out.push({ pin, level: null, pull: 'up' });
      else if (st === GPIOPinState.InputPullDown) out.push({ pin, level: null, pull: 'down' });
    });
    return out;
  }

  inputPins(): string[] { return PICO_PINS.filter((_, i) => this.mcu.gpio[i].value === GPIOPinState.Input); }

  setInput(pin: string, level: Level): void {
    const i = PICO_PINS.indexOf(pin);
    if (i >= 0) this.mcu.gpio[i].setInputValue(level === 1);
  }

  setAnalog(_pin: string, _volts: number): void { /* ADC not wired yet */ }
  onChange(cb: () => void): void { this.changeCbs.push(cb); }
  onSerial(cb: (byte: number) => void): void { this.serialCbs.push(cb); }
  serialWrite(byte: number): void { if (this.connected) this.cdc.sendSerialByte(byte); else this.pending.push(byte); }

  saveState(): unknown { throw new Error('rewinding a Pico is not supported yet'); }
  restoreState(_s: unknown): void { throw new Error('rewinding a Pico is not supported yet'); }
}
