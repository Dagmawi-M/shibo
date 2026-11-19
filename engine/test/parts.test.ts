import { test } from 'node:test';
import assert from 'node:assert/strict';
import { library } from '../src/parts/index.ts';
import type { Level } from '../src/types.ts';

const lv = (m: Record<string, Level>) => (n: string): Level => m[n] ?? null;

test('led lights when anode is high and cathode is low', () => {
  const led = library.led;
  assert.deepEqual(led.outputs!('d', lv({ 'd:A': 1, 'd:C': 0 }), {}), { lit: true });
  assert.deepEqual(led.outputs!('d', lv({ 'd:A': 1, 'd:C': 1 }), {}), { lit: false });
  assert.deepEqual(led.outputs!('d', lv({ 'd:A': 1 }), {}), { lit: false });
});
test('resistor is one resistor link', () => {
  assert.deepEqual(library.resistor.links('r', {}), [{ a: 'r:1', b: 'r:2', kind: 'resistor' }]);
});
test('pushbutton joins its two sides only when pressed', () => {
  const b = library.pushbutton;
  const sides = [{ a: 'b:1.l', b: 'b:1.r', kind: 'wire' }, { a: 'b:2.l', b: 'b:2.r', kind: 'wire' }];
  assert.deepEqual(b.links('b', { pressed: 0 }), sides);
  assert.deepEqual(b.links('b', { pressed: 1 }), [...sides, { a: 'b:1.l', b: 'b:2.l', kind: 'wire' }]);
  assert.equal(b.controls!.pressed.kind, 'momentary');
});
test('slide switch connects the common pin to one side', () => {
  const s = library['slide-switch'];
  assert.deepEqual(s.links('s', { value: 0 }), [{ a: 's:2', b: 's:1', kind: 'wire' }]);
  assert.deepEqual(s.links('s', { value: 1 }), [{ a: 's:2', b: 's:3', kind: 'wire' }]);
});
test('potentiometer puts a voltage on SIG', () => {
  const p = library.potentiometer;
  assert.deepEqual(p.analog!('p', { value: 1023 }), [{ node: 'p:SIG', volts: 5 }]);
  assert.deepEqual(p.analog!('p', { value: 0 }), [{ node: 'p:SIG', volts: 0 }]);
  assert.deepEqual([p.controls!.value.min, p.controls!.value.max], [0, 1023]);
});
test('buzzer sounds when its pins differ and neither floats', () => {
  const z = library.buzzer;
  assert.deepEqual(z.outputs!('z', lv({ 'z:1': 0, 'z:2': 1 }), {}), { on: true });
  assert.deepEqual(z.outputs!('z', lv({ 'z:1': 0, 'z:2': 0 }), {}), { on: false });
  assert.deepEqual(z.outputs!('z', lv({ 'z:2': 1 }), {}), { on: false });
});
test('every library part lists the pins its links use', () => {
  for (const [name, def] of Object.entries(library)) {
    const state: Record<string, number> = {};
    for (const [c, d] of Object.entries(def.controls ?? {})) state[c] = d.max ?? 1;
    for (const l of def.links('x', state, () => null)) for (const n of [l.a, l.b]) assert.ok(def.pins.includes(n.slice(2)), `${name}: ${n}`);
    assert.equal(def.type, name);
  }
});
