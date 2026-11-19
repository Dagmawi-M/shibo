import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '../src/nets.ts';

test('a wire carries the driver level', () => {
  const r = resolve([{ a: 'u:13', b: 'led:A', kind: 'wire' }], [{ node: 'u:13', level: 1 }]);
  assert.equal(r.level('led:A'), 1);
});
test('a level passes through one resistor', () => {
  const r = resolve([{ a: 'u:13', b: 'r:2', kind: 'wire' }, { a: 'r:1', b: 'r:2', kind: 'resistor' }, { a: 'r:1', b: 'led:A', kind: 'wire' }], [{ node: 'u:13', level: 1 }]);
  assert.equal(r.level('led:A'), 1);
});
test('a pull-up alone reads high', () => {
  const r = resolve([{ a: 'u:2', b: 'btn:1', kind: 'wire' }], [{ node: 'u:2', level: null, pull: 'up' }]);
  assert.equal(r.level('btn:1'), 1);
});
test('a closed button to ground beats a pull-up', () => {
  const r = resolve([{ a: 'u:2', b: 'btn:1', kind: 'wire' }, { a: 'btn:1', b: 'btn:2', kind: 'wire' }, { a: 'btn:2', b: 'u:GND', kind: 'wire' }],
    [{ node: 'u:2', level: null, pull: 'up' }, { node: 'u:GND', level: 0 }]);
  assert.equal(r.level('u:2'), 0);
});
test('an unconnected node floats', () => {
  assert.equal(resolve([], []).level('x:1'), null);
});
test('a strong driver beats a level arriving through a resistor', () => {
  const r = resolve([{ a: 'a:1', b: 'b:1', kind: 'resistor' }], [{ node: 'a:1', level: 1 }, { node: 'b:1', level: 0 }]);
  assert.equal(r.level('b:1'), 0);
  assert.deepEqual(r.contended, []);
});
test('two opposing drivers on one net are reported and read as floating', () => {
  const r = resolve([{ a: 'u:3', b: 'v:3', kind: 'wire' }], [{ node: 'u:3', level: 1 }, { node: 'v:3', level: 0 }]);
  assert.equal(r.contended.length, 1);
  assert.equal(r.level('u:3'), null);
});
