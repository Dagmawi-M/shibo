import type { ChipBackend } from '../types.ts';
import { ATTINY85, AvrBackend, MEGA, NANO, UNO } from './avr.ts';

/** How to make a running chip for each board type, from the firmware the build produced. */
const BACKENDS: Record<string, (id: string, firmware: string) => ChipBackend> = {
  uno: (id, hex) => new AvrBackend(id, hex, UNO),
  nano: (id, hex) => new AvrBackend(id, hex, NANO),
  mega: (id, hex) => new AvrBackend(id, hex, MEGA),
  attiny85: (id, hex) => new AvrBackend(id, hex, ATTINY85),
};

/** Board types the engine can run. */
export const runnableBoards: string[] = Object.keys(BACKENDS);

export function createBackend(board: string, id: string, firmware: string): ChipBackend {
  if (!Object.hasOwn(BACKENDS, board)) throw new Error(`${id} is a "${board}" board, which cannot run yet`);
  return BACKENDS[board](id, firmware);
}
