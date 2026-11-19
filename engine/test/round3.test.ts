// Rotate, rename, wire colour, templates in place, wiring checks and the wiring guide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addPart, addWire, rotatePart, renamePart, setWireColor } from '../src/edit.ts';
import { parseProject, importWokwi, validate, type Project } from '../src/project.ts';
import { generateGuide } from '../src/guide.ts';
import { templates } from '../src/templates.ts';
import { Session, type OutMsg } from '../src/session.ts';
import { rig } from './helpers/rig.ts';
import { fw } from './helpers/fw.ts';

const hex = readFileSync(new URL('./fixtures/toggle.hex', import.meta.url), 'utf8');
const empty = (): Project => ({ version: 1, parts: [], wires: [], boards: [] });
const blink = () => structuredClone(templates.find((t) => t.id === 'blink')!.project);
function session(opts: any = {}) {
  const s = new Session({ build: async () => ({ ok: true, log: '', hex }), ...opts }); const out: OutMsg[] = [];
  s.onMessage((m) => out.push(m));
  const last = <T extends OutMsg['t']>(t: T) => out.filter((m) => m.t === t).at(-1) as Extract<OutMsg, { t: T }> | undefined;
  return { s, out, last };
}

test('rotatePart turns a part a quarter turn at a time, and the file keeps it', () => {
  let p = addPart(empty(), 'led', 0, 0).project;
  p = rotatePart(p, 'led1'); assert.equal(p.parts[0].rot, 90);
  p = rotatePart(rotatePart(rotatePart(p, 'led1'), 'led1'), 'led1'); assert.equal(p.parts[0].rot ?? 0, 0);
  assert.equal(parseProject({ ...empty(), parts: [{ id: 'a', type: 'led', x: 0, y: 0, rot: 270 }] }, 'x').parts[0].rot, 270);
  assert.equal(parseProject({ ...empty(), parts: [{ id: 'a', type: 'led', x: 0, y: 0, rot: 45 }] }, 'x').parts[0].rot, undefined);
  assert.equal(importWokwi({ parts: [{ type: 'wokwi-led', id: 'a', top: 0, left: 0, rotate: 90 }], connections: [] }).project.parts[0].rot, 90);
});

test('renamePart carries its wires and board entry along, and refuses bad or taken names', () => {
  const p = blink();
  const q = renamePart(p, 'led1', 'power-light');
  assert.ok(q.wires.some((w) => w.to === 'power-light:A' || w.from === 'power-light:A'));
  assert.ok(!JSON.stringify(q).includes('led1'));
  assert.deepEqual(validate(q), []);
  assert.equal(renamePart(p, 'uno1', 'main').boards[0].part, 'main');
  assert.throws(() => renamePart(p, 'led1', 'uno1'), /already/);
  for (const bad of ['', 'a:b', '9lives', 'has space', '<b>']) assert.throws(() => renamePart(p, 'led1', bad), /name/, bad);
  assert.equal(renamePart(p, 'led1', 'led1'), p);
});

test('setWireColor changes one wire and accepts only plain colours', () => {
  const p = blink();
  assert.equal(setWireColor(p, 0, 'orange').wires[0].color, 'orange');
  assert.equal(setWireColor(p, 0, '#ff8800').wires[0].color, '#ff8800');
  assert.throws(() => setWireColor(p, 0, 'red;background:url(x)'), /colour/);
  assert.throws(() => setWireColor(p, 99, 'red'), /99/);
});

test('a template can be dropped into an empty folder: circuit and sketch, without overwriting', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-3-')); const { s, last, out } = session();
  await s.handle({ t: 'open', dir });
  assert.ok(last('project')!.templates.length >= 4);
  await s.handle({ t: 'template', id: 'button' });
  assert.equal(last('project')!.project.parts.length, 4);
  assert.equal(last('project')!.canUndo, true);
  const ino = path.join(dir, `${path.basename(dir)}.ino`);
  assert.match(readFileSync(ino, 'utf8'), /INPUT_PULLUP/);
  assert.equal(last('sketchCreated')!.path, ino);
  writeFileSync(ino, '// mine');
  await s.handle({ t: 'template', id: 'blink' });
  assert.equal(readFileSync(ino, 'utf8'), '// mine', 'an existing sketch is never replaced');
  assert.equal(last('project')!.project.parts.length, 3);
  await s.handle({ t: 'template', id: 'nope' });
  assert.match(out.filter((m) => m.t === 'error').at(-1)!.message, /template/);
});

test('an LED lit with no resistor in its path is called out; with one it is not', () => {
  const bare = rig([{ id: 'd', type: 'led' }], [['u:13', 'd:A'], ['d:C', 'u:GND']]);
  bare.set('13', 1);
  assert.ok(bare.circuit.warnings().some((w) => /d\b/.test(w) && /resistor/.test(w)), JSON.stringify(bare.circuit.warnings()));
  bare.set('13', 0);
  assert.equal(bare.circuit.warnings().length, 1, 'the warning stays once seen, even while the LED is off');
  const ok = rig([{ id: 'd', type: 'led' }, { id: 'r', type: 'resistor' }], [['u:13', 'r:1'], ['r:2', 'd:A'], ['d:C', 'u:GND']]);
  ok.set('13', 1);
  assert.equal(ok.out('d').lit, true); assert.deepEqual(ok.circuit.warnings(), []);
  const rgb = rig([{ id: 'l', type: 'rgb-led' }], [['u:3', 'l:R'], ['l:COM', 'u:GND']]);
  rgb.set('3', 1);
  assert.ok(rgb.circuit.warnings().some((w) => /resistor/.test(w)));
});

