// Regression tests for review findings in electrical checks, lights and the catalogue text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rig } from './helpers/rig.ts';
import { Electrical, findNgspice } from '../src/electrical/index.ts';
import { catalogInfo } from '../src/catalog-info.ts';
import { library } from '../src/parts/index.ts';

test('ngspice is found where Shibo installs it for the user, without any setting', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shibo-home-'));
  const bin = path.join(home, '.local/share/shibo/ngspice/usr/bin/ngspice');
  fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, '#!/bin/sh\n'); fs.chmodSync(bin, 0o755);
  const before = { HOME: process.env.HOME, S: process.env.SHIBO_NGSPICE, PATH: process.env.PATH };
  try {
    process.env.HOME = home; delete process.env.SHIBO_NGSPICE; process.env.PATH = '/nonexistent';
    assert.equal(findNgspice(), bin);
    process.env.SHIBO_NGSPICE = '/given/ngspice';
    assert.equal(findNgspice(), null, 'an explicit setting still wins, even when it is wrong');
  } finally { process.env.HOME = before.HOME; process.env.PATH = before.PATH; if (before.S === undefined) delete process.env.SHIBO_NGSPICE; else process.env.SHIBO_NGSPICE = before.S; }
});

test('a solve that fails once is retried for the same circuit, not stuck as unchecked', async () => {
  let calls = 0;
  const spice = { unavailable: '', close() {}, async op() { calls++; return calls === 1 ? { ok: false, reason: 'ngspice hiccup' } : { ok: true, values: new Map() }; } };
  const e = new Electrical({ spice: spice as any });
  const r = rig([{ id: 'r', type: 'resistor' }], [['u:13', 'r:1'], ['r:2', 'u:GND']]);
  r.set('13', 1);
  e.update(r.circuit.picture()); await e.settled();
  assert.equal(e.report()!.state, 'unchecked');
  e.update(r.circuit.picture()); await e.settled();
  assert.equal(calls, 2, 'the same circuit is solved again after a failure');
  assert.equal(e.report()!.state, 'ok');
  e.update(r.circuit.picture()); await e.settled();
  assert.equal(calls, 2, 'a good answer is still reused');
});

test('a common-anode RGB LED wired backwards is not called out as missing a resistor', () => {
  const r = rig([{ id: 'l', type: 'rgb-led-anode' }], [['u:3', 'l:R'], ['l:COM', 'u:GND']]);
  r.set('3', 1);
  assert.deepEqual(r.circuit.warnings().filter((w) => /resistor/.test(w)), [], 'reverse-biased: no current flows');
  const ok = rig([{ id: 'l', type: 'rgb-led-anode' }], [['u:3', 'l:R'], ['l:COM', 'u:5V']]);
  ok.set('3', 0);
  assert.ok(ok.circuit.warnings().some((w) => /resistor/.test(w)), 'forward-biased with no resistor is still caught');
});

test('a TM1637 display with no power does not pull its lines up', () => {
  const r = rig([{ id: 't', type: 'tm1637' }], [['t:CLK', 'u:2'], ['t:DIO', 'u:3']]);
  r.set('2', 'input'); r.set('3', 'input');
  assert.deepEqual([r.inputs['2'], r.inputs['3']], [null, null]);
});

test("the 7-segment card's wiring example works with the model's default (common anode)", () => {
  const i = catalogInfo['7segment'];
  assert.equal(i.wiring!.find((w) => w.pin === 'COM')!.to, '5V', 'common anode: COM goes to 5V');
  assert.match(i.code!, /LOW/); assert.doesNotMatch(i.code!, /common cathode/);
  // and the example really lights segment A
  const r = rig([{ id: 's', type: '7segment' }], [['s:COM', 'u:5V'], ['u:2', 's:A']]);
  r.set('2', 0);
  assert.equal((r.out('s').values as number[])[0], 1);
});

test('the plain RGB LED set to common anode and wired backwards is not called out either', () => {
  const r = rig([{ id: 'l', type: 'rgb-led', attrs: { common: 'anode' } }], [['u:3', 'l:R'], ['l:COM', 'u:GND']]);
  r.set('3', 1);
  assert.deepEqual(r.circuit.warnings().filter((w) => /resistor/.test(w)), []);
});
