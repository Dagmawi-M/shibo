import type { Level, Ns } from './types.ts';
import type { Link } from './nets.ts';
import type { Electrical } from './electrical/ratings.ts';

export interface ControlDef { kind: 'momentary' | 'toggle' | 'range'; min?: number; max?: number; initial: number; label?: string; unit?: string; step?: number; log?: boolean }

/** How the page maps a drawing's own events onto controls. */
export interface UiEvent { on: string; control?: string; value?: number; delta?: number; from?: 'value' | 'pot' | 'dip' | 'keypad' | 'joystick' | 'ir' | 'digit' }
/** How a part appears in the editor. `show` maps drawing properties to output names. */
export interface PartUi { label: string; tag: string; group: string; show?: Record<string, string>; events?: UiEvent[]; paint?: 'lcd' | 'oled' | 'pixels' | 'tft'; chat?: boolean }
type LevelOf = (node: string) => Level;

export type OutputValue = number | boolean | string | number[];

/** What a stateful part can see and do. */
export interface PartCtx {
  id: string;
  attrs: Record<string, string>;
  /** The logic level on the net one of this part's pins is on. */
  level(pin: string): Level;
  /** The value of one of this part's controls. */
  control(name: string): number;
  /** Simulated time, exact to the chip's clock. */
  now(): Ns;
  /** Run something later, exactly dt nanoseconds from now. */
  after(dt: Ns, fn: () => void): void;
  /** Say that what this part drives or shows has changed. */
  changed(): void;
  /** What the other parts of the same type in the circuit offer (see Device.peer): radios find each other this way. */
  peers(): unknown[];
}

/** A part with memory: it reacts over time, drives pins, or speaks a bus protocol. */
export interface Device {
  links?(): Link[];
  /** Pins this part drives. Leave a pin out, or give level null, to let go of it. */
  drives?(): { pin: string; level: Level; pull?: 'up' | 'down' }[];
  /** Some net changed, or one of this part's controls moved. */
  onChange?(): void;
  outputs?(): Record<string, OutputValue>;
  /** What the page should draw; may average over time (brightness). Defaults to outputs(). */
  display?(): Record<string, OutputValue>;
  analog?(): { pin: string; volts: number }[];
  i2c?: { sda: string; scl: string; address(): number; start?(write: boolean): void; write(byte: number): boolean; read(ack: boolean): number; stop?(): void };
  /** `sck`: the part's clock pin; when given, the part only hears transfers if that pin is on the board's SPI clock. Call ctx.changed() if a byte changes what the part drives. */
  spi?: { cs: string; sck?: string; transfer(byte: number): number };
  /** Text typed into the part's own box on the page (a phone talking to a Bluetooth module). */
  text?(t: string): void;
  /** Anything this part offers others of its own type, such as a radio's receiver. */
  peer?: unknown;
  save(): unknown;
  restore(s: unknown): void;
}

/**
 * A part is plain data plus small functions, so a part made in the part
 * maker has exactly the same shape as a library part.
 */
export interface PartDef {
  type: string;
  pins: string[];
  ui?: PartUi;
  /** Settings a project file may carry for this part; anything else is dropped. */
  attrs?: string[];
  /** Things a person can change while it runs: a button, a slider. */
  controls?: Record<string, ControlDef>;
  /** How the part connects its own pins, given its control values. */
  links(id: string, state: Record<string, number>, level: LevelOf): Link[];
  /** Pins the part drives, for parts with no memory. */
  drives?(id: string, state: Record<string, number>, level: LevelOf): { pin: string; level: Level; pull?: 'up' | 'down' }[];
  /** What the part shows, given the logic level on each node. */
  outputs?(id: string, level: (node: string) => Level, state: Record<string, number>): Record<string, OutputValue>;
  /** Voltages the part puts on its pins (for chip analog inputs). */
  analog?(id: string, state: Record<string, number>, level: LevelOf): { node: string; volts: number }[];
  /** Wiring mistakes this part can recognise, as sentences for the user. */
  check?(id: string, see: { level: LevelOf; strong(node: string): boolean; boardPin(node: string): string | null }, state: Record<string, number>): string[];
  /** A switch contact: a board input wired to it floats while the contact is open, unless pulled. */
  contact?: boolean;
  /** Ratings and the model the electrical checks use (engine/src/electrical); library parts may have theirs in ratings.ts instead. */
  electrical?: Electrical;
  /** For parts that need memory, timing or a bus. Used instead of the functions above where it provides them. */
  device?(ctx: PartCtx): Device;
}
