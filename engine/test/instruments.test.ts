import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fw, power } from './helpers/fw.ts';
import { rig } from './helpers/rig.ts';
import { Probe, rhythm } from '../src/instruments/probe.ts';
import { Instruments, type InstrumentOut } from '../src/instruments/index.ts';
import { formatScript, parseScript, schedule, scriptProblems, setScript } from '../src/instruments/envscript.ts';
import { parseProject, type Project } from '../src/project.ts';

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

test('rhythm reads frequency and duty from level changes', () => {
  // 1 kHz, 25 % high, last change just now
  const times = [0, 250e3, 1e6, 1.25e6, 2e6, 2.25e6], levels = [1, 0, 1, 0, 1, 0] as (0 | 1)[];
  const r = rhythm(times, levels, 2.3e6)!;
  near(r.freq, 1000, 0.01, 'freq'); near(r.duty, 0.25, 1e-9, 'duty');
  assert.equal(rhythm(times, levels, 20e6), null, 'a signal that stopped toggling has no rhythm');
});

test('a buzzer driven by tone() sounds at the note asked for, and stops with noTone()', async () => {
  const b = await fw(`
    void setup() { tone(8, 440); delay(300); noTone(8); tone(8, 1000); delay(300); noTone(8); }
    void loop() {}`, [{ id: 'bz', type: 'buzzer' }], [['bz:1', 'u:8'], ['bz:2', 'u:GND']]);
  const probe = new Probe(b.engine, b.circuit, { version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'bz', type: 'buzzer', x: 0, y: 0 }], wires: [], boards: [] });
  b.run(150);
  near(probe.tones().bz, 440, 1, 'first note');
  b.run(300);
  near(probe.tones().bz, 1000, 2, 'second note');
  b.run(300);
  assert.equal(probe.tones().bz, 0, 'silent after noTone');
});

test('hovering a PWM pin reads its duty and frequency; a steady pin reads its level', async () => {
  const b = await fw(`
    void setup() { pinMode(7, OUTPUT); digitalWrite(7, HIGH); analogWrite(9, 64); analogWrite(5, 191); }
    void loop() {}`, [{ id: 'led', type: 'led' }, { id: 'r', type: 'resistor' }], [['u:9', 'r:1'], ['r:2', 'led:A'], ['led:C', 'u:GND']]);
  const probe = new Probe(b.engine, b.circuit, { version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }], wires: [], boards: [] });
  b.run(100);
  const p9 = probe.read('u:9');
  near(p9.duty!, 64 / 255, 0.01, 'pin 9 duty'); near(p9.freq!, 490, 5, 'pin 9 is on timer 1 at about 490 Hz');
  const p5 = probe.read('u:5');
  near(p5.duty!, 192 / 256, 0.01, 'pin 5 duty'); near(p5.freq!, 977, 10, 'pin 5 is on timer 0 at about 977 Hz');
  const p7 = probe.read('u:7');
  assert.equal(p7.level, 1); assert.equal(p7.freq, null);
  // A part pin on the same net reads the board pin's rhythm.
  near(probe.read('r:1').duty!, 64 / 255, 0.01, 'through the wire');
});

const BLINK = `
  void setup() { Serial.begin(115200); pinMode(13, OUTPUT); }
  int n = 0;
  void loop() { digitalWrite(13, n & 1); Serial.println(n++); delay(100); }`;

