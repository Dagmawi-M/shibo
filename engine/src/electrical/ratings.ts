// Electrical ratings: what each board pin and part can take, and how each
// part looks to the circuit solver. Figures are from datasheets where a
// part has one, and typical values for common modules otherwise.
import type { OutputValue } from '../part.ts';

/** One rail a board supplies, such as 5V from USB or 3.3V from its regulator. */
export interface Rail { pin: string; volts: number; maxMa: number; ohms: number; what: string; from?: string }

export interface BoardRating {
  /** The chip's supply, which output pins swing to. */
  vcc: number;
  rails: Rail[];
  /** Pins that are the same as another pin (IOREF is the 5V rail on an Uno). */
  aliases?: Record<string, string>;
  /** Pins that are not I/O and not rails: they are left out of pin checks. */
  other?: string[];
  /** Output resistance of a pin driving high or low, and of the internal pull-up. */
  pinOhms: number; pullupOhms: number;
  pinOkMa: number; pinMaxMa: number;
  /** All I/O pins together (the chip's VCC and GND pins). */
  totalMaxMa: number;
  /** The highest voltage an I/O pin can take. */
  pinMaxV: number;
  chip: string;
}

const avr = (rails: Rail[], extra: Partial<BoardRating> = {}): BoardRating => ({
  vcc: 5, rails, pinOhms: 25, pullupOhms: 35_000, pinOkMa: 20, pinMaxMa: 40, totalMaxMa: 200, pinMaxV: 5.5, chip: 'ATmega328P',
  other: ['VIN', 'AREF', 'RESET'], ...extra,
});

/**
 * USB gives 500 mA, through a 500 mA resettable fuse on the Uno; the board itself takes about 50 mA of it.
 * The Uno's 3.3 V comes from an LP2985 regulator (150 mA). The Nano's comes from its USB chip (FT232RL: 50 mA).
 */
export const boardRatings: Record<string, BoardRating> = {
  uno: avr([
    { pin: '5V', volts: 5, maxMa: 450, ohms: 0.2, what: 'USB (500 mA, about 50 mA of it used by the board itself)' },
    { pin: '3.3V', volts: 3.3, maxMa: 150, ohms: 0.5, what: 'the 3.3 V regulator (150 mA)', from: '5V' },
  ], { aliases: { IOREF: '5V' } }),
  nano: avr([
    { pin: '5V', volts: 5, maxMa: 450, ohms: 0.2, what: 'USB (500 mA, about 50 mA of it used by the board itself)' },
    { pin: '3.3V', volts: 3.3, maxMa: 50, ohms: 1, what: 'the USB chip\'s 3.3 V output (50 mA)', from: '5V' },
  ]),
};
/** A board type with no rating of its own is treated as a 5 V AVR board. */
export const boardRating = (type: string): BoardRating => (Object.hasOwn(boardRatings, type) ? boardRatings[type] : boardRatings.uno);

/** An LED's forward voltage at 20 mA, and the currents it is happy with. */
export interface LedSpec { vf: number; okMa: number; maxMa: number; dimMa: number }
const LED: Record<string, LedSpec> = {
  red: { vf: 2.0, okMa: 20, maxMa: 30, dimMa: 1 }, orange: { vf: 2.0, okMa: 20, maxMa: 30, dimMa: 1 },
  yellow: { vf: 2.1, okMa: 20, maxMa: 30, dimMa: 1 }, green: { vf: 2.2, okMa: 20, maxMa: 30, dimMa: 1 },
  blue: { vf: 3.1, okMa: 20, maxMa: 30, dimMa: 1 }, white: { vf: 3.1, okMa: 20, maxMa: 30, dimMa: 1 },
  purple: { vf: 3.1, okMa: 20, maxMa: 30, dimMa: 1 }, cyan: { vf: 3.1, okMa: 20, maxMa: 30, dimMa: 1 },
  pink: { vf: 3.1, okMa: 20, maxMa: 30, dimMa: 1 }, lime: { vf: 2.2, okMa: 20, maxMa: 30, dimMa: 1 },
};
export const ledSpec = (color?: string): LedSpec => LED[(color ?? 'red').toLowerCase()] ?? LED.red;

/** What a part is to the solver. Pins are the part's own pin names. */
export type Element =
  | { kind: 'R'; a: string; b: string; ohms: number }
  | { kind: 'led'; a: string; k: string; spec: LedSpec; name: string }
  /** A module drawing about `ma` from its supply at `volts`: modelled as a resistor, so it draws less on a lower supply. */
  | { kind: 'load'; vcc: string; gnd: string; ma: number; volts: number };

export interface Supply { vcc: string; gnd: string; min: number; max: number }

