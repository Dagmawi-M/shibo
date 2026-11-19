// Sensor modules whose outputs follow the sliders directly: an analog voltage,
// a comparator output, or a contact.
import type { PartDef } from '../part.ts';
import { above, clamp, knob, module, range, toggle, ui } from './sensors-kit.ts';

// MQ-135 on a module with a 10 k load resistor, using the CO2 curve most
// MQ-135 libraries use: ppm = 116.6 * (Rs/R0)^-2.769, R0 = 76.63 k.
const mq135Volts = (ppm: number) => { const rs = 76.63e3 * Math.pow(Math.max(ppm, 1) / 116.6020682, -1 / 2.769034857); return (5 * 10e3) / (rs + 10e3); };
// A force-sensitive resistor (Interlink 402: about 30 k at 20 g, 6 k at 100 g, 600 R at 1 kg) to 5 V, with 10 k to ground.
const fsrVolts = (g: number) => (g <= 0 ? 0 : (5 * 10e3) / (600e3 / g + 10e3));
// A 2.2" flex sensor (25 k flat, about 100 k at 90 degrees) to 5 V, with 47 k to ground.
const flexVolts = (deg: number) => (5 * 47e3) / (25e3 + (Math.max(0, deg) * 75e3) / 90 + 47e3);
// A 49E linear Hall sensor: half the supply with no field, 1.4 mV per gauss (14 mV per mT), swinging 0.86 V to 4.21 V.
const hallVolts = (mT: number) => clamp(2.5 + 0.014 * mT, 0.86, 4.21);

const FIELD = range(-100, 100, 0, 'Magnetic field (+ is south pole)', 'mT');

const reed: PartDef = {
  contact: true, type: 'reed-switch', pins: ['1', '2'],
  ui: ui('reed-switch', 'Reed switch'),
  controls: { magnet: toggle('Magnet near') },
  links: (id, s) => (s.magnet ? [{ a: `${id}:1`, b: `${id}:2`, kind: 'wire' }] : []),
};

// The SW-520D: the ball rests across the two leads while it stands upright, and rolls off when tilted.
const tiltBall: PartDef = {
  contact: true, type: 'tilt-ball-switch', pins: ['1', '2'],
  ui: ui('tilt-ball-switch', 'Tilt ball switch (SW-520D)'),
  controls: { tilted: toggle('Tilted') },
  links: (id, s) => (s.tilted ? [] : [{ a: `${id}:1`, b: `${id}:2`, kind: 'wire' }]),
};