test('rewind: scrubbing back puts the circuit as it was at that moment, and resuming carries on from there', async () => {
  const b = await fw(BLINK, [{ id: 'led', type: 'led' }, { id: 'r', type: 'resistor' }], [['u:13', 'r:1'], ['r:2', 'led:A'], ['led:C', 'u:GND']]);
  const project: Project = { version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, { id: 'led', type: 'led', x: 0, y: 0 }], wires: [], boards: [] };
  const sent: InstrumentOut[] = [];
  const inst = new Instruments(b.engine, b.circuit, project, (m) => sent.push(m));
  const seen: Record<number, unknown> = {};
  for (let ms = 50; ms <= 1500; ms += 50) { b.run(50); inst.afterTick(); seen[ms] = b.out('led').lit; }
  const serialAt1500 = b.serial();
  assert.ok(inst.timeline.count > 5, 'snapshots were taken');
  inst.handle({ t: 'pause' });
  for (const ms of [400, 1250, 700, 1300]) {
    inst.handle({ t: 'seek', ms });
    assert.equal(b.engine.now, ms * 1e6);
    assert.equal(b.out('led').lit, seen[ms], `the LED at ${ms} ms`);
  }
  const tl = sent.filter((m) => m.t === 'timeline').at(-1) as Extract<InstrumentOut, { t: 'timeline' }>;
  assert.deepEqual([tl.nowMs, tl.toMs, tl.paused], [1300, 1500, true]);
  // Resume from 1300 ms: the run carries on, and arrives at the same place it did the first time.
  inst.handle({ t: 'resume' });
  b.run(1500 - 1300);
  assert.equal(b.serial().slice(serialAt1500.length).trim().split(/\r?\n/).at(-1), serialAt1500.trim().split(/\r?\n/).at(-1));
  assert.equal(b.out('led').lit, seen[1500]);
});

test('the logic analyzer gets a pin\'s level changes, then only what is new', async () => {
  const b = await fw(BLINK, [], []);
  const project: Project = { version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }], wires: [], boards: [] };
  const sent: InstrumentOut[] = [];
  const inst = new Instruments(b.engine, b.circuit, project, (m) => sent.push(m));
  const sig = sent.find((m) => m.t === 'signals') as Extract<InstrumentOut, { t: 'signals' }>;
  assert.ok(sig.list.some((s) => s.id === 'u:13' && s.label === 'u D13'));
  for (let i = 0; i < 10; i++) { b.run(50); inst.afterTick(); }
  inst.handle({ t: 'watch', signals: ['u:13', 'nonsense'] });
  const first = sent.filter((m) => m.t === 'trace').at(-1) as Extract<InstrumentOut, { t: 'trace' }>;
  assert.equal(first.reset, true);
  assert.deepEqual(Object.keys(first.data), ['u:13']);
  const n0 = first.data['u:13'].times.length;
  assert.ok(n0 >= 4, `about one change per 100 ms, got ${n0}`);
  for (let i = 0; i < 10; i++) { b.run(50); inst.afterTick(); }
  const later = sent.filter((m) => m.t === 'trace' && !m.reset) as Extract<InstrumentOut, { t: 'trace' }>[];
  const times = later.flatMap((m) => m.data['u:13']?.times ?? []);
  assert.ok(times.length >= 4 && times.length <= 6, `new changes only, got ${times.length}`);
  assert.ok(times[0] > first.data['u:13'].times.at(-1)!);
});

test('an environment script reads and writes as text', () => {
  const { steps, errors } = parseScript('# warm up\nat 5s set ntc1.temperature to 40\nat 2 s ramp ntc1.temperature to 60 over 8s\nat 250ms set btn1.pressed 1\nnonsense');
  assert.deepEqual(steps, [
    { at: 5000, part: 'ntc1', control: 'temperature', value: 40 },
    { at: 2000, part: 'ntc1', control: 'temperature', value: 60, over: 8000 },
    { at: 250, part: 'btn1', control: 'pressed', value: 1 },
  ]);
  assert.equal(errors.length, 1); assert.match(errors[0], /line 5/);
  assert.deepEqual(parseScript(formatScript(steps)).steps, steps);
});

test('a script is saved in the project, checked against the circuit, and junk is refused', () => {
  const base: Project = { version: 1, parts: [{ id: 'ntc1', type: 'ntc-temperature-sensor', x: 0, y: 0 }], wires: [], boards: [] };
  const p = parseProject(setScript(base, [{ at: 5000, part: 'ntc1', control: 'temperature', value: 40 }]), 'test');
  assert.deepEqual(p.script, [{ at: 5000, part: 'ntc1', control: 'temperature', value: 40 }]);
  assert.equal(parseProject(setScript(p, []), 'test').script, undefined);
  assert.deepEqual(scriptProblems(p), []);
  assert.match(scriptProblems({ ...p, script: [{ at: 0, part: 'ntc1', control: 'temperature', value: 400 }] })[0], /-24 to 80/);
  assert.match(scriptProblems({ ...p, script: [{ at: 0, part: 'ntc1', control: 'heat', value: 4 }] })[0], /has no control "heat" \(it has temperature\)/);
  assert.match(scriptProblems({ ...p, script: [{ at: 0, part: 'nope', control: 'x', value: 4 }] })[0], /no part "nope"/);
  assert.throws(() => parseProject({ ...p, script: [{ at: 'soon', part: 'ntc1', control: 'temperature', value: 1 }] }, 'x.json'), /script step 1/);
  assert.throws(() => parseProject({ ...p, script: [{ at: 0, part: 'bad id!', control: 'temperature', value: 1 }] }, 'x.json'), /script step 1/);
});

