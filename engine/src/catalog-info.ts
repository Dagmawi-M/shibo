// What the catalogue says about each part: a one-line description, words to
// find it by, typical supply voltage, a few spec lines, what each pin is for,
// and a small wiring example for an Arduino Uno. Plain data with no imports,
// so the editor page can bundle it as is.
//
// A part with no entry here still shows up, with a description made from its
// name (see infoFor). To describe a new part, add an entry keyed by its type.

import { moreCatalogInfo } from './catalog-info-more.ts';

export interface Wiring {
  /** A pin of the part. */
  pin: string;
  /** An Uno pin: 5V, GND, 13, A0 ... */
  to: string;
  /** Something in between, such as "220 Ω resistor". */
  via?: string;
}

export interface PartInfo {
  /** One short line, shown on the card. */
  summary: string;
  /** Other words people use for it, for search. */
  tags: string[];
  /** Typical supply, as text: "5 V", "3.3–5 V". */
  volts?: string;
  /** Short facts, no links. */
  specs: string[];
  /** What a pin is for, where the common names below do not say enough. */
  pins?: Record<string, string>;
  /** How to hook it to an Uno. */
  wiring?: Wiring[];
  /** A few lines of sketch that go with the wiring. */
  code?: string;
}

export interface SearchEntry { type: string; label: string; group: string }

/** What common pin names mean, for any part. */
const COMMON: Record<string, string> = {
  GND: 'Ground (0 V)', VSS: 'Ground (0 V)', 'V-': 'Ground (0 V)', COM: 'Common pin',
  VCC: 'Power supply in', VDD: 'Power supply in', VIN: 'Power supply in', 'V+': 'Power supply in', '5V': '5 V supply', '3V3': '3.3 V supply', '3.3V': '3.3 V supply',
  SDA: 'I2C data', SCL: 'I2C clock', XDA: 'Auxiliary I2C data', XCL: 'Auxiliary I2C clock',
  MOSI: 'SPI data from the board', MISO: 'SPI data to the board', SCK: 'Clock from the board', CS: 'Chip select (active low)', SS: 'Chip select (active low)',
  TX: 'Serial data out', RX: 'Serial data in', RST: 'Reset (active low)', RESET: 'Reset (active low)', INT: 'Interrupt output',
  AOUT: 'Analog output', AO: 'Analog output', DOUT: 'Digital output', DO: 'Digital output', OUT: 'Output signal', SIG: 'Signal',
  DIN: 'Data in', DATA: 'Data', CLK: 'Clock', DAT: 'Data out', NC: 'Not connected', PWM: 'Control signal (PWM)',
};

const BUTTON: PartInfo = {
  summary: 'A momentary push switch that closes while you hold it down.',
  tags: ['button', 'switch', 'tactile', 'push', 'momentary', 'key', 'press', 'input'],
  volts: 'any',
  specs: ['Four legs: the two on each side are always joined', 'Pressing joins side 1 to side 2', 'Real buttons bounce for a few milliseconds'],
  pins: { '1.l': 'Side 1 (joined to 1.r)', '1.r': 'Side 1 (joined to 1.l)', '2.l': 'Side 2 (joined to 2.r)', '2.r': 'Side 2 (joined to 2.l)' },
  wiring: [{ pin: '1.l', to: '2' }, { pin: '2.r', to: 'GND' }],
  code: 'pinMode(2, INPUT_PULLUP);\nif (digitalRead(2) == LOW) { /* pressed */ }',
};

const SOUND: PartInfo = {
  summary: 'Microphone module with a loudness voltage and a threshold output.',
  tags: ['sound', 'microphone', 'mic', 'noise', 'clap', 'audio', 'loudness', 'ky-037', 'ky-038', 'sensor'],
  volts: '3.3–5 V',
  specs: ['Analog output rises with loudness', 'Digital output goes high above the threshold', 'Threshold set by the blue trimmer'],
  wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'AOUT', to: 'A0' }, { pin: 'DOUT', to: '2' }],
  code: 'int level = analogRead(A0);\nbool loud = digitalRead(2);',
};

const LCD_PINS: Record<string, string> = {
  GND: 'Ground (I2C backpack)', VCC: '5 V supply (I2C backpack)', SDA: 'I2C data (backpack)', SCL: 'I2C clock (backpack)',
  VSS: 'Ground', VDD: '5 V supply', V0: 'Contrast (wiper of a 10 k pot)', RS: 'Register select: command or text', RW: 'Read/write: tie to ground', E: 'Enable: data is taken on its falling edge',
  D0: 'Data bit 0 (unused in 4-bit mode)', D1: 'Data bit 1 (unused in 4-bit mode)', D2: 'Data bit 2 (unused in 4-bit mode)', D3: 'Data bit 3 (unused in 4-bit mode)',
  D4: 'Data bit 4', D5: 'Data bit 5', D6: 'Data bit 6', D7: 'Data bit 7', A: 'Backlight anode (+)', K: 'Backlight cathode (−)',
};
const LCD_WIRING: Wiring[] = [
  { pin: 'VSS', to: 'GND' }, { pin: 'VDD', to: '5V' }, { pin: 'RW', to: 'GND' }, { pin: 'RS', to: '12' }, { pin: 'E', to: '11' },
  { pin: 'D4', to: '5' }, { pin: 'D5', to: '4' }, { pin: 'D6', to: '3' }, { pin: 'D7', to: '2' }, { pin: 'A', to: '5V', via: '220 Ω resistor' }, { pin: 'K', to: 'GND' },
];

