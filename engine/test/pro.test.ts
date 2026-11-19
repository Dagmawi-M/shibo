// Undo, sketch generation from a circuit, and re-upload on save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session, type OutMsg } from '../src/session.ts';
import { generateSketch } from '../src/sketchgen.ts';
import { templates } from '../src/templates.ts';
import { buildUno } from '../src/build.ts';

const hex = readFileSync(new URL('./fixtures/toggle.hex', import.meta.url), 'utf8');
const dirWith = (files: Record<string, string> = {}) => { const d = mkdtempSync(path.join(tmpdir(), 'shibo-p-')); for (const [n, c] of Object.entries(files)) writeFileSync(path.join(d, n), c); return d; };
function session(opts: any = {}) {
  const s = new Session({ build: async () => ({ ok: true, log: '', hex }), ...opts }); const out: OutMsg[] = [];
  s.onMessage((m) => out.push(m));
  const last = <T extends OutMsg['t']>(t: T) => out.filter((m) => m.t === t).at(-1) as Extract<OutMsg, { t: T }> | undefined;
  return { s, out, last };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('undo and redo step through edits', async () => {
  const { s, last } = session();
  await s.handle({ t: 'open', dir: dirWith() });
  assert.deepEqual([last('project')!.canUndo, last('project')!.canRedo], [false, false]);
  await s.handle({ t: 'edit', op: 'addPart', args: ['uno', 0, 0] });
  await s.handle({ t: 'edit', op: 'addPart', args: ['led', 50, 50] });
  await s.handle({ t: 'edit', op: 'addWire', args: ['uno1:13', 'led1:A'] });
  assert.equal(last('project')!.project.wires.length, 1);
  await s.handle({ t: 'undo' });
  assert.equal(last('project')!.project.wires.length, 0);
  assert.deepEqual([last('project')!.canUndo, last('project')!.canRedo], [true, true]);
  await s.handle({ t: 'undo' });
  assert.equal(last('project')!.project.parts.length, 1);
  await s.handle({ t: 'redo' }); await s.handle({ t: 'redo' });
  assert.equal(last('project')!.project.wires.length, 1);
  assert.equal(last('project')!.canRedo, false);
  await s.handle({ t: 'undo' });
  await s.handle({ t: 'edit', op: 'addPart', args: ['buzzer', 0, 0] });
  assert.equal(last('project')!.canRedo, false, 'a new edit drops the redo history');
  const n = last('project')!.project.parts.length;
  await s.handle({ t: 'redo' });
  assert.equal(last('project')!.project.parts.length, n);
});

test('the project message says which sketch will be uploaded, or that there is none', async () => {
  const a = session(); await a.s.handle({ t: 'open', dir: dirWith() });
  assert.equal(a.last('project')!.sketch, null);
  const b = session(); await b.s.handle({ t: 'open', dir: dirWith({ 'thing.ino': 'void setup(){} void loop(){}' }) });
  assert.equal(b.last('project')!.sketch, 'thing.ino');
});

test('a circuit can be built with no sketch, and Run then says what to do', async () => {
  const { s, last } = session({ build: undefined });
  await s.handle({ t: 'open', dir: dirWith() });
  await s.handle({ t: 'edit', op: 'addPart', args: ['uno', 0, 0] });
  await s.handle({ t: 'start' });
  assert.match(last('error')!.message, /no sketch yet/i);
  assert.equal(last('status')!.state, 'idle');
});

test('generated sketch names the pins from the wiring', () => {
  const night = templates.find((t) => t.id === 'light')!.project;
  const code = generateSketch(night);
  assert.match(code, /const int LED1 = 13;/);
  assert.match(code, /const int PHOTORESISTOR_SENSOR1_AO = A0;/);
  assert.match(code, /pinMode\(LED1, OUTPUT\);/);
  assert.match(code, /analogRead\(PHOTORESISTOR_SENSOR1_AO\)/);
  const button = generateSketch(templates.find((t) => t.id === 'button')!.project);
  assert.match(button, /const int PUSHBUTTON1 = 2;/);
  assert.match(button, /pinMode\(PUSHBUTTON1, INPUT_PULLUP\);/);
  assert.match(generateSketch({ version: 1, parts: [], wires: [], boards: [] }), /void setup\(\)/);
});

test('createSketch writes a sketch from the circuit, never over an existing one, and it runs', async () => {
  const dir = dirWith(); const created: string[] = [];
  const s = new Session({ build: (d) => buildUno(d) }); const out: OutMsg[] = [];
  s.onMessage((m) => { out.push(m); if (m.t === 'sketchCreated') created.push(m.path); });
  await s.handle({ t: 'open', dir });
  for (const [type, x, y] of [['uno', 0, 0], ['resistor', 160, -40], ['led', 120, -90], ['pushbutton', 260, -100]] as const) await s.handle({ t: 'edit', op: 'addPart', args: [type, x, y] });
  for (const [a, b] of [['uno1:13', 'resistor1:2'], ['resistor1:1', 'led1:A'], ['led1:C', 'uno1:GND.1'], ['pushbutton1:1.l', 'uno1:2'], ['pushbutton1:2.r', 'uno1:GND.2']]) await s.handle({ t: 'edit', op: 'addWire', args: [a, b] });
  await s.handle({ t: 'createSketch' });
  const file = path.join(dir, `${path.basename(dir)}.ino`);
  assert.deepEqual(created, [file]);
  const code = readFileSync(file, 'utf8');
  assert.match(code, /const int LED1 = 13;/);
  assert.equal((out.filter((m) => m.t === 'project').at(-1) as any).sketch, path.basename(file));
  await s.handle({ t: 'createSketch' });
  assert.match((out.filter((m) => m.t === 'error').at(-1) as any).message, /already/);
  assert.equal(readFileSync(file, 'utf8'), code);

  await s.handle({ t: 'start' });
  assert.deepEqual(out.filter((m) => m.t === 'error').length, 1, 'only the "already" error; the generated sketch builds');
  for (let i = 0; i < 30; i++) s.tick(50);
  const lit = out.filter((m) => m.t === 'outputs').map((m: any) => m.outputs.led1?.lit);
  assert.ok(lit.includes(true) && lit.includes(false), 'the generated sketch blinks the LED so the wiring can be seen working');
  assert.match(out.filter((m) => m.t === 'serial').map((m: any) => m.text).join(''), /PUSHBUTTON1=1/);
  s.dispose();
});

test('saving the sketch while running uploads it again', async () => {
  const dir = dirWith({ 'x.ino': 'void setup(){} void loop(){}', 'diagram.json': JSON.stringify({ version: 1, parts: [{ type: 'wokwi-arduino-uno', id: 'uno', top: 0, left: 0 }], connections: [] }) });
  let builds = 0;
  const { s, out } = session({ build: async () => { builds++; return { ok: true, log: '', hex }; }, watch: true });
  await s.handle({ t: 'open', dir });
  writeFileSync(path.join(dir, 'x.ino'), '// edited while stopped\nvoid setup(){} void loop(){}');
  await sleep(700);
  assert.equal(builds, 0, 'nothing is uploaded while stopped');
  await s.handle({ t: 'start' });
  assert.equal(builds, 1);
  writeFileSync(path.join(dir, 'x.ino'), '// edited while running\nvoid setup(){} void loop(){}');
  await sleep(900);
  assert.equal(builds, 2);
  assert.equal((out.filter((m) => m.t === 'status').at(-1) as any).state, 'running');
  writeFileSync(path.join(dir, 'shibo.json.tmp'), 'x');
  await sleep(700);
  assert.equal(builds, 2, 'other files do not trigger an upload');
  s.dispose();
  writeFileSync(path.join(dir, 'x.ino'), '// after dispose');
  await sleep(600);
  assert.equal(builds, 2);
});
