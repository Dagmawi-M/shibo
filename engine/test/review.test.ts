// Regression tests for the findings of the stage 1a review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Engine } from '../src/engine.ts';
import { Circuit } from '../src/circuit.ts';
import { UnoBackend } from '../src/backends/avr.ts';
import { resolve } from '../src/nets.ts';
import { importWokwi, validate, type Project } from '../src/project.ts';
import type { ChipBackend, PinDrive } from '../src/types.ts';

const STARTER = new URL('./fixtures/starter', import.meta.url).pathname;
const cli = new URL('../bin/shibo.ts', import.meta.url).pathname;
const hex = (n: string) => readFileSync(new URL(`./fixtures/${n}.hex`, import.meta.url), 'utf8');
const MS = 1e6;

function scratch(edit: (diagram: any) => void, sketch?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-'));
  const d = JSON.parse(readFileSync(path.join(STARTER, 'diagram.json'), 'utf8')); edit(d);
  writeFileSync(path.join(dir, 'diagram.json'), JSON.stringify(d));
  if (sketch === undefined) cpSync(path.join(STARTER, 'sketch.ino'), path.join(dir, 'sketch.ino')); else writeFileSync(path.join(dir, 'sketch.ino'), sketch);
  return dir;
}
const run = (dir: string, ...args: string[]) => spawnSync(process.execPath, [cli, 'run', dir, ...args], { encoding: 'utf8' });

function fake(id: string, drives: PinDrive[] = []) {
  let restores = 0;
  const b: ChipBackend = { id, runUntil() {}, drives: () => drives, setInput() {}, setAnalog() {}, onChange() {}, onSerial() {}, serialWrite() {},
    saveState: () => 1, restoreState() { restores++; } };
  return { b, restores: () => restores };
}
const shortProject = (): Project => ({ version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }], wires: [{ from: 'u:5V', to: 'u:GND' }], boards: [] });

test('a short that exists from the start is logged', () => {
  const e = new Engine(); const f = fake('u', [{ pin: '5V', level: 1 }, { pin: 'GND', level: 0 }]);
  const c = new Circuit(e, shortProject(), { u: f.b });
  assert.equal(c.contended().length, 1);
  assert.ok(e.log.some((l) => l.includes('contended')), e.log.join('\n'));
});

test('cli: a short fails the run and is named at the end', () => {
  const r = run(scratch((d) => d.connections.push(['uno:5V', 'uno:GND.3', 'red', []])), '--ms', '400');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /contended/);
  assert.match(r.stderr, /still shorted at the end/);
});

test('every byte of a serial write arrives', () => {
  const u = new UnoBackend('uno', hex('echo')); let got = '';
  u.onSerial((b) => { got += String.fromCharCode(b); });
  u.runUntil(100 * MS);
  for (const ch of 'HELLO') u.serialWrite(ch.charCodeAt(0));
  for (let t = 101; t <= 300; t++) u.runUntil(t * MS);
  assert.equal(got, 'HELLO');
});

test('queued serial bytes rewind with the board', () => {
  const u = new UnoBackend('uno', hex('echo')); let got = '';
  u.onSerial((b) => { got += String.fromCharCode(b); });
  u.runUntil(100 * MS);
  for (const ch of 'HELLO') u.serialWrite(ch.charCodeAt(0));
  u.runUntil(101 * MS);
  const snap = u.saveState(); got = '';
  for (let t = 102; t <= 300; t++) u.runUntil(t * MS);
  const first = got; got = '';
  u.restoreState(snap);
  for (let t = 102; t <= 300; t++) u.runUntil(t * MS);
  assert.ok(first.length >= 4, `echoed after the snapshot: "${first}"`);
  assert.equal(got, first);
});