export const sensorsAnalog: PartDef[] = [
  module({ type: 'lm35', label: 'Temperature sensor (LM35)', pins: ['VCC', 'OUT', 'GND'],
    controls: { temperature: range(-55, 150, 25, 'Temperature', '°C', 0.1) },
    // 10 mV per degree. Wired the usual way, with no negative supply, it cannot go below 0 V.
    analog: { OUT: (s) => Math.max(0, s.temperature * 0.01) } }),
  module({ type: 'tmp36', label: 'Temperature sensor (TMP36)', pins: ['VCC', 'OUT', 'GND'],
    controls: { temperature: range(-40, 125, 25, 'Temperature', '°C', 0.1) },
    analog: { OUT: (s) => 0.5 + s.temperature * 0.01 } }),
  module({ type: 'uv-sensor', label: 'UV light sensor (GUVA-S12SD)', pins: ['GND', 'VCC', 'SIG'],
    controls: { uv: range(0, 12, 0, 'UV index', '', 0.1) },
    // The module's amplifier gives roughly 0.1 V per UV index point.
    analog: { SIG: (s) => s.uv * 0.1 } }),
  module({ type: 'rain-sensor', label: 'Rain sensor', pins: ['VCC', 'GND', 'DO', 'AO'],
    controls: { wet: range(0, 100, 0, 'Water on the plate', '%'), threshold: knob() },
    // Dry, the plate is open and AO sits near the supply; water pulls it down. DO goes low when wet.
    analog: { AO: (s) => 5 * (1 - 0.75 * s.wet / 100) }, digital: { DO: (s) => above(5 * (1 - 0.75 * s.wet / 100), s) } }),
  module({ type: 'soil-moisture', label: 'Soil moisture sensor', pins: ['VCC', 'GND', 'DO', 'AO'],
    controls: { moisture: range(0, 100, 0, 'Soil moisture', '%'), threshold: knob() },
    analog: { AO: (s) => 5 * (1 - 0.7 * s.moisture / 100) }, digital: { DO: (s) => above(5 * (1 - 0.7 * s.moisture / 100), s) } }),
  module({ type: 'soil-moisture-capacitive', label: 'Soil moisture sensor (capacitive)', pins: ['GND', 'VCC', 'AOUT'],
    controls: { moisture: range(0, 100, 0, 'Soil moisture', '%') },
    // About 2.55 V in dry air and 1.25 V in water on a 5 V supply.
    analog: { AOUT: (s) => 2.55 - 1.3 * s.moisture / 100 } }),
  module({ type: 'water-level', label: 'Water level sensor', pins: ['SIG', 'VCC', 'GND'],
    controls: { depth: range(0, 40, 0, 'Water depth on the strip', 'mm') },
    // 0 V dry; rises steeply as the first traces get wet, then flattens toward about 3.4 V.
    analog: { SIG: (s) => 3.4 * Math.sqrt(clamp(s.depth, 0, 40) / 40) } }),
  module({ type: 'mq135', label: 'Air quality sensor (MQ-135)', pins: ['AOUT', 'DOUT', 'GND', 'VCC'],
    controls: { ppm: { kind: 'range', min: 10, max: 10000, initial: 400, log: true, label: 'CO2 equivalent', unit: 'ppm' }, threshold: knob(30) },
    // DOUT goes low when the gas reading rises past the knob, like the MQ-2 style modules.
    analog: { AOUT: (s) => mq135Volts(s.ppm) }, digital: { DOUT: (s) => (above(mq135Volts(s.ppm), s) ? 0 : 1) } }),
  module({ type: 'ir-obstacle', label: 'IR obstacle sensor', pins: ['OUT', 'GND', 'VCC'],
    controls: { distance: range(0, 60, 60, 'Obstacle distance', 'cm'), reach: range(2, 30, 10, 'Range knob', 'cm') },
    // OUT goes low (and the green LED lights) while something is within range.
    digital: { OUT: (s) => (s.distance <= s.reach ? 0 : 1) } }),
  module({ type: 'line-sensor', label: 'Line tracker (TCRT5000)', pins: ['VCC', 'GND', 'DO', 'AO'],
    controls: { reflect: range(0, 100, 100, 'Surface brightness (0 black, 100 white)', '%'), threshold: knob() },
    // A white surface reflects the infrared and pulls AO low; over a black line AO is high and DO goes high.
    analog: { AO: (s) => 0.3 + 4.4 * (1 - s.reflect / 100) }, digital: { DO: (s) => above(0.3 + 4.4 * (1 - s.reflect / 100), s) } }),
  module({ type: 'hall-sensor', label: 'Hall sensor, digital (KY-003)', pins: ['GND', 'VCC', 'S'],
    controls: { field: FIELD },
    // An A3144 switch with a pull-up: S goes low near a south pole stronger than about 15 mT.
    digital: { S: (s) => (s.field >= 15 ? 0 : 1) } }),
  module({ type: 'hall-analog', label: 'Hall sensor, analog (49E)', pins: ['GND', 'VCC', 'SIG'],
    controls: { field: FIELD }, analog: { SIG: (s) => hallVolts(s.field) } }),
  module({ type: 'hall-module', label: 'Hall sensor module (KY-024)', pins: ['AO', 'GND', 'VCC', 'DO'],
    controls: { field: FIELD, threshold: knob(60) },
    analog: { AO: (s) => hallVolts(s.field) }, digital: { DO: (s) => above(hallVolts(s.field), s) } }),
  reed, tiltBall,
  module({ type: 'force-sensor', label: 'Force sensor (FSR)', pins: ['VCC', 'GND', 'SIG'],
    controls: { force: range(0, 1000, 0, 'Force', 'g') },
    analog: { SIG: (s) => fsrVolts(s.force) } }),
  module({ type: 'flex-sensor', label: 'Flex sensor', pins: ['VCC', 'GND', 'SIG'],
    controls: { bend: range(0, 180, 0, 'Bend', '°') },
    analog: { SIG: (s) => flexVolts(s.bend) } }),
  module({ type: 'voltage-sensor', label: 'Voltage sensor (0-25 V)', pins: ['VCC', 'GND', 'S', '+', '-'],
    controls: { volts: range(0, 25, 0, 'Voltage on the input terminals', 'V', 0.01) },
    // 30 k over 7.5 k: S is a fifth of the input. GND and - are the same copper.
    passive: true, gnd: '-', joined: [['GND', '-']],
    analog: { S: (s) => s.volts / 5 } }),
];

export const testing = { mq135Volts, fsrVolts, flexVolts, hallVolts };
