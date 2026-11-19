import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importWokwi, validate, canonicalPin, type Project } from '../src/project.ts';
import { Circuit } from '../src/circuit.ts';
import { Engine } from '../src/engine.ts';
import type { ChipBackend, Level, PinDrive } from '../src/types.ts';

const starter = () => JSON.parse(readFileSync(new URL('./fixtures/starter/diagram.json', import.meta.url), 'utf8'));

function fakeBoard(id: string) {
  let drives: PinDrive[] = []; const cbs: (() => void)[] = []; const inputs: Record<string, Level> = {}; const analog: Record<string, number> = {};
  const b: ChipBackend = {
    id, runUntil() {}, drives: () => drives,
    setInput(p, l) { inputs[p] = l; }, setAnalog(p, v) { analog[p] = v; },
    onChange(cb) { cbs.push(cb); }, onSerial() {}, serialWrite() {}, saveState: () => null, restoreState() {},
  };
  return { b, inputs, analog, set(d: PinDrive[]) { drives = d; cbs.forEach((c) => c()); } };
}

const ledProject = (): Project => ({
  version: 1,
  parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'r', type: 'resistor', x: 0, y: 0 }, { id: 'd', type: 'led', x: 0, y: 0 }],
  wires: [{ from: 'u:13', to: 'r:1' }, { from: 'r:2', to: 'd:A' }, { from: 'd:C', to: 'u:GND' }],
  boards: [{ part: 'u', firmware: '' }],
});

test('imports the starter diagram', () => {
  const { project, unmapped } = importWokwi(starter());
  assert.equal(project.parts.length, 4);
  assert.equal(project.wires.length, 5);
  assert.deepEqual(unmapped, []);
  assert.deepEqual(project.parts.map((p) => p.type), ['uno', 'led', 'resistor', 'pushbutton']);
  assert.ok(project.wires.some((w) => w.from === 'led1:C' && w.to === 'uno:GND.1'));
  assert.deepEqual(project.boards, [{ part: 'uno', firmware: '' }]);
  assert.deepEqual(validate(project), []);
});

test('an unknown part type is listed as unmapped and still imports', () => {
  const d = starter(); d.parts.push({ type: 'wokwi-flux-capacitor', id: 'dht1', top: 0, left: 0 });
  d.connections.push(['dht1:OUT', 'uno:4', 'green', []]);
  const { project, unmapped } = importWokwi(d);
  assert.deepEqual(unmapped, ['dht1 (wokwi-flux-capacitor)']);
  assert.equal(project.parts.length, 5);
  assert.deepEqual(validate(project), []);
  const e = new Engine(); const f = fakeBoard('uno');
  assert.doesNotThrow(() => new Circuit(e, project, { uno: f.b }));
});

test('validate names the part and pin of a bad wire', () => {
  const p = ledProject(); p.wires.push({ from: 'd:X', to: 'u:13' }); p.wires.push({ from: 'nope:1', to: 'u:13' });
  const msgs = validate(p);
  assert.equal(msgs.length, 2);
  assert.ok(msgs[0].includes('d') && msgs[0].includes('X'));
  assert.ok(msgs[1].includes('nope'));
});

test('a board pin lights an LED through a resistor and the change is logged', () => {
  const e = new Engine(); const f = fakeBoard('u'); e.addBackend(f.b);
  const c = new Circuit(e, ledProject(), { u: f.b });
  assert.equal(c.outputs().d.lit, false);
  f.set([{ pin: '13', level: 1 }, { pin: 'GND', level: 0 }]);
  assert.equal(c.outputs().d.lit, true);
  assert.deepEqual(e.log, ['0 out d.lit=true']);
});

