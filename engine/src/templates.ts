// Starter projects: a sketch plus a circuit already wired for it.
import fs from 'node:fs';
import path from 'node:path';
import { addPart, addWire } from './edit.ts';
import type { Project } from './project.ts';

export interface Template { id: string; label: string; detail: string; sketch: string; project: Project }

function circuit(parts: [string, number, number][], wires: [string, string][]): Project {
  let p: Project = { version: 1, parts: [], wires: [], boards: [] };
  for (const [type, x, y] of parts) p = addPart(p, type, x, y).project;
  for (const [a, b] of wires) p = addWire(p, a, b);
  return p;
}
const LED_ON_13: [string, string][] = [['uno1:13', 'resistor1:2'], ['resistor1:1', 'led1:A'], ['led1:C', 'uno1:GND.1']];
const BOARD_LED: [string, number, number][] = [['uno', 0, 0], ['resistor', 160, -40], ['led', 120, -90]];

export const templates: Template[] = [
  { id: 'blink', label: 'Blink', detail: 'An LED that turns on and off. The first thing to try.',
    project: circuit(BOARD_LED, LED_ON_13),
    sketch: `// Blink: the LED on pin 13 turns on and off twice a second.
const int LED = 13;

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(LED, HIGH);
  Serial.println("on");
  delay(500);
  digitalWrite(LED, LOW);
  Serial.println("off");
  delay(500);
}
` },
  { id: 'button', label: 'Button and LED', detail: 'The LED is lit while you hold the button.',
    project: circuit([...BOARD_LED, ['pushbutton', 260, -100]], [...LED_ON_13, ['pushbutton1:1.l', 'uno1:2'], ['pushbutton1:2.r', 'uno1:GND.2']]),
    sketch: `// Button and LED: the LED is lit while the button is held.
// The button connects pin 2 to ground, so pressed reads LOW.
const int LED = 13, BUTTON = 2;

void setup() {
  pinMode(LED, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  Serial.begin(9600);
}

void loop() {
  bool pressed = digitalRead(BUTTON) == LOW;
  digitalWrite(LED, pressed);
  if (pressed) Serial.println("pressed");
  delay(20);
}
` },
  { id: 'light', label: 'Night light', detail: 'A light sensor turns the LED on when it gets dark.',
    project: circuit([...BOARD_LED, ['photoresistor-sensor', 330, 40]],
      [...LED_ON_13, ['photoresistor-sensor1:VCC', 'uno1:5V'], ['photoresistor-sensor1:GND', 'uno1:GND.2'], ['photoresistor-sensor1:AO', 'uno1:A0']]),
    sketch: `// Night light: the LED turns on when the light sensor reads dark.
// Move the "Light" slider under Sensor values to try it.
const int LED = 13, SENSOR = A0;
const int DARK = 600;   // readings above this count as dark (0 to 1023)

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  int reading = analogRead(SENSOR);
  digitalWrite(LED, reading > DARK);
  Serial.print("light sensor: ");
  Serial.println(reading);
  delay(100);
}
` },
  { id: 'empty', label: 'Empty', detail: 'Just the board and a sketch that prints a line. Build from here.',
    project: circuit([['uno', 0, 0]], []),
    sketch: `void setup() {
  Serial.begin(9600);
  Serial.println("Hello from Shibo");
}

void loop() {
}
` },
];

/** A folder name from what the user typed: lower-case words joined by dashes. */
export function folderName(name: string): string {
  if (typeof name !== 'string' || /[\\/\\\\]/.test(name) || name.trim().startsWith('.')) throw new Error('that name cannot be used for a folder');
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('give the project a name with at least one letter or digit');
  return slug.slice(0, 60);
}

/** Create `<parent>/<name>/` with a sketch and a circuit. Returns the new folder. Never overwrites. */
export function createProject(parent: string, name: string, templateId: string): string {
  const slug = folderName(name);
  const t = templates.find((x) => x.id === templateId);
  if (!t) throw new Error(`there is no template "${templateId}"`);
  const dir = path.join(parent, slug);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists; pick another name`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.ino`), t.sketch);
  fs.writeFileSync(path.join(dir, 'shibo.json'), JSON.stringify(t.project, null, 2) + '\n');
  return dir;
}
