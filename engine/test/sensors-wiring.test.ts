// Sensors in the rest of the tool: starter sketches know their pins, and every role names a real pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSketch } from '../src/sketchgen.ts';
import { sensorsMore } from '../src/parts/sensors-more.ts';
import { sensorRoles } from '../src/parts/sensors-roles.ts';

test('every sensor role names a sensor part and pins it really has', () => {
  for (const [type, roles] of Object.entries(sensorRoles)) {
    const def = sensorsMore.find((d) => d.type === type);
    assert.ok(def, `${type} is not a sensor part`);
    for (const r of roles) for (const p of r.pins) assert.ok(def.pins.includes(p), `${type} has no pin ${p}`);
  }
  for (const d of sensorsMore) assert.ok(d.ui?.tag && d.ui.label && d.ui.group === 'Sensors', `${d.type} needs ui`);
});

test('a starter sketch reads an LM35 with analogRead and a PIR with digitalRead', () => {
  const code = generateSketch({ version: 1, boards: [], parts: [
    { id: 'uno', type: 'uno', x: 0, y: 0 }, { id: 't1', type: 'lm35', x: 0, y: 0 }, { id: 'm1', type: 'hc-sr501', x: 0, y: 0 },
  ], wires: [{ from: 't1:OUT', to: 'uno:A0' }, { from: 'm1:OUT', to: 'uno:7' }] } as any);
  assert.match(code, /const int T1 = A0;/);
  assert.match(code, /analogRead\(T1\)/);
  assert.match(code, /pinMode\(M1, INPUT\);/);
});