test("another engine's snapshot is rejected before anything is restored", () => {
  const a = new Engine(), b = new Engine(); const fa = fake('uno'), fb = fake('uno');
  a.addBackend(fa.b); b.addBackend(fb.b);
  a.runUntil(900);
  const snap = a.snapshot();
  assert.throws(() => b.restore(snap), /different/);
  assert.equal(fa.restores(), 0);
  assert.equal(fb.restores(), 0);
  assert.equal(b.now, 0);
});

test('a foreign circuit state is rejected before any board is rewound', () => {
  const e = new Engine(); const f = fake('u'); e.addBackend(f.b);
  new Circuit(e, shortProject(), { u: f.b });
  const snap = e.snapshot();
  (snap.extras as any[])[0] = { ...(snap.extras as any[])[0], parts: 'something-else' };
  assert.throws(() => e.restore(snap), /different project/);
  assert.equal(f.restores(), 0);
});

test('a snapshot keeps its own log through a diverged replay', () => {
  const e = new Engine();
  for (const t of [20, 100, 300]) e.at(t, () => e.record(`timelineA ${t}`));
  e.runUntil(50); const s1 = e.snapshot();
  e.runUntil(400); const s2 = e.snapshot();
  e.restore(s1);
  e.at(60, () => e.record('timelineB changed input'));
  e.runUntil(150);
  e.restore(s2);
  assert.deepEqual(e.log, ['20 timelineA 20', '100 timelineA 100', '300 timelineA 300']);
});

test('cli: an unreadable diagram is bad input, not a failed check', () => {
  const dir = scratch(() => {}); writeFileSync(path.join(dir, 'diagram.json'), '{ not json');
  const r = run(dir, '--ms', '10');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /diagram\.json/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('a malformed connection is a clear error', () => {
  assert.throws(() => importWokwi({ parts: [], connections: ['uno:13'] }), /connection 1/);
});

test('cli: a sketch that does not compile exits 3 with the compiler output', () => {
  const r = run(scratch(() => {}, 'void setup() { this is not c; }\nvoid loop() {}\n'), '--ms', '10');
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /error/i);
});

test('cli: --set refuses a value that is not a number or is out of range', () => {
  const dir = scratch((d) => { d.parts.push({ type: 'wokwi-potentiometer', id: 'pot1', top: 0, left: 0 }); d.connections.push(['pot1:SIG', 'uno:A0', 'green', []]); });
  const a = run(dir, '--ms', '10', '--set', 'pot1.value=1-2@5');
  assert.equal(a.status, 2, a.stdout + a.stderr);
  const b = run(dir, '--ms', '10', '--set', 'pot1.value=5000@5');
  assert.equal(b.status, 2, b.stdout + b.stderr);
  assert.match(b.stderr, /1023/);
});

test('setControl refuses values outside the control range', () => {
  const e = new Engine(); const f = fake('u');
  const p: Project = { version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'b', type: 'pushbutton', x: 0, y: 0 }], wires: [], boards: [] };
  const c = new Circuit(e, p, { u: f.b });
  assert.throws(() => c.setControl('b', 'pressed', 2), /0.*1/);
  assert.throws(() => c.setControl('b', 'pressed', NaN), /number/);
});

test('a node pulled both ways through resistors reads floating whatever the order', () => {
  const links = [{ a: 'v:5V', b: 'n:1', kind: 'resistor' as const }, { a: 'n:1', b: 'v:GND', kind: 'resistor' as const }];
  const drives = [{ node: 'v:5V', level: 1 as const }, { node: 'v:GND', level: 0 as const }];
  assert.equal(resolve(links, drives).level('n:1'), null);
  assert.equal(resolve([...links].reverse(), drives).level('n:1'), null);
});

test('numbered Uno pins from Wokwi are kept and accepted', () => {
  const d = JSON.parse(readFileSync(path.join(STARTER, 'diagram.json'), 'utf8'));
  d.connections.push(['uno:A4.2', 'led1:A', 'green', []]);
  const { project } = importWokwi(d);
  assert.ok(project.wires.some((w) => w.from === 'uno:A4.2'));
  assert.deepEqual(validate(project), []);
});