test('a scripted step and ramp move a sensor at exact times', () => {
  const r = rig([{ id: 'ntc1', type: 'ntc-temperature-sensor' }], [...power('ntc1'), ['ntc1:OUT', 'u:A0']]);
  const values: number[] = [];
  schedule(r.engine, r.circuit, [{ at: 10, part: 'ntc1', control: 'temperature', value: 40 }, { at: 20, part: 'ntc1', control: 'temperature', value: 60, over: 100 }], () => assert.fail('no step should fail'));
  const temp = () => r.circuit.controlValues().ntc1.temperature;
  r.run(9.99); values.push(temp());
  r.run(10); values.push(temp());
  r.run(60); values.push(temp());      // two of five 20 ms steps in
  r.run(120); values.push(temp());
  assert.deepEqual(values, [25, 40, 48, 60]);
  assert.ok(r.analog.A0 < 2.5, 'warmer NTC: lower voltage on A0');
});

test('session: pause stops time, seek scrubs back, resume carries on, and the script is an undoable edit', async () => {
  const { Session } = await import('../src/session.ts');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const hex = readFileSync(new URL('./fixtures/toggle.hex', import.meta.url), 'utf8');
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-inst-'));
  writeFileSync(path.join(dir, 'shibo.json'), JSON.stringify({ version: 1, boards: [{ part: 'uno', firmware: '' }], wires: [['ntc1:OUT', 'uno:A0'], ['ntc1:VCC', 'uno:5V'], ['ntc1:GND', 'uno:GND.1']].map(([from, to]) => ({ from, to })),
    parts: [{ id: 'uno', type: 'uno', x: 0, y: 0 }, { id: 'ntc1', type: 'ntc-temperature-sensor', x: 0, y: 0 }] }));
  const s = new Session({ build: async () => ({ ok: true, log: '', hex }) });
  const out: any[] = []; s.onMessage((m) => out.push(m));
  const last = (t: string) => out.filter((m) => m.t === t).at(-1);
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'edit', op: 'setScript', args: [[{ at: 100, part: 'ntc1', control: 'temperature', value: 50 }]] });
  assert.deepEqual(last('project').project.script, [{ at: 100, part: 'ntc1', control: 'temperature', value: 50 }]);
  await s.handle({ t: 'start' });
  for (let i = 0; i < 10; i++) s.tick(50);
  assert.equal(last('controls').values.ntc1.temperature, 50, 'the page hears what the script set');
  await s.handle({ t: 'pause' });
  const at = last('timeline').nowMs;
  for (let i = 0; i < 5; i++) s.tick(50);
  assert.equal(last('timeline').nowMs, at, 'paused: time stands still');
  await s.handle({ t: 'seek', ms: 60 });
  assert.equal(last('timeline').nowMs, 60);
  assert.equal(last('controls').values.ntc1.temperature, 25, 'before the step, the sensor reads as it did');
  assert.equal(last('status').timeMs, 60);
  await s.handle({ t: 'resume' });
  for (let i = 0; i < 2; i++) s.tick(50);
  assert.equal(last('timeline').paused, false);
  assert.equal(last('controls').values.ntc1.temperature, 50, 'resumed: the step happens again at 100 ms');
  assert.equal(out.filter((m) => m.t === 'error').length, 0, JSON.stringify(out.filter((m) => m.t === 'error')));
  await s.handle({ t: 'undo' });
  assert.equal(last('project').project.script, undefined, 'undo takes the script away');
  s.dispose();
});