test('a control changes what the board reads', () => {
  const e = new Engine(); const f = fakeBoard('u'); e.addBackend(f.b);
  const p: Project = { version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'b', type: 'pushbutton', x: 0, y: 0 }, { id: 'p', type: 'potentiometer', x: 0, y: 0 }],
    wires: [{ from: 'b:1.l', to: 'u:2' }, { from: 'b:2.r', to: 'u:GND' }, { from: 'p:SIG', to: 'u:A0' }], boards: [{ part: 'u', firmware: '' }] };
  const c = new Circuit(e, p, { u: f.b });
  f.set([{ pin: '2', level: null, pull: 'up' }, { pin: 'GND', level: 0 }]);
  assert.equal(f.inputs['2'], 1);
  c.setControl('b', 'pressed', 1);
  assert.equal(f.inputs['2'], 0);
  c.setControl('p', 'value', 1023);
  assert.equal(f.analog.A0, 5);
  assert.throws(() => c.setControl('b', 'nope', 1), /nope/);
});

test('two boards driving one net opposite ways are reported as contended', () => {
  const e = new Engine(); const a = fakeBoard('a'), b = fakeBoard('b');
  const p: Project = { version: 1, parts: [{ id: 'a', type: 'uno', x: 0, y: 0 }, { id: 'b', type: 'uno', x: 0, y: 0 }], wires: [{ from: 'a:3', to: 'b:3' }], boards: [] };
  const c = new Circuit(e, p, { a: a.b, b: b.b });
  a.set([{ pin: '3', level: 1 }]); b.set([{ pin: '3', level: 0 }]);
  assert.equal(c.contended().length, 1);
  assert.ok(e.log.some((l) => l.includes('contended')));
});

test('restoring a snapshot from a different project is rejected', () => {
  const e = new Engine(); const f = fakeBoard('u');
  const c1 = new Circuit(e, ledProject(), { u: f.b });
  const other = ledProject(); other.parts[2].id = 'other';  other.wires = [];
  const c2 = new Circuit(new Engine(), other, { u: f.b });
  assert.throws(() => c2.restoreState(c1.saveState()), /different project/);
});

test('circuit state rewinds with the engine', () => {
  const e = new Engine(); const f = fakeBoard('u'); e.addBackend(f.b);
  const p: Project = { version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'b', type: 'pushbutton', x: 0, y: 0 }], wires: [{ from: 'b:1.l', to: 'u:2' }, { from: 'b:2.r', to: 'u:GND' }], boards: [] };
  const c = new Circuit(e, p, { u: f.b });
  f.set([{ pin: '2', level: null, pull: 'up' }, { pin: 'GND', level: 0 }]);
  const snap = e.snapshot();
  c.setControl('b', 'pressed', 1);
  assert.equal(f.inputs['2'], 0);
  e.restore(snap);
  assert.equal(f.inputs['2'], 1);
});

test('canonicalPin merges numbered copies of a pin and rejects unknown pins', () => {
  assert.equal(canonicalPin('uno', 'GND.2'), 'GND');
  assert.equal(canonicalPin('uno', 'A4.2'), 'A4');
  assert.equal(canonicalPin('uno', '13'), '13');
  assert.equal(canonicalPin('uno', 'GND.x'), null);
  assert.equal(canonicalPin('pushbutton', '1.l'), '1.l');
  assert.equal(canonicalPin('led', 'X'), null);
  assert.equal(canonicalPin('led', 'A.1'), null);
});

test('validate accepts numbered board pins and rejects made-up ones', () => {
  const p = ledProject(); p.wires.push({ from: 'u:GND.2', to: 'd:C' });
  assert.deepEqual(validate(p), []);
  p.wires.push({ from: 'u:GND.x', to: 'd:C' });
  assert.equal(validate(p).length, 1);
});

test('two numbered copies of a board pin are one net', () => {
  const e = new Engine(); const f = fakeBoard('u'); e.addBackend(f.b);
  const p: Project = { version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'r', type: 'resistor', x: 0, y: 0 }, { id: 'd', type: 'led', x: 0, y: 0 }],
    wires: [{ from: 'u:13', to: 'r:1' }, { from: 'r:2', to: 'd:A' }, { from: 'd:C', to: 'u:GND.2' }], boards: [] };
  const c = new Circuit(e, p, { u: f.b });
  f.set([{ pin: '13', level: 1 }, { pin: 'GND', level: 0 }]);
  assert.equal(c.outputs().d.lit, true);
});