const PIXELS = (summary: string, extra: string[], specs: string[]): PartInfo => ({
  summary, tags: ['neopixel', 'ws2812', 'ws2812b', 'addressable', 'rgb', 'led', 'pixel', 'light', 'colour', 'color', ...extra],
  volts: '5 V',
  specs: ['Each LED holds a 24-bit colour', 'One data wire, chained DOUT to DIN', ...specs, 'Up to 60 mA per LED at full white'],
  pins: { DIN: 'Data in from the board', DOUT: 'Data out to the next strip' },
  wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'DIN', to: '6', via: '330 Ω resistor' }],
  code: '#include <Adafruit_NeoPixel.h>\nAdafruit_NeoPixel px(16, 6, NEO_GRB + NEO_KHZ800);\npx.begin(); px.setPixelColor(0, px.Color(255, 0, 0)); px.show();',
});

const STEPPER_PINS = { 'A-': 'Coil A, end −', 'A+': 'Coil A, end +', 'B+': 'Coil B, end +', 'B-': 'Coil B, end −' };

export const catalogInfo: Record<string, PartInfo> = {
  // ---------- boards ----------
  uno: {
    summary: 'The classic ATmega328P board: 14 digital pins, 6 analog inputs.',
    tags: ['arduino', 'board', 'microcontroller', 'mcu', 'atmega328p', 'avr', 'uno r3', 'controller'],
    volts: '5 V logic, 7–12 V in',
    specs: ['ATmega328P at 16 MHz', '32 KB flash, 2 KB RAM, 1 KB EEPROM', 'PWM on pins 3, 5, 6, 9, 10, 11', 'I2C on A4 (SDA) and A5 (SCL)', '20 mA per pin recommended, 40 mA absolute'],
    pins: { '0': 'Serial RX', '1': 'Serial TX', '13': 'Digital pin with the on-board LED', A4: 'Analog in / I2C SDA', A5: 'Analog in / I2C SCL', AREF: 'Analog reference voltage', IOREF: 'Tells shields the logic voltage (5 V)', VIN: 'Supply in, 7–12 V' },
  },
  nano: {
    summary: 'A breadboard-friendly ATmega328P board with 8 analog inputs.',
    tags: ['arduino', 'board', 'microcontroller', 'mcu', 'atmega328p', 'avr', 'small', 'controller'],
    volts: '5 V logic, 7–12 V in',
    specs: ['ATmega328P at 16 MHz', '32 KB flash, 2 KB RAM', 'A6 and A7 are analog inputs only', 'Fits a breadboard, powered over USB'],
    pins: { '0': 'Serial RX', '1': 'Serial TX', '13': 'Digital pin with the on-board LED', A6: 'Analog input only', A7: 'Analog input only', A4: 'Analog in / I2C SDA', A5: 'Analog in / I2C SCL' },
  },

  // ---------- lights and sound ----------
  led: {
    summary: 'A single light-emitting diode. Needs a resistor in series.',
    tags: ['light', 'lamp', 'indicator', 'diode', 'led', '5mm', 'blink'],
    volts: '1.8–3.3 V forward',
    specs: ['Red forward voltage about 2 V, blue and white about 3 V', 'Typical current 10–20 mA', '220 Ω from a 5 V pin gives about 13 mA', 'The longer leg is the anode'],
    pins: { A: 'Anode (+), the long leg', C: 'Cathode (−), the flat side' },
    wiring: [{ pin: 'A', to: '13', via: '220 Ω resistor' }, { pin: 'C', to: 'GND' }],
    code: 'pinMode(13, OUTPUT);\ndigitalWrite(13, HIGH);',
  },
  'rgb-led': {
    summary: 'Red, green and blue LEDs in one, for mixing any colour.',
    tags: ['rgb', 'colour', 'color', 'light', 'led', 'tricolor', 'multicolor', 'common cathode', 'common anode'],
    volts: '2–3.3 V forward',
    specs: ['Three LEDs sharing one common leg', 'Common cathode or common anode (a setting)', 'One resistor per colour', 'Use PWM pins to mix colours'],
    pins: { R: 'Red LED', G: 'Green LED', B: 'Blue LED', COM: 'Common leg: GND for common cathode, 5 V for common anode' },
    wiring: [{ pin: 'R', to: '9', via: '220 Ω resistor' }, { pin: 'G', to: '10', via: '220 Ω resistor' }, { pin: 'B', to: '11', via: '220 Ω resistor' }, { pin: 'COM', to: 'GND' }],
    code: 'analogWrite(9, 255);   // red\nanalogWrite(10, 80);   // some green\nanalogWrite(11, 0);',
  },
  'led-bar-graph': {
    summary: 'Ten LEDs in a row, for levels and meters.',
    tags: ['bar', 'graph', 'meter', 'level', 'vu', 'led', 'light', 'array'],
    volts: '2 V forward per LED',
    specs: ['Ten independent LEDs', 'Each needs its own resistor', 'Anodes on one side, cathodes on the other'],
    pins: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [[`A${i + 1}`, `Anode of LED ${i + 1}`], [`C${i + 1}`, `Cathode of LED ${i + 1}`]]).flat()),
    wiring: [{ pin: 'A1', to: '2', via: '220 Ω resistor' }, { pin: 'C1', to: 'GND' }, { pin: 'A2', to: '3', via: '220 Ω resistor' }, { pin: 'C2', to: 'GND' }],
    code: 'for (int i = 0; i < 10; i++) digitalWrite(2 + i, i < level);',
  },
  '7segment': {
    summary: 'A numeric display of 1 to 4 digits made of seven bar LEDs.',
    tags: ['seven segment', 'digit', 'number', 'numeric', 'display', 'counter', 'clock', 'led'],
    volts: '2 V forward per segment',
    specs: ['Segments A to G plus a decimal point', 'Common anode or common cathode', 'Multi-digit versions are multiplexed', 'One resistor per segment'],
    pins: { A: 'Segment A (top)', B: 'Segment B (top right)', C: 'Segment C (bottom right)', D: 'Segment D (bottom)', E: 'Segment E (bottom left)', F: 'Segment F (top left)', G: 'Segment G (middle)', DP: 'Decimal point', COM: 'Common pin of the digit', DIG1: 'Digit 1 common', DIG2: 'Digit 2 common', DIG3: 'Digit 3 common', DIG4: 'Digit 4 common', CLN: 'Colon' },
    wiring: [{ pin: 'A', to: '2', via: '220 Ω resistor' }, { pin: 'B', to: '3', via: '220 Ω resistor' }, { pin: 'C', to: '4', via: '220 Ω resistor' }, { pin: 'COM', to: '5V' }],
    code: 'digitalWrite(2, LOW);   // segment A on (common anode: low lights it)',
  },
  buzzer: {
    summary: 'A piezo buzzer that plays tones from a toggling pin.',
    tags: ['buzzer', 'piezo', 'speaker', 'beeper', 'sound', 'tone', 'alarm', 'beep', 'audio'],
    volts: '3–5 V',
    specs: ['Passive: the pin sets the pitch with tone()', 'Loudest near 2–4 kHz', 'Draws only a few milliamps'],
    pins: { '1': 'Negative leg (to GND)', '2': 'Positive leg (to the pin)' },
    wiring: [{ pin: '2', to: '8' }, { pin: '1', to: 'GND' }],
    code: 'tone(8, 440, 500);  // A4 for half a second',
  },

  // ---------- basics ----------
  resistor: {
    summary: 'Limits current. The value is set in the part settings.',
    tags: ['resistor', 'ohm', 'resistance', 'pull-up', 'pull-down', 'current limit', 'passive', '220', '10k'],
    volts: 'any',
    specs: ['Common values: 220 Ω for LEDs, 10 kΩ for pull-ups', '1/4 W through-hole', 'No polarity'],
    pins: { '1': 'One end', '2': 'Other end' },
    wiring: [{ pin: '1', to: '13' }, { pin: '2', to: 'GND', via: 'an LED' }],
  },

  // ---------- switches and knobs ----------
  pushbutton: BUTTON,
  'pushbutton-6mm': { ...BUTTON, summary: 'A small 6 mm tactile switch that closes while held.', tags: [...BUTTON.tags, 'small', '6mm', 'mini'] },
  'slide-switch': {
    summary: 'A two-position switch that stays where you leave it.',
    tags: ['switch', 'slide', 'toggle', 'spdt', 'on off', 'selector', 'input'],
    volts: 'any',
    specs: ['SPDT: the middle pin joins either end', 'Stays put, unlike a button'],
    pins: { '1': 'One end', '2': 'Common (middle)', '3': 'Other end' },
    wiring: [{ pin: '2', to: '2' }, { pin: '1', to: 'GND' }, { pin: '3', to: '5V' }],
    code: 'bool on = digitalRead(2);',
  },
  potentiometer: {
    summary: 'A rotary knob that gives a voltage between its two ends.',
    tags: ['pot', 'knob', 'dial', 'variable resistor', 'trimmer', 'rotary', 'volume', 'analog', 'input', '10k'],
    volts: '0–5 V out',
    specs: ['Usually 10 kΩ', 'The wiper reads 0 to 1023 on an analog pin', 'About 300° of travel'],
    pins: { SIG: 'Wiper: the voltage you read', VCC: 'One end, to 5 V', GND: 'Other end, to ground' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'SIG', to: 'A0' }, { pin: 'GND', to: 'GND' }],
    code: 'int v = analogRead(A0);  // 0..1023',
  },
  'dip-switch-8': {
    summary: 'Eight tiny on/off switches in one package, for settings.',
    tags: ['dip', 'switch', 'configuration', 'address', 'bank', 'toggle', 'jumper', 'input'],
    volts: 'any',
    specs: ['Eight independent switches', 'Each joins its a and b pins when on', 'Read with INPUT_PULLUP'],
    pins: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [[`${i + 1}a`, `Switch ${i + 1}, side a`], [`${i + 1}b`, `Switch ${i + 1}, side b`]]).flat()),
    wiring: [{ pin: '1a', to: '2' }, { pin: '1b', to: 'GND' }, { pin: '2a', to: '3' }, { pin: '2b', to: 'GND' }],
    code: 'pinMode(2, INPUT_PULLUP);\nbool sw1 = digitalRead(2) == LOW;',
  },
  'membrane-keypad': {
    summary: 'A 4x4 or 4x3 grid of keys, read as rows and columns.',
    tags: ['keypad', 'keyboard', 'keys', 'matrix', 'membrane', 'number pad', 'pin pad', 'input', '4x4'],
    volts: 'any',
    specs: ['Each key joins one row to one column', 'Works with the Keypad library', 'Uses 7 or 8 pins'],
    pins: { R1: 'Row 1', R2: 'Row 2', R3: 'Row 3', R4: 'Row 4', C1: 'Column 1', C2: 'Column 2', C3: 'Column 3', C4: 'Column 4' },
    wiring: [{ pin: 'R1', to: '9' }, { pin: 'R2', to: '8' }, { pin: 'R3', to: '7' }, { pin: 'R4', to: '6' }, { pin: 'C1', to: '5' }, { pin: 'C2', to: '4' }, { pin: 'C3', to: '3' }, { pin: 'C4', to: '2' }],
    code: '#include <Keypad.h>\nchar k = keypad.getKey();',
  },
  'analog-joystick': {
    summary: 'A thumb stick with two analog axes and a push button.',
    tags: ['joystick', 'thumbstick', 'stick', 'gamepad', 'xy', 'ky-023', 'controller', 'analog', 'input'],
    volts: '5 V',
    specs: ['Two 10 kΩ pots, about 512 at rest', 'Pressing the stick grounds SEL', 'Read SEL with INPUT_PULLUP'],
    pins: { VERT: 'Vertical axis (analog)', HORZ: 'Horizontal axis (analog)', SEL: 'Push button, low when pressed' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'VERT', to: 'A0' }, { pin: 'HORZ', to: 'A1' }, { pin: 'SEL', to: '2' }],
    code: 'int y = analogRead(A0), x = analogRead(A1);\nbool pressed = digitalRead(2) == LOW;',
  },
  'slide-potentiometer': {
    summary: 'A straight sliding fader that gives a voltage by position.',
    tags: ['slider', 'fader', 'pot', 'linear', 'variable resistor', 'analog', 'input'],
    volts: '0–5 V out',
    specs: ['Usually 10 kΩ', 'Reads 0 to 1023 along its travel'],
    pins: { SIG: 'Wiper: the voltage you read', VCC: 'One end, to 5 V', GND: 'Other end, to ground' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'SIG', to: 'A0' }, { pin: 'GND', to: 'GND' }],
    code: 'int v = analogRead(A0);',
  },
  'ky-040': {
    summary: 'A knob that turns endlessly in clicks, with a push button.',
    tags: ['encoder', 'rotary', 'knob', 'quadrature', 'ky-040', 'dial', 'menu', 'input'],
    volts: '5 V',
    specs: ['20 clicks per turn', 'CLK and DT are a quadrature pair', 'SW goes low when pushed', 'Has its own pull-ups'],
    pins: { CLK: 'Output A', DT: 'Output B (direction)', SW: 'Push button, low when pressed' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'CLK', to: '2' }, { pin: 'DT', to: '3' }, { pin: 'SW', to: '4' }],
    code: 'if (digitalRead(2) != last) { dir = digitalRead(3) != digitalRead(2) ? 1 : -1; }',
  },

  // ---------- motors and switching ----------
  'ks2e-m-dc5': {
    summary: 'A 5 V relay with two changeover contacts for switching loads.',
    tags: ['relay', 'switch', 'coil', 'contact', 'dpdt', 'load', 'mains', 'power', 'actuator'],
    volts: '5 V coil',
    specs: ['Coil needs about 40 mA: drive it with a transistor', 'Put a diode across the coil', 'Two sets of NO, NC and common contacts'],
    pins: { COIL1: 'Coil end 1', COIL2: 'Coil end 2', P1: 'Common of contact 1', NO1: 'Closes to P1 when energised', NC1: 'Joined to P1 at rest', P2: 'Common of contact 2', NO2: 'Closes to P2 when energised', NC2: 'Joined to P2 at rest' },
    wiring: [{ pin: 'COIL1', to: '5V' }, { pin: 'COIL2', to: '7', via: 'NPN transistor and flyback diode' }],
    code: 'digitalWrite(7, HIGH);  // transistor on, relay clicks',
  },
  servo: {
    summary: 'A small motor that turns to an angle you choose, 0 to 180°.',
    tags: ['servo', 'motor', 'sg90', 'micro servo', 'angle', 'actuator', 'rc', 'arm'],
    volts: '4.8–6 V',
    specs: ['A pulse every 20 ms sets the angle', '1 ms is 0°, 2 ms is 180° (roughly)', 'Can draw 500 mA when moving: a separate supply is wise'],
    pins: { GND: 'Ground (brown)', 'V+': 'Power (red)', PWM: 'Control pulses (orange)' },
    wiring: [{ pin: 'GND', to: 'GND' }, { pin: 'V+', to: '5V' }, { pin: 'PWM', to: '9' }],
    code: '#include <Servo.h>\nServo s; s.attach(9);\ns.write(90);',
  },
  'stepper-motor': {
    summary: 'A bipolar stepper that turns in exact steps.',
    tags: ['stepper', 'motor', 'nema17', 'bipolar', 'step', 'cnc', '3d printer', 'actuator'],
    volts: '12 V typical',
    specs: ['200 steps per turn (1.8°)', 'Two coils, driven in turn', 'Needs a driver such as an A4988 or L298N'],
    pins: STEPPER_PINS,
    wiring: [{ pin: 'A+', to: '8', via: 'driver' }, { pin: 'A-', to: '9', via: 'driver' }, { pin: 'B+', to: '10', via: 'driver' }, { pin: 'B-', to: '11', via: 'driver' }],
    code: '#include <Stepper.h>\nStepper m(200, 8, 9, 10, 11);\nm.step(100);',
  },
  'biaxial-stepper': {
    summary: 'Two steppers on one shaft, like the hands of a clock.',
    tags: ['stepper', 'motor', 'clock', 'dual', 'gauge', 'hands', 'actuator'],
    volts: '5 V',
    specs: ['Two independent motors, inner and outer shaft', 'Each has two coils'],
    pins: { 'A1-': 'Motor 1, coil A −', 'A1+': 'Motor 1, coil A +', 'B1+': 'Motor 1, coil B +', 'B1-': 'Motor 1, coil B −', 'A2-': 'Motor 2, coil A −', 'A2+': 'Motor 2, coil A +', 'B2+': 'Motor 2, coil B +', 'B2-': 'Motor 2, coil B −' },
    wiring: [{ pin: 'A1+', to: '2', via: 'driver' }, { pin: 'A1-', to: '3', via: 'driver' }, { pin: 'B1+', to: '4', via: 'driver' }, { pin: 'B1-', to: '5', via: 'driver' }],
  },

  // ---------- sensors ----------
  'photoresistor-sensor': {
    summary: 'A light-dependent resistor module: brighter light, lower voltage.',
    tags: ['ldr', 'light', 'photoresistor', 'photocell', 'brightness', 'lux', 'dark', 'day night', 'sensor'],
    volts: '3.3–5 V',
    specs: ['LDR over a 10 kΩ resistor', 'About 50 kΩ at 10 lux', 'Digital output flips at the trimmer threshold'],
    pins: { AO: 'Analog output: lower in bright light', DO: 'Digital output: high in the dark' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'AO', to: 'A0' }],
    code: 'int light = analogRead(A0);',
  },
  'ntc-temperature-sensor': {
    summary: 'A thermistor module that reads temperature as a voltage.',
    tags: ['temperature', 'temp', 'thermistor', 'ntc', 'heat', 'thermometer', 'analog', 'sensor'],
    volts: '5 V',
    specs: ['10 kΩ NTC, beta 3950', 'With a 10 kΩ partner resistor', 'Voltage falls as it warms'],
    pins: { OUT: 'Analog output' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'OUT', to: 'A0' }],
    code: 'float r = 10000.0 / (1023.0 / analogRead(A0) - 1);\nfloat c = 1 / (log(r / 10000) / 3950 + 1 / 298.15) - 273.15;',
  },
  'gas-sensor': {
    summary: 'An MQ-2 style module that senses smoke and flammable gas.',
    tags: ['gas', 'smoke', 'mq2', 'mq-2', 'lpg', 'methane', 'air quality', 'alarm', 'sensor'],
    volts: '5 V',
    specs: ['Analog output rises with gas', 'Digital output goes low above the threshold', 'A real one needs a minute to warm up'],
    pins: { AOUT: 'Analog output: higher with more gas', DOUT: 'Low when gas is over the threshold' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'AOUT', to: 'A0' }, { pin: 'DOUT', to: '2' }],
    code: 'int gas = analogRead(A0);',
  },
  'flame-sensor': {
    summary: 'An infrared module that sees the flicker of a flame.',
    tags: ['flame', 'fire', 'infrared', 'ir', 'alarm', 'sensor'],
    volts: '3.3–5 V',
    specs: ['Senses 760–1100 nm light', 'Digital output goes low when it sees a flame'],
    pins: { AOUT: 'Analog output: lower near a flame', DOUT: 'Low when a flame is seen' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'DOUT', to: '2' }],
    code: 'bool fire = digitalRead(2) == LOW;',
  },
  'big-sound-sensor': SOUND,
  'small-sound-sensor': { ...SOUND, summary: 'A small microphone module with loudness and threshold outputs.', tags: [...SOUND.tags, 'small'] },
  'pir-motion-sensor': {
    summary: 'A passive infrared sensor that sees people moving.',
    tags: ['pir', 'motion', 'movement', 'presence', 'hc-sr501', 'occupancy', 'security', 'infrared', 'sensor'],
    volts: '5 V',
    specs: ['Output goes high when it sees motion', 'Range up to about 7 m', 'Hold time set by a trimmer'],
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'OUT', to: '2' }],
    code: 'if (digitalRead(2)) { /* someone moved */ }',
  },
  'tilt-switch': {
    summary: 'A ball switch module that tells whether it is tilted.',
    tags: ['tilt', 'ball', 'orientation', 'angle', 'shake', 'sw-520d', 'sensor'],
    volts: '3.3–5 V',
    specs: ['Output goes high when tilted', 'Contacts chatter a little while moving'],
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'OUT', to: '2' }],
    code: 'bool tilted = digitalRead(2);',
  },
  'heart-beat-sensor': {
    summary: 'A pulse sensor that gives one short high pulse per heartbeat.',
    tags: ['heart', 'pulse', 'bpm', 'heartbeat', 'heart rate', 'health', 'sensor'],
    volts: '3.3–5 V',
    specs: ['A 100 ms high pulse on each beat', 'Count pulses over time for beats per minute'],
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'OUT', to: '2' }],
    code: 'attachInterrupt(digitalPinToInterrupt(2), beat, RISING);',
  },
  'hc-sr04': {
    summary: 'An ultrasonic sonar that measures distance from 2 cm to 4 m.',
    tags: ['ultrasonic', 'distance', 'sonar', 'range', 'proximity', 'hc-sr04', 'echo', 'obstacle', 'sensor'],
    volts: '5 V',
    specs: ['A 10 µs pulse on TRIG starts a reading', 'ECHO stays high for the round trip', 'Distance in cm = echo µs / 58', 'Range 2 cm to 4 m, 15° cone'],
    pins: { TRIG: 'Trigger: a 10 µs high pulse starts a reading', ECHO: 'Echo: high for the sound\'s round trip' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'TRIG', to: '9' }, { pin: 'ECHO', to: '10' }],
    code: 'digitalWrite(9, HIGH); delayMicroseconds(10); digitalWrite(9, LOW);\nlong cm = pulseIn(10, HIGH) / 58;',
  },
  dht22: {
    summary: 'A digital temperature and humidity sensor on one data wire.',
    tags: ['temperature', 'temp', 'humidity', 'weather', 'dht', 'am2302', 'climate', 'thermometer', 'hygrometer', 'sensor'],
    volts: '3.3–5 V',
    specs: ['−40 to 80 °C, ±0.5 °C', '0–100 % humidity, ±2 %', 'One reading every 2 seconds at most', 'Needs a 10 kΩ pull-up on data'],
    pins: { SDA: 'Data (one-wire protocol, not I2C)', NC: 'Not connected' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'SDA', to: '2' }, { pin: 'GND', to: 'GND' }],
    code: '#include <DHT.h>\nDHT dht(2, DHT22); dht.begin();\nfloat t = dht.readTemperature(), h = dht.readHumidity();',
  },
  'ir-receiver': {
    summary: 'Receives button codes from an infrared remote control.',
    tags: ['infrared', 'ir', 'remote', 'receiver', 'vs1838b', 'tsop', 'nec', 'sensor'],
    volts: '3.3–5 V',
    specs: ['Demodulates 38 kHz infrared', 'Output is low while a burst arrives', 'Decode with the IRremote library'],
    pins: { DAT: 'Demodulated data, idles high' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'DAT', to: '2' }],
    code: '#include <IRremote.hpp>\nIrReceiver.begin(2);\nif (IrReceiver.decode()) { IrReceiver.resume(); }',
  },
  'ir-remote': {
    summary: 'A handheld infrared remote. Press its keys to send NEC codes.',
    tags: ['remote', 'infrared', 'ir', 'controller', 'tv', 'nec', 'buttons', 'transmitter'],
    volts: 'battery',
    specs: ['Sends NEC codes on 38 kHz', 'No wires: an infrared receiver in the circuit hears it'],
  },
  hx711: {
    summary: 'A 24-bit amplifier for load cells, for weighing things.',
    tags: ['scale', 'weight', 'load cell', 'hx711', 'force', 'adc', 'strain gauge', 'sensor'],
    volts: '2.7–5 V',
    specs: ['24-bit ADC, gain 128 on channel A', 'Read by clocking 25 pulses on SCK', '10 or 80 readings a second'],
    pins: { DT: 'Data out, low when a reading is ready', SCK: 'Clock from the board' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'DT', to: '3' }, { pin: 'SCK', to: '2' }],
    code: '#include <HX711.h>\nHX711 s; s.begin(3, 2);\nlong raw = s.read();',
  },
  'rotary-dialer': {
    summary: 'An old telephone dial: it sends one pulse per number dialled.',
    tags: ['dial', 'phone', 'telephone', 'rotary', 'pulse', 'retro', 'number', 'input'],
    volts: 'any',
    specs: ['DIAL closes while the dial is turning', 'PULSE gives one pulse per count', 'Dialling 0 gives 10 pulses'],
    pins: { DIAL: 'Closed to GND while the dial is away from rest', PULSE: 'One pulse per count' },
    wiring: [{ pin: 'GND', to: 'GND' }, { pin: 'DIAL', to: '2' }, { pin: 'PULSE', to: '3' }],
    code: 'pinMode(3, INPUT_PULLUP);  // count falling edges while pin 2 is low',
  },
  mpu6050: {
    summary: 'A 6-axis accelerometer and gyroscope on I2C.',
    tags: ['accelerometer', 'gyroscope', 'gyro', 'imu', 'mpu6050', 'gy-521', 'tilt', 'orientation', 'motion', 'i2c', 'sensor'],
    volts: '3.3–5 V (module)',
    specs: ['3-axis accelerometer up to ±16 g', '3-axis gyroscope up to ±2000 °/s', 'I2C address 0x68, or 0x69 with AD0 high', 'Built-in temperature sensor'],
    pins: { AD0: 'Address select: low 0x68, high 0x69', INT: 'Data-ready interrupt', XDA: 'Auxiliary I2C data (for a compass)', XCL: 'Auxiliary I2C clock' },
    wiring: [{ pin: 'VCC', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'SDA', to: 'A4' }, { pin: 'SCL', to: 'A5' }],
    code: '#include <Wire.h>\nWire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0); Wire.endTransmission();',
  },

  // ---------- modules ----------
  ds1307: {
    summary: 'A real-time clock that keeps the date and time on I2C.',
    tags: ['rtc', 'clock', 'time', 'date', 'calendar', 'ds1307', 'tiny rtc', 'i2c', 'module'],
    volts: '5 V',
    specs: ['Seconds to years, leap years included', 'I2C address 0x68', '56 bytes of battery-backed RAM', 'Square-wave output on SQW'],
    pins: { '5V': '5 V supply', SQW: 'Square-wave output (1 Hz and up)' },
    wiring: [{ pin: '5V', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'SDA', to: 'A4' }, { pin: 'SCL', to: 'A5' }],
    code: '#include <RTClib.h>\nRTC_DS1307 rtc; rtc.begin();\nDateTime now = rtc.now();',
  },

  // ---------- displays ----------
  lcd1602: {
    summary: 'A 16x2 character LCD, wired in parallel or through an I2C backpack.',
    tags: ['lcd', 'display', 'screen', 'character', 'text', 'hd44780', '1602', '16x2', 'i2c', 'liquidcrystal'],
    volts: '5 V',
    specs: ['Two lines of 16 characters', 'HD44780 controller, 4-bit or 8-bit', 'I2C backpack at address 0x27', 'Up to 8 custom characters'],
    pins: LCD_PINS, wiring: LCD_WIRING,
    code: '#include <LiquidCrystal.h>\nLiquidCrystal lcd(12, 11, 5, 4, 3, 2);\nlcd.begin(16, 2); lcd.print("Hello");',
  },
  lcd2004: {
    summary: 'A 20x4 character LCD, wired in parallel or through an I2C backpack.',
    tags: ['lcd', 'display', 'screen', 'character', 'text', 'hd44780', '2004', '20x4', 'i2c', 'liquidcrystal'],
    volts: '5 V',
    specs: ['Four lines of 20 characters', 'HD44780 controller, 4-bit or 8-bit', 'I2C backpack at address 0x27'],
    pins: LCD_PINS, wiring: LCD_WIRING,
    code: '#include <LiquidCrystal.h>\nLiquidCrystal lcd(12, 11, 5, 4, 3, 2);\nlcd.begin(20, 4); lcd.print("Hello");',
  },
  ssd1306: {
    summary: 'A sharp 128x64 monochrome OLED screen on I2C.',
    tags: ['oled', 'display', 'screen', 'graphics', 'ssd1306', '128x64', '0.96', 'i2c', 'monochrome'],
    volts: '3.3–5 V (module)',
    specs: ['128 x 64 pixels, 0.96 inch', 'I2C address 0x3C', 'No backlight: each pixel glows', 'Works with Adafruit_SSD1306 and U8g2'],
    pins: { DATA: 'I2C data (SDA)', CLK: 'I2C clock (SCL)', DC: 'Data/command (SPI only)', RST: 'Reset', CS: 'Chip select (SPI only)', '3V3': '3.3 V out', VIN: 'Power in, 3.3–5 V' },
    wiring: [{ pin: 'VIN', to: '5V' }, { pin: 'GND', to: 'GND' }, { pin: 'DATA', to: 'A4' }, { pin: 'CLK', to: 'A5' }],
    code: '#include <Adafruit_SSD1306.h>\nAdafruit_SSD1306 oled(128, 64, &Wire);\noled.begin(SSD1306_SWITCHCAPVCC, 0x3C);',
  },
  neopixel: {
    ...PIXELS('One addressable RGB LED that holds any colour you send it.', ['single'], []),
    pins: { VDD: '5 V supply', VSS: 'Ground', DIN: 'Data in from the board', DOUT: 'Data out to the next LED' },
    wiring: [{ pin: 'VDD', to: '5V' }, { pin: 'VSS', to: 'GND' }, { pin: 'DIN', to: '6', via: '330 Ω resistor' }],
  },
  'led-ring': PIXELS('A ring of addressable RGB LEDs.', ['ring', 'circle', 'clock'], ['Common sizes: 12, 16, 24 LEDs']),
  'neopixel-matrix': PIXELS('A grid of addressable RGB LEDs, for pictures and text.', ['matrix', 'grid', 'panel', '8x8'], ['Rows and columns are settings']),
  ...moreCatalogInfo,
};

