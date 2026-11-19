// Writes a starter sketch from a circuit: one named constant per wired pin,
// the right pinMode for each, and a loop that shows the wiring is alive.
import { canonicalPin, isBoard, type Project } from './project.ts';

type Kind = 'out' | 'in' | 'pullup' | 'analog';
interface Role { pins: string[]; kind: Kind; suffix?: string }

const one = (pin: string, kind: Kind): Role[] => [{ pins: [pin], kind }];
const each = (pins: string[], kind: Kind): Role[] => pins.map((p) => ({ pins: [p], kind, suffix: p }));
const BUTTON: Role[] = [{ pins: ['1.l', '1.r', '2.l', '2.r'], kind: 'pullup' }];
const AO_DO: Role[] = [{ pins: ['AOUT'], kind: 'analog', suffix: 'AOUT' }, { pins: ['DOUT'], kind: 'in', suffix: 'DOUT' }];

/** What each part's pins are to a sketch. A part not listed here needs no pin setup. */
const ROLES: Record<string, Role[]> = {
  led: one('A', 'out'), 'rgb-led': each(['R', 'G', 'B'], 'out'), buzzer: [{ pins: ['1', '2'], kind: 'out' }],
  'led-bar-graph': each(Array.from({ length: 10 }, (_, i) => `A${i + 1}`), 'out'), '7segment': each(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'], 'out'),
  pushbutton: BUTTON, 'pushbutton-6mm': BUTTON, 'slide-switch': one('2', 'pullup'),
  'dip-switch-8': each(Array.from({ length: 8 }, (_, i) => `${i + 1}a`), 'pullup'),
  potentiometer: one('SIG', 'analog'), 'slide-potentiometer': one('SIG', 'analog'),
  'analog-joystick': [{ pins: ['HORZ'], kind: 'analog', suffix: 'HORZ' }, { pins: ['VERT'], kind: 'analog', suffix: 'VERT' }, { pins: ['SEL'], kind: 'pullup', suffix: 'SEL' }],
  'ky-040': [{ pins: ['CLK'], kind: 'in', suffix: 'CLK' }, { pins: ['DT'], kind: 'in', suffix: 'DT' }, { pins: ['SW'], kind: 'pullup', suffix: 'SW' }],
  'photoresistor-sensor': [{ pins: ['AO'], kind: 'analog', suffix: 'AO' }, { pins: ['DO'], kind: 'in', suffix: 'DO' }],
  'ntc-temperature-sensor': one('OUT', 'analog'), 'gas-sensor': AO_DO, 'flame-sensor': AO_DO, 'big-sound-sensor': AO_DO, 'small-sound-sensor': AO_DO,
  'pir-motion-sensor': one('OUT', 'in'), 'tilt-switch': one('OUT', 'in'), 'heart-beat-sensor': one('OUT', 'in'),
  'ks2e-m-dc5': [{ pins: ['COIL1', 'COIL2'], kind: 'out' }],
  servo: one('PWM', 'out'), 'hc-sr04': [{ pins: ['TRIG'], kind: 'out', suffix: 'TRIG' }, { pins: ['ECHO'], kind: 'in', suffix: 'ECHO' }],
  dht22: one('SDA', 'in'), 'ir-receiver': one('DAT', 'in'), neopixel: one('DIN', 'out'), 'led-ring': one('DIN', 'out'), 'neopixel-matrix': one('DIN', 'out'),
  'stepper-motor': each(['A-', 'A+', 'B+', 'B-'], 'out'),
};
const POWER = /^(GND|5V|3\.3V|VIN|AREF|IOREF|RESET)$/;

export function generateSketch(project: Project): string {
  // Group pins that are joined by wires; a resistor in the way still counts as joined.
  const parent = new Map<string, string>();
  const find = (x: string): string => { if (!parent.has(x)) parent.set(x, x); let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const types = new Map(project.parts.map((p) => [p.id, p.type]));
  const node = (ref: string): string => { const i = ref.indexOf(':'), id = ref.slice(0, i); return `${id}:${canonicalPin(types.get(id) ?? '', ref.slice(i + 1)) ?? ref.slice(i + 1)}`; };
  for (const w of project.wires) parent.set(find(node(w.from)), find(node(w.to)));
  for (const p of project.parts) if (p.type === 'resistor') parent.set(find(`${p.id}:1`), find(`${p.id}:2`));

  const board = project.parts.find((p) => isBoard(p.type));
  const boardPin = new Map<string, string>();          // group -> the board's signal pin on it
  if (board) for (const key of [...parent.keys()]) {
    const [id, pin] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (id === board.id && !POWER.test(pin)) boardPin.set(find(key), pin);
  }

  const pins: { name: string; pin: string; kind: Kind }[] = [];
  for (const p of project.parts) {
    const roles = Object.hasOwn(ROLES, p.type) ? ROLES[p.type] : [];
    for (const role of roles) {
      const on = role.pins.map((x) => boardPin.get(find(`${p.id}:${x}`))).find(Boolean);
      if (!on) continue;
      const name = `${p.id}${role.suffix ? '_' + role.suffix : ''}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      pins.push({ name, pin: on, kind: role.kind });
    }
  }

  const outs = pins.filter((p) => p.kind === 'out'), ins = pins.filter((p) => p.kind !== 'out');
  const lines: string[] = ['// Starter sketch written by Shibo from your wiring. Change it freely.', ''];
  for (const p of pins) lines.push(`const int ${p.name} = ${p.pin};`);
  if (pins.length) lines.push('');
  lines.push('void setup() {', '  Serial.begin(9600);');
  for (const p of pins) if (p.kind !== 'analog') lines.push(`  pinMode(${p.name}, ${p.kind === 'out' ? 'OUTPUT' : p.kind === 'pullup' ? 'INPUT_PULLUP' : 'INPUT'});`);
  lines.push('}', '', 'void loop() {');
  if (outs.length) {
    lines.push('  // Outputs blink so you can see they are wired.', '  bool on = (millis() / 500) % 2;');
    for (const p of outs) lines.push(`  digitalWrite(${p.name}, on);`);
  }
  if (ins.length) {
    lines.push('  // Inputs are printed five times a second.');
    ins.forEach((p, i) => lines.push(`  Serial.print("${i ? ' ' : ''}${p.name}="); Serial.print(${p.kind === 'analog' ? 'analogRead' : 'digitalRead'}(${p.name}));`));
    lines.push('  Serial.println();');
  }
  if (!pins.length) lines.push('  // Nothing is wired to the board yet.');
  lines.push('  delay(200);', '}', '');
  return lines.join('\n');
}