test('a relay coil driven straight from a board pin is called out', () => {
  const r = rig([{ id: 'k', type: 'ks2e-m-dc5' }], [['u:7', 'k:COIL1'], ['k:COIL2', 'u:GND']]);
  r.set('7', 1);
  assert.ok(r.circuit.warnings().some((w) => /k\b/.test(w) && /transistor/.test(w)), JSON.stringify(r.circuit.warnings()));
});

test('a button on a plain INPUT pin is reported as floating; INPUT_PULLUP is not', async () => {
  const wires: [string, string][] = [['b:1.l', 'u:2'], ['b:2.r', 'u:GND']];
  const bad = await fw('void setup() { pinMode(2, INPUT); } void loop() {}', [{ id: 'b', type: 'pushbutton' }], wires);
  bad.run(200); bad.circuit.audit();
  assert.ok(bad.circuit.warnings().some((w) => /pin 2/.test(w) && /floating/.test(w) && /INPUT_PULLUP/.test(w)), JSON.stringify(bad.circuit.warnings()));
  const good = await fw('void setup() { pinMode(2, INPUT_PULLUP); } void loop() {}', [{ id: 'b', type: 'pushbutton' }], wires);
  good.run(200); good.circuit.audit();
  assert.deepEqual(good.circuit.warnings(), []);
  const early = await fw('void setup() { pinMode(2, INPUT_PULLUP); } void loop() {}', [{ id: 'b', type: 'pushbutton' }], wires);
  early.circuit.audit();
  assert.deepEqual(early.circuit.warnings(), [], 'not judged before the sketch has had time to set its pins');
});

test('warnings reach the page as problems during a run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-3-')); const { s, last } = session();
  await s.handle({ t: 'open', dir });
  for (const a of [['uno', 0, 0], ['led', 100, 0], ['pushbutton', 200, 0]]) await s.handle({ t: 'edit', op: 'addPart', args: a });
  for (const [a, b] of [['uno1:13', 'led1:A'], ['led1:C', 'uno1:GND.1'], ['pushbutton1:1.l', 'uno1:2'], ['pushbutton1:2.r', 'uno1:GND.2']]) await s.handle({ t: 'edit', op: 'addWire', args: [a, b] });
  await s.handle({ t: 'start' });
  for (let i = 0; i < 6; i++) s.tick(50);
  await s.handle({ t: 'control', part: 'pushbutton1', name: 'pressed', value: 1 });
  for (let i = 0; i < 4; i++) s.tick(50);
  assert.ok(last('problems')!.items.some((x) => /led1/.test(x) && /resistor/.test(x)), JSON.stringify(last('problems')));
  s.dispose();
});

test('the wiring guide lists parts and every connection, and escapes what it prints', () => {
  const p = renamePart(blink(), 'led1', 'lamp');
  const html = generateGuide(p, 'My <b>project</b>');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /My &lt;b&gt;project&lt;\/b&gt;/); assert.doesNotMatch(html, /<b>project/);
  assert.match(html, /Arduino Uno/); assert.match(html, /Resistor/);
  for (const w of p.wires) { assert.ok(html.includes(w.from.split(':')[1])); }
  assert.match(html, /lamp/);
  assert.equal((html.match(/<tr class="wire"/g) ?? []).length, p.wires.length);
  assert.doesNotMatch(html, /<script/i);
});

test('the session writes the guide into the project folder on request', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-3-')); const { s, last } = session();
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'template', id: 'blink' });
  await s.handle({ t: 'guide' });
  const file = path.join(dir, 'wiring-guide.html');
  assert.equal(last('guideCreated')!.path, file);
  assert.ok(existsSync(file) && readFileSync(file, 'utf8').includes('uno1'));
});

test('wiring mistakes found in a run stay listed after Stop, until the circuit changes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-3-')); const { s, last } = session({ build: async () => ({ ok: true, log: '', hex: readFileSync(new URL('./fixtures/blink.hex', import.meta.url), 'utf8') }) });
  await s.handle({ t: 'open', dir });
  for (const a of [['uno', 0, 0], ['led', 100, 0]]) await s.handle({ t: 'edit', op: 'addPart', args: a });
  for (const [a, b] of [['uno1:13', 'led1:A'], ['led1:C', 'uno1:GND.1']]) await s.handle({ t: 'edit', op: 'addWire', args: [a, b] });
  await s.handle({ t: 'start' });
  for (let i = 0; i < 4; i++) s.tick(50);
  await s.handle({ t: 'stop' });
  assert.ok(last('problems')!.items.some((x) => /resistor/.test(x)), 'still listed after Stop');
  await s.handle({ t: 'edit', op: 'movePart', args: ['led1', 120, 0] });
  assert.deepEqual(last('problems')!.items, [], 'cleared once the circuit is edited');
});
