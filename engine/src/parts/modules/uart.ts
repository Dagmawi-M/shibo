// A serial line at the pin level, 8 data bits, no parity, one stop bit,
// idle high: what SoftwareSerial (or any bit-banged UART) speaks.
// The part listens on its RX pin and drives its TX pin bit by bit at exact times.
import type { PartCtx } from '../../part.ts';
import type { Level } from '../../types.ts';

export interface UartState { baud: number; rxBusy: boolean; rxLast: Level; out: number[]; txBit: number; txByte: number }

export const uartState = (baud: number): UartState => ({ baud, rxBusy: false, rxLast: 1, out: [], txBit: -1, txByte: 0 });

/**
 * `onByte` is called for each byte received on `rx`. Call `send` to queue bytes out on `tx`,
 * `onChange` from the device's onChange, and use `txLevel` in drives().
 */
export function uart(ctx: PartCtx, s: UartState, rx: string, onByte: (b: number) => void, live: () => boolean = () => true) {
  const ns = () => 1e9 / s.baud;
  const sample = (bit: number, acc: number): void => {
    if (bit < 8) { ctx.after(ns(), () => sample(bit + 1, acc | ((ctx.level(rx) === 1 ? 1 : 0) << bit))); return; }
    // Then the middle of the stop bit; the receiver is free again for the next start bit.
    ctx.after(ns(), () => { s.rxBusy = false; if (ctx.level(rx) === 1 && live()) onByte(acc); });
  };
  const next = (): void => {
    // txBit: -1 idle, 0 start bit, 1-8 data, 9 stop bit.
    if (s.txBit === -1) { if (!s.out.length) return; s.txByte = s.out.shift()!; s.txBit = 0; }
    else if (++s.txBit > 9) { s.txBit = -1; ctx.changed(); next(); return; }
    ctx.changed();
    ctx.after(ns(), next);
  };
  return {
    onChange(): void {
      const l = ctx.level(rx);
      if (!s.rxBusy && s.rxLast === 1 && l === 0) {
        s.rxBusy = true;
        // Sample the start bit in its middle, then each data bit one bit-time apart.
        ctx.after(ns() / 2, () => { if (ctx.level(rx) !== 0) { s.rxBusy = false; return; } ctx.after(ns(), () => sample(1, ctx.level(rx) === 1 ? 1 : 0)); });
      }
      s.rxLast = l;
    },
    send(bytes: string | number[]): void {
      const list = typeof bytes === 'string' ? [...new TextEncoder().encode(bytes)] : bytes;
      s.out.push(...list);
      if (s.txBit === -1) next();
    },
    txLevel(): Level {
      if (s.txBit <= 0) return s.txBit === 0 ? 0 : 1;
      if (s.txBit === 9) return 1;
      return ((s.txByte >> (s.txBit - 1)) & 1) as Level;
    },
    /** Bytes waiting, plus the one going out now. */
    pending: (): number => s.out.length + (s.txBit >= 0 ? 1 : 0),
  };
}