export interface Electrical {
  /** Elements, given the part's settings, controls and what it shows. */
  elements?(attrs: Record<string, string>, controls: Record<string, number>, out: Record<string, OutputValue>): Element[];
  supplies?: Supply[];
  /** The highest voltage its signal pins can take (3.6 V for a 3.3 V part). */
  logicMax?: number;
  /** Its signal pins, if not every pin that is not a supply pin. */
  signals?: string[];
  /** The solver models this part's analog outputs itself, so the logic layer's voltages are left out. */
  ownAnalog?: boolean;
}

/** "220", "1k", "4k7", "4.7K", "1M", "220Ω", "10kohm" in ohms; NaN if it is not a resistance. */
export function ohms(text: string | undefined, fallback: number): number {
  if (text === undefined || text === '') return fallback;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([rRkKmM]?)(\d*)\s*(?:Ω|ohms?)?\s*$/i.exec(text);
  if (!m) return NaN;
  const mult = { '': 1, r: 1, k: 1e3, m: 1e6 }[m[2].toLowerCase() as '' | 'r' | 'k' | 'm'];
  const n = m[3] ? Number(`${m[1]}.${m[3]}`) : Number(m[1]);
  return n * mult;
}

const load = (ma: number, vcc = 'VCC', gnd = 'GND', volts = 5): Element => ({ kind: 'load', vcc, gnd, ma, volts });
const module = (ma: number, min: number, max: number, vcc = 'VCC', gnd = 'GND'): Electrical => ({ elements: () => [load(ma, vcc, gnd)], supplies: [{ vcc, gnd, min, max }] });
/** A potentiometer as two resistors either side of the wiper. */
const pot = (total: number, frac: number, vcc: string, sig: string, gnd: string): Element[] => {
  const f = Math.min(1, Math.max(0, frac));
  return [{ kind: 'R', a: vcc, b: sig, ohms: Math.max(1, total * (1 - f)) }, { kind: 'R', a: sig, b: gnd, ohms: Math.max(1, total * f) }];
};
const brightness = (out: Record<string, OutputValue>, key: string): number => {
  const v = out[key];
  if (Array.isArray(v)) return v.reduce((s, x) => s + (Number(x) || 0), 0);
  return typeof v === 'number' ? v : 0;
};

/**
 * Ratings for library parts, by type. A part may instead carry its own as
 * `electrical` in its definition; that wins.
 */
