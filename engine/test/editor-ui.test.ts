// Edits behind the editor's bendable wires, multi-select and copy/paste.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPart, addWire, setAttr, rotatePart, setWirePoints, moveParts, removeParts, pasteParts } from '../src/edit.ts';
import { parseProject, type Project } from '../src/project.ts';
import { Session } from '../src/session.ts';

const empty = (): Project => ({ version: 1, parts: [], wires: [], boards: [] });
function circuit(): Project {
  let p = empty();
  p = addPart(p, 'uno', 0, 0).project;
  p = addPart(p, 'led', 300, 0).project;
  p = addPart(p, 'resistor', 400, 0).project;
  p = addWire(p, 'uno1:13', 'resistor1:1');
  p = addWire(p, 'resistor1:2', 'led1:A');
  return p;
}

test('a wire keeps the bend points it is given, and they survive a save and load', () => {
  const p = setWirePoints(circuit(), 0, [[10, 20], [30.4, 40]]);
  assert.deepEqual(p.wires[0].points, [[10, 20], [30, 40]]);
  assert.equal(p.wires[1].points, undefined);
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(p)), 'test').wires[0].points, [[10, 20], [30, 40]]);
  // No points at all means the wire is routed for you again.
  assert.equal(setWirePoints(p, 0, []).wires[0].points, undefined);
  assert.throws(() => setWirePoints(p, 5, []), /no wire number 5/);
  assert.throws(() => setWirePoints(p, 0, [[1, Number.NaN]] as any), /bend point/);
  assert.throws(() => setWirePoints(p, 0, 'v10' as any), /bend point/);
  assert.throws(() => setWirePoints(p, 0, Array.from({ length: 101 }, () => [0, 0]) as any), /too many/);
});

test('a project file with odd bend points is cleaned, not trusted', () => {
  const raw = JSON.parse(JSON.stringify(circuit()));
  raw.wires[0].points = [[1, 2], ['3', 4], [5], [6, 7, 8], null, [9, 10]];
  raw.wires[1].points = 'h10';
  const p = parseProject(raw, 'test');
  assert.deepEqual(p.wires[0].points, [[1, 2], [9, 10]]);
  assert.equal(p.wires[1].points, undefined);
  raw.wires[0].points = Array.from({ length: 500 }, (_, i) => [i, i]);
  assert.equal(parseProject(raw, 'test').wires[0].points!.length, 100);
});

test('moveParts moves several parts as one edit, and bends of wires between them go too', () => {
  let p = setWirePoints(circuit(), 1, [[350, 50]]);
  p = setWirePoints(p, 0, [[200, 50]]);
  const q = moveParts(p, ['led1', 'resistor1'], 20, -10);
  assert.deepEqual(q.parts.map((x) => [x.id, x.x, x.y]), [['uno1', 0, 0], ['led1', 320, -10], ['resistor1', 420, -10]]);
  assert.deepEqual(q.wires[1].points, [[370, 40]]);      // both ends moved
  assert.deepEqual(q.wires[0].points, [[200, 50]]);      // one end stayed
  assert.throws(() => moveParts(p, ['nope'], 1, 1), /no part "nope"/);
  assert.throws(() => moveParts(p, ['led1'], Number.NaN, 1), /number/);
});

test('removeParts takes several parts and their wires', () => {
  const q = removeParts(circuit(), ['led1', 'resistor1']);
  assert.deepEqual(q.parts.map((x) => x.id), ['uno1']);
  assert.equal(q.wires.length, 0);
  assert.equal(removeParts(circuit(), ['uno1']).boards.length, 0);
});

test('pasteParts copies parts with their settings and the wires between them, under new names', () => {
  let p = setAttr(circuit(), 'led1', 'color', 'blue');
  p = rotatePart(p, 'led1');
  p = setWirePoints(p, 1, [[350, 50]]);
  const clip = { parts: p.parts.filter((x) => x.id !== 'uno1'), wires: p.wires };
  const q = pasteParts(p, clip, 30, 40);
  assert.equal(q.parts.length, 5);
  const led2 = q.parts.find((x) => x.id === 'led2')!, r2 = q.parts.find((x) => x.id === 'resistor2')!;
  assert.deepEqual(led2, { id: 'led2', type: 'led', x: 330, y: 40, rot: 90, attrs: { color: 'blue' } });
  assert.deepEqual([r2.x, r2.y], [430, 40]);
  // Only the wire with both ends inside what was copied comes along.
  assert.equal(q.wires.length, 3);
  assert.deepEqual(q.wires[2], { from: 'resistor2:2', to: 'led2:A', color: 'green', points: [[380, 90]] });
  // A pasted board is a board.
  const b = pasteParts(p, { parts: [p.parts[0]], wires: [] }, 0, 0);
  assert.deepEqual(b.boards.map((x) => x.part), ['uno1', 'uno2']);
  assert.throws(() => pasteParts(p, { parts: [{ id: 'x', type: 'flux', x: 0, y: 0 }], wires: [] }, 0, 0), /flux/);
  assert.throws(() => pasteParts(p, { parts: 'no' } as any, 0, 0), /copied/);
});

test('the session takes the new edits as single undo steps', async () => {
  const out: any[] = [];
  const s = new Session({ build: async () => ({ ok: false, log: '' }) });
  s.onMessage((m) => out.push(m));
  await s.handle({ t: 'edit', op: 'addPart', args: ['led', 0, 0] });
  await s.handle({ t: 'edit', op: 'addPart', args: ['led', 100, 0] });
  await s.handle({ t: 'edit', op: 'moveParts', args: [['led1', 'led2'], 10, 10] });
  await s.handle({ t: 'edit', op: 'pasteParts', args: [{ parts: [{ id: 'led1', type: 'led', x: 0, y: 0 }], wires: [] }, 20, 20] });
  await s.handle({ t: 'edit', op: 'addWire', args: ['led1:A', 'led2:C'] });
  await s.handle({ t: 'edit', op: 'setWirePoints', args: [0, [[5, 5]]] });
  await s.handle({ t: 'edit', op: 'removeParts', args: [['led1', 'led3']] });
  let last = out.filter((m) => m.t === 'project').at(-1);
  assert.deepEqual(last.project.parts.map((x: any) => x.id), ['led2']);
  await s.handle({ t: 'undo' });
  last = out.filter((m) => m.t === 'project').at(-1);
  assert.deepEqual(last.project.parts.map((x: any) => [x.id, x.x, x.y]), [['led1', 10, 10], ['led2', 110, 10], ['led3', 20, 20]]);
  assert.deepEqual(last.project.wires[0].points, [[5, 5]]);
});
