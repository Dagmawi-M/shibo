// Engine support for parts that act over time or speak a protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { Circuit } from '../src/circuit.ts';
import type { PartDef } from '../src/part.ts';
import type { ChipBackend, I2CHandler, Level, PinDrive } from '../src/types.ts';
import type { Project } from '../src/project.ts';

function board(id: string) {
  let drives: PinDrive[] = []; const cbs: (() => void)[] = []; const inputs: Record<string, Level> = {}; const seen: [string, Level, number][] = [];
  let t = 0, end = 0; let script: [number, () => void][] = []; let i2c: I2CHandler | null = null;
  const b: ChipBackend = {
    id,
    runUntil(x) { end = x; while (script.length && script[0][0] <= end) { const [at, fn] = script.shift()!; t = at; fn(); } t = Math.max(t, end); },
    interrupt(x) { end = Math.min(end, x); },
    nowNs: () => t,
    drives: () => drives,
    setInput(p, l) { if (inputs[p] !== l) { inputs[p] = l; seen.push([p, l, t]); } },
    setAnalog() {}, onChange(cb) { cbs.push(cb); }, onSerial() {}, serialWrite() {},
    onI2C(h) { i2c = h; }, i2cPins: { sda: 'A4', scl: 'A5' },
    saveState: () => t, restoreState(s) { t = s as number; },
  };
  return { b, inputs, seen, i2c: () => i2c!, set(d: PinDrive[]) { drives = d; cbs.forEach((c) => c()); }, at(time: number, fn: () => void) { script.push([time, fn]); script.sort((a, c) => a[0] - c[0]); } };
}

// A toy sensor: 250 us after IN rises it holds OUT high for 500 us.
const pulser: PartDef = {
  type: 'pulser', pins: ['IN', 'OUT'], links: () => [],
  device(ctx) {
    const s = { out: 0, last: null as Level, pulses: 0 };
    return {
      drives: () => [{ pin: 'OUT', level: s.out as Level }],
      onChange() {
        const now = ctx.level('IN');
        if (now === 1 && s.last !== 1) ctx.after(250_000, () => { s.out = 1; s.pulses++; ctx.changed(); ctx.after(500_000, () => { s.out = 0; ctx.changed(); }); });
        s.last = now;
      },
      outputs: () => ({ pulses: s.pulses }),
      save: () => ({ ...s }), restore: (x) => Object.assign(s, x),
    };
  },
};
const memory: PartDef = {
  type: 'memory', pins: ['SDA', 'SCL'], links: () => [],
  device() {
    const s = { got: [] as number[] };
    return { i2c: { sda: 'SDA', scl: 'SCL', address: () => 0x50, write: (b) => { s.got.push(b); return true; }, read: () => 0xab },
      outputs: () => ({ count: s.got.length }), save: () => structuredClone(s), restore: (x) => Object.assign(s, structuredClone(x)) };
  },
};
const lib = { pulser, memory };
const proj = (parts: Project['parts'], wires: [string, string][]): Project => ({ version: 1, parts, wires: wires.map(([from, to]) => ({ from, to })), boards: [] });

test('an event scheduled mid-quantum stops the board at that exact time', () => {
  const e = new Engine({ quantumNs: 100_000 }); const u = board('u'); e.addBackend(u.b);
  const fired: [number, number][] = [];
  u.at(30_000, () => e.at(45_000, () => fired.push([e.now, u.b.nowNs!()])));
  e.runUntil(100_000);
  assert.deepEqual(fired, [[45000, 45000]]);
  assert.equal(e.now, 100000);
});

test('a part can drive a pin, on its own schedule, to the nanosecond', () => {
  const e = new Engine({ quantumNs: 100_000 }); const u = board('u'); e.addBackend(u.b);
  const c = new Circuit(e, proj([{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'p', type: 'pulser', x: 0, y: 0 }], [['u:7', 'p:IN'], ['p:OUT', 'u:8']]), { u: u.b }, lib);
  u.at(120_000, () => u.set([{ pin: '7', level: 1 }]));
  e.runUntil(2_000_000);
  assert.deepEqual(u.seen.filter(([p]) => p === '8'), [['8', 0, 0], ['8', 1, 370_000], ['8', 0, 870_000]]);
  assert.equal(c.outputs().p.pulses, 1);
});

test('device state and its pending events rewind with the engine', () => {
  const e = new Engine({ quantumNs: 100_000 }); const u = board('u'); e.addBackend(u.b);
  const c = new Circuit(e, proj([{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'p', type: 'pulser', x: 0, y: 0 }], [['u:7', 'p:IN'], ['p:OUT', 'u:8']]), { u: u.b }, lib);
  u.at(120_000, () => u.set([{ pin: '7', level: 1 }]));
  e.runUntil(200_000);
  const snap = e.snapshot();
  e.runUntil(2_000_000);
  assert.equal(c.outputs().p.pulses, 1);
  e.restore(snap);
  assert.equal(c.outputs().p.pulses, 0);
  e.runUntil(2_000_000);
  assert.equal(c.outputs().p.pulses, 1);
});

test('I2C reaches only devices wired to the bus pins, by address', () => {
  const e = new Engine(); const u = board('u'); e.addBackend(u.b);
  const c = new Circuit(e, proj([{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'm', type: 'memory', x: 0, y: 0 }, { id: 'loose', type: 'memory', x: 0, y: 0 }],
    [['u:A4', 'm:SDA'], ['u:A5', 'm:SCL'], ['u:A4', 'loose:SDA']]), { u: u.b }, lib);
  const bus = u.i2c();
  assert.equal(bus.connect(0x51, true), false);
  assert.equal(bus.connect(0x50, true), true);
  assert.equal(bus.write(7), true); assert.equal(bus.write(9), true);
  bus.stop();
  assert.equal(bus.connect(0x50, false), true);
  assert.equal(bus.read(true), 0xab);
  bus.stop();
  assert.equal(c.outputs().m.count, 2);
  assert.equal(c.outputs().loose.count, 0);
});

test('log lines written from a board callback carry the precise time', () => {
  const e = new Engine({ quantumNs: 100_000 }); const u = board('u'); e.addBackend(u.b);
  new Circuit(e, proj([{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'r', type: 'resistor', x: 0, y: 0 }, { id: 'd', type: 'led', x: 0, y: 0 }], [['u:13', 'r:1'], ['r:2', 'd:A'], ['d:C', 'u:GND']]), { u: u.b });
  u.at(33_000, () => u.set([{ pin: '13', level: 1 }, { pin: 'GND', level: 0 }]));
  e.runUntil(100_000);
  assert.deepEqual(e.log, ['33000 out d.lit=true']);
});