export const partRatings: Record<string, Electrical> = {
  resistor: { elements: (a) => [{ kind: 'R', a: '1', b: '2', ohms: ohms(a.value, 1000) }] },
  led: { elements: (a) => [{ kind: 'led', a: 'A', k: 'C', spec: ledSpec(a.color), name: '' }] },
  'rgb-led': {
    elements: (a) => {
      const spec = { R: ledSpec('red'), G: ledSpec('green'), B: ledSpec('blue') };
      // Pure green and blue dies are both about 3 V.
      spec.G = { ...spec.G, vf: 3.0 };
      return (['R', 'G', 'B'] as const).map((p) => (a.common === 'anode' ? { kind: 'led', a: 'COM', k: p, spec: spec[p], name: p } : { kind: 'led', a: p, k: 'COM', spec: spec[p], name: p }) as Element);
    },
  },
  'led-bar-graph': { elements: (a) => Array.from({ length: 10 }, (_, i) => ({ kind: 'led', a: `A${i + 1}`, k: `C${i + 1}`, spec: ledSpec(a.color), name: `segment ${i + 1}` }) as Element) },
  '7segment': {
    elements: (a) => {
      const digits = Math.min(4, Math.max(1, Number(a.digits) || 1)), anode = a.common !== 'cathode', spec = ledSpec(a.color);
      const out: Element[] = [];
      for (let d = 0; d < digits; d++) for (const seg of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP']) {
        const com = digits === 1 ? 'COM.1' : `DIG${d + 1}`, name = digits === 1 ? `segment ${seg}` : `digit ${d + 1} segment ${seg}`;
        out.push(anode ? { kind: 'led', a: com, k: seg, spec, name } : { kind: 'led', a: seg, k: com, spec, name });
      }
      return out;
    },
  },
  potentiometer: { ownAnalog: true, elements: (a, c) => pot(10_000, (c.value ?? 0) / 1023, 'VCC', 'SIG', 'GND') },
  'slide-potentiometer': { ownAnalog: true, elements: (a, c) => pot(10_000, (c.value ?? 0) / 1023, 'VCC', 'SIG', 'GND') },
  'analog-joystick': {
    ownAnalog: true,
    elements: (a, c) => [...pot(10_000, ((c.x ?? 0) + 1) / 2, 'VCC', 'HORZ', 'GND'), ...pot(10_000, ((c.y ?? 0) + 1) / 2, 'VCC', 'VERT', 'GND')],
  },
  // KEMET/NEC KS2E-M-DC5: 5 V coil of 178 Ω (140 mW), so about 28 mA.
  'ks2e-m-dc5': { elements: () => [{ kind: 'R', a: 'COIL1', b: 'COIL2', ohms: 178 }] },
  // A small hobby servo (SG90) draws about 150 mA while it moves, more if it stalls. 4.8 to 6 V.
  servo: { elements: () => [load(150, 'V+', 'GND')], supplies: [{ vcc: 'V+', gnd: 'GND', min: 4.5, max: 6 }] },
  // Stepper coils: a small bipolar stepper is a few tens of ohms per coil; the two-hand clock stepper (X27.168 style) is about 260 Ω.
  'stepper-motor': { elements: () => [{ kind: 'R', a: 'A-', b: 'A+', ohms: 30 }, { kind: 'R', a: 'B-', b: 'B+', ohms: 30 }] },
  'biaxial-stepper': { elements: () => ['A1', 'B1', 'A2', 'B2'].map((c) => ({ kind: 'R', a: `${c}-`, b: `${c}+`, ohms: 260 }) as Element) },
  // An I2C backpack LCD with its backlight on draws 20 to 30 mA. Bare: the logic takes about 1.5 mA and the backlight is an LED with 100 Ω on the board.
  lcd1602: lcd(), lcd2004: lcd(),
  // SSD1306 modules have a regulator: 3.3 to 5 V on VIN, 10 to 20 mA depending on how many pixels are lit.
  ssd1306: { elements: (a, c, o) => [load(8 + 12 * Math.min(1, (Number(o.pixels) || 0) / 8192), 'VIN', 'GND')], supplies: [{ vcc: 'VIN', gnd: 'GND', min: 3, max: 5.5 }] },
  // A WS2812B pixel: about 1 mA idle and up to 20 mA per colour at full brightness. 3.5 to 5.3 V.
  neopixel: { elements: (a, c, o) => [load(1 + 20 * (brightness(o, 'r') + brightness(o, 'g') + brightness(o, 'b')), 'VDD', 'VSS')], supplies: [{ vcc: 'VDD', gnd: 'VSS', min: 3.5, max: 5.3 }] },
  'led-ring': strip(), 'neopixel-matrix': strip(),
  // DS1307: 4.5 to 5.5 V only.
  ds1307: module(1.5, 4.5, 5.5, '5V'),
  // GY-521 (MPU6050) modules have a 3.3 V regulator and take 3.3 to 5 V.
  mpu6050: module(4, 3, 5.5),
  hx711: module(1.5, 2.6, 5.5),
  // HC-SR04: 5 V only, about 15 mA.
  'hc-sr04': module(15, 4.5, 5.5),
  dht22: module(1.5, 3.3, 6),
  // HC-SR501 PIR: its regulator needs 4.5 V or more.
  'pir-motion-sensor': module(0.1, 4.5, 20, 'VCC'),
  'ir-receiver': module(1, 2.7, 5.5),
  'photoresistor-sensor': module(4, 3.3, 5.5),
  'ntc-temperature-sensor': module(0.5, 3.3, 5.5),
  // An MQ-2 gas sensor's heater is about 33 Ω: 150 mA at 5 V, and it wants 5 V.
  'gas-sensor': module(150, 4.9, 5.1),
  'flame-sensor': module(4, 3.3, 5.5),
  'big-sound-sensor': module(4, 3.3, 5.5),
  'small-sound-sensor': module(4, 3.3, 5.5),
  'tilt-switch': module(3, 3.3, 5.5),
  'heart-beat-sensor': module(4, 3, 5.5),
  'ky-040': { elements: () => [{ kind: 'R', a: 'VCC', b: 'CLK', ohms: 10_000 }, { kind: 'R', a: 'VCC', b: 'DT', ohms: 10_000 }] },
  // Pure contacts: their connections come from the logic layer.
  pushbutton: {}, 'pushbutton-6mm': {}, 'slide-switch': {}, 'dip-switch-8': {}, 'membrane-keypad': {},
  // A piezo buzzer draws next to nothing at DC.
  buzzer: {}, 'rotary-dialer': {}, 'ir-remote': {},
};

function lcd(): Electrical {
  return {
    elements: () => [load(25, 'VCC', 'GND'), load(1.5, 'VDD', 'VSS'), { kind: 'R', a: 'A', b: 'A.int', ohms: 100 }, { kind: 'led', a: 'A.int', k: 'K', spec: { vf: 3.1, okMa: 30, maxMa: 40, dimMa: 1 }, name: 'backlight' }],
    supplies: [{ vcc: 'VCC', gnd: 'GND', min: 4.5, max: 5.5 }, { vcc: 'VDD', gnd: 'VSS', min: 4.5, max: 5.5 }],
  };
}
function strip(): Electrical {
  return { elements: (a, c, o) => {
    const px = Array.isArray(o.pixels) ? (o.pixels as number[]) : [];
    const n = Math.max(1, Math.round(px.length / 3));
    return [load(n + 20 * px.reduce((s, x) => s + (Number(x) || 0), 0) / 255, 'VCC', 'GND')];
  }, supplies: [{ vcc: 'VCC', gnd: 'GND', min: 3.5, max: 5.3 }] };
}
