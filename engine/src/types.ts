// Shared contracts. Time is virtual nanoseconds, owned by the Engine.
export type Ns = number;
/** A logic level; null means floating (nothing is driving it). */
export type Level = 0 | 1 | null;

export interface PinDrive { pin: string; level: Level; pull?: 'up' | 'down' }

/** What a board's I2C master asks of the bus. */
export interface I2CHandler {
  /** Address a device. Returns whether one answered. */
  connect(address: number, write: boolean): boolean;
  write(byte: number): boolean;
  read(ack: boolean): number;
  stop(): void;
}

/** One emulated chip. It never advances on its own: only inside runUntil. */
export interface ChipBackend {
  id: string;
  runUntil(t: Ns): void;
  drives(): PinDrive[];
  setInput(pin: string, level: Level): void;
  setAnalog(pin: string, volts: number): void;
  onChange(cb: () => void): void;
  onSerial(cb: (byte: number) => void): void;
  serialWrite(byte: number): void;
  saveState(): unknown;
  restoreState(s: unknown): void;
  /** The chip's own time right now, which inside runUntil is ahead of the engine's. */
  nowNs?(): Ns;
  /** Asked from inside runUntil: stop at t instead, because something is due then. */
  interrupt?(t: Ns): void;
  /** Pins set as plain inputs: nothing inside the chip holds them high or low. */
  inputPins?(): string[];
  onI2C?(handler: I2CHandler): void;
  i2cPins?: { sda: string; scl: string };
  /** Called with each byte the chip clocks out as SPI master; returns the byte clocked in. */
  onSPI?(transfer: (byte: number) => number): void;
  spiPins?: { mosi: string; miso: string; sck: string };
}

/** Anything else that holds state the engine must be able to rewind. */
export interface Stateful {
  saveState(): unknown;
  restoreState(s: unknown): void;
  /** Throw if this state does not belong here. Called for everything before anything is restored. */
  checkState?(s: unknown): void;
}
