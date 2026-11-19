import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPart, movePart, removePart, addWire, removeWire, setAttr, catalog } from '../src/edit.ts';
import { validate, parseProject, type Project } from '../src/project.ts';
import { library } from '../src/parts/index.ts';

const empty = (): Project => ({ version: 1, parts: [], wires: [], boards: [] });
function basic(): Project {
  let p = empty();
  p = addPart(p, 'uno', 0, 0).project;
  p = addPart(p, 'led', 100, 0).project;
  p = addPart(p, 'resistor', 200, 0).project;
  return p;
}

test('the catalog offers the board and every library part', () => {
  const types = catalog.map((c) => c.type);
  assert.ok(types.includes('uno'));
  for (const t of Object.keys(library)) assert.ok(types.includes(t), t);
  assert.equal(catalog.find((c) => c.type === 'uno')!.tag, 'wokwi-arduino-uno');
  assert.equal(catalog.find((c) => c.type === 'slide-switch')!.tag, 'wokwi-slide-switch');
});

test('addPart numbers ids per type and registers boards', () => {
  const a = addPart(empty(), 'led', 10, 20);
  assert.equal(a.id, 'led1');
  const b = addPart(a.project, 'led', 0, 0);
  assert.equal(b.id, 'led2');
  assert.deepEqual(b.project.parts[0], { id: 'led1', type: 'led', x: 10, y: 20 });
  const u = addPart(b.project, 'uno', 0, 0);
  assert.equal(u.id, 'uno1');
  assert.deepEqual(u.project.boards, [{ part: 'uno1', firmware: '' }]);
  assert.equal(addPart(removePart(b.project, 'led1'), 'led', 0, 0).id, 'led1');
  assert.throws(() => addPart(empty(), 'flux-capacitor', 0, 0), /flux-capacitor/);
});

test('edits leave the project they were given unchanged', () => {
  const p = basic(); const before = JSON.stringify(p);
  addPart(p, 'led', 0, 0); movePart(p, 'led1', 5, 5); addWire(p, 'uno1:13', 'resistor1:1'); removePart(p, 'led1'); setAttr(p, 'led1', 'color', 'blue');
  assert.equal(JSON.stringify(p), before);
});

test('movePart moves one part', () => {
  const p = movePart(basic(), 'led1', 33, 44);
  assert.deepEqual([p.parts[1].x, p.parts[1].y], [33, 44]);
  assert.throws(() => movePart(p, 'nope', 0, 0), /nope/);
});

test('addWire refuses a wire to itself, a duplicate, and unknown parts or pins', () => {
  let p = addWire(basic(), 'uno1:13', 'resistor1:1');
  assert.equal(p.wires.length, 1);
  assert.throws(() => addWire(p, 'uno1:13', 'uno1:13'), /same pin/);
  assert.throws(() => addWire(p, 'uno1:13', 'resistor1:1'), /already/);
  assert.throws(() => addWire(p, 'resistor1:1', 'uno1:13'), /already/);
  assert.throws(() => addWire(p, 'uno1:99', 'led1:A'), /99/);
  assert.throws(() => addWire(p, 'ghost:1', 'led1:A'), /ghost/);
  p = addWire(p, 'led1:C', 'uno1:GND.2');
  assert.deepEqual(validate(p), []);
  assert.equal(p.wires[1].color, 'black');
  assert.equal(addWire(p, 'uno1:5V', 'led1:A').wires[2].color, 'red');
});

test('removePart takes its wires and its board entry with it', () => {
  let p = addWire(basic(), 'uno1:13', 'resistor1:1');
  p = addWire(p, 'resistor1:2', 'led1:A');
  const q = removePart(p, 'resistor1');
  assert.equal(q.wires.length, 0);
  assert.equal(q.parts.length, 2);
  assert.deepEqual(removePart(p, 'uno1').boards, []);
  assert.deepEqual(validate(removePart(p, 'led1')), []);
});

test('removeWire removes by position and rejects a bad position', () => {
  const p = addWire(basic(), 'uno1:13', 'resistor1:1');
  assert.equal(removeWire(p, 0).wires.length, 0);
  assert.throws(() => removeWire(p, 3), /3/);
});

test('setAttr sets one attribute', () => {
  const p = setAttr(basic(), 'led1', 'color', 'blue');
  assert.deepEqual(p.parts[1].attrs, { color: 'blue' });
});

test('every catalog part can be added and gives a usable project', () => {
  let p = empty();
  for (const c of catalog) p = addPart(p, c.type, 0, 0).project;
  assert.equal(p.parts.length, catalog.length);
  assert.doesNotThrow(() => parseProject(p, 'test'));
});

test('ids of part types that end in a digit stay readable', () => {
  assert.equal(addPart(empty(), 'lcd1602', 0, 0).id, 'lcd1602-1');
  assert.equal(addPart(empty(), 'hc-sr04', 0, 0).id, 'hc-sr04-1');
  assert.equal(addPart(empty(), '7segment', 0, 0).id, 'part-7segment1');
});