/** What a pin is for: the part's own words, or the usual meaning of its name. */
export function pinMeaning(type: string, pin: string): string {
  const own = Object.hasOwn(catalogInfo, type) ? catalogInfo[type].pins : undefined;
  if (own && Object.hasOwn(own, pin)) return own[pin];
  const name = pin.toUpperCase().replace(/\.\d+$/, '');
  return Object.hasOwn(COMMON, name) ? COMMON[name] : '';
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9.+]+/).filter((w) => w.length > 0);

/** The written info for a part, or a plain one made from its name. */
export function infoFor(e: SearchEntry): PartInfo {
  if (Object.hasOwn(catalogInfo, e.type)) return catalogInfo[e.type];
  return { summary: `${e.label}. ${e.group}.`, tags: [...new Set([...words(e.label), ...words(e.type.replace(/-/g, ' '))])], specs: [] };
}

// ---------- search ----------
// Each part is indexed once: the words of its name, type, tags, group and
// description, each with a weight. A query matches when every one of its words
// matches some indexed word, exactly, as a prefix, inside it, or with one typo.
interface Indexed { e: SearchEntry; label: string; words: { w: string; weight: number }[] }
const indexCache = new Map<string, Indexed>();

function index(e: SearchEntry): Indexed {
  const key = `${e.type}\u0000${e.label}\u0000${e.group}`;
  let x = indexCache.get(key);
  if (x) { x.e = e; return x; }
  const info = infoFor(e);
  const best = new Map<string, number>();
  const add = (text: string, weight: number) => { for (const w of words(text)) best.set(w, Math.max(best.get(w) ?? 0, weight)); };
  add(info.summary, 2); add(e.group, 3); for (const t of info.tags) { add(t, 6); best.set(t.toLowerCase(), Math.max(best.get(t.toLowerCase()) ?? 0, 6)); }
  add(e.type.replace(/-/g, ' '), 8); best.set(e.type.toLowerCase(), 8); add(e.label, 10);
  x = { e, label: e.label.toLowerCase(), words: [...best].map(([w, weight]) => ({ w, weight })) };
  if (indexCache.size > 5000) indexCache.clear();
  indexCache.set(key, x);
  return x;
}

/** True when a and b differ by one letter added, dropped, changed or swapped. */
function oneTypo(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function score(x: Indexed, token: string): number {
  let s = 0;
  for (const { w, weight } of x.words) {
    if (w === token) s = Math.max(s, weight * 3);
    else if (w.startsWith(token)) s = Math.max(s, weight * 2);
    else if (token.length >= 3 && w.includes(token)) s = Math.max(s, weight);
  }
  if (s === 0 && token.length >= 5) for (const { w, weight } of x.words) if (oneTypo(token, w)) s = Math.max(s, weight * 0.8);
  return s;
}

/** The entries that match a query, best first. An empty query gives them all, in order. */
export function searchCatalog<T extends SearchEntry>(entries: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  const tokens = words(q);
  if (!tokens.length) return entries.slice();
  const hits: { e: T; s: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const x = index(e);
    let total = 0;
    for (const t of tokens) { const s = score(x, t); if (!s) return; total += s; }
    if (x.label === q) total += 100; else if (x.label.startsWith(q)) total += 30;
    hits.push({ e, s: total, i });
  });
  return hits.sort((a, b) => b.s - a.s || a.i - b.i).map((h) => h.e);
}
