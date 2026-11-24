// The whole road from "nothing installed" to a running sketch, without the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Toolchain } from '../src/toolchain.ts';
import { Session, type OutMsg } from '../src/session.ts';
import { createProject } from '../src/templates.ts';
import { SetupError } from '../src/setup.ts';
import { makeRig, chain, theirs } from './helpers/setup-rig.ts';

const skip = process.platform === 'win32';
const COMPILER = 'Download the Arduino compiler (about 80 MB, one time)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, what: string) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > 8000) throw new Error('timed out waiting for ' + what); await sleep(10); } };

const session = async (tc: Toolchain, dir: string) => {
  const s = new Session({ toolchain: tc }); const out: OutMsg[] = [];
  s.onMessage((m) => out.push(m)); await s.handle({ t: 'open', dir });
  const of = <T extends OutMsg['t']>(t: T) => out.filter((m) => m.t === t) as Extract<OutMsg, { t: T }>[];
  return { s, out, of, clear: () => { out.length = 0; } };
};

test('with nothing installed a build asks for the compiler; after the fix the same build works', { skip }, async () => {
  const rig = await makeRig();
  try {
    const tc = chain(rig), dir = createProject(rig.dir, 'blink', 'blink');
    assert.equal(tc.find(), null);
    const first = await tc.build(dir, 'uno');
    assert.deepEqual(first.need?.fix, { kind: 'compiler' }); assert.equal(first.need?.label, COMPILER);
    await tc.repair({ kind: 'compiler' }, () => {}, new AbortController().signal);
    assert.equal(tc.find()?.origin, 'own');
    const built = await tc.build(dir, 'uno');
    assert.equal(built.ok, true); assert.ok(built.hex?.startsWith(':'));
    assert.ok(rig.commands().some((c) => c.startsWith('--no-color compile -b arduino:avr:uno')));
    // A folder with no sketch still says so, compiler or not.
    mkdirSync(path.join(rig.dir, 'bare'));
    assert.match((await chain(rig).build(path.join(rig.dir, 'bare'), 'uno')).log, /no sketch yet/);
  } finally { await rig.close(); }
});

test('a compiler without the board package is not started; the package is offered instead', { skip }, async () => {
  const rig = await makeRig();
  try {
    const mine = theirs(rig), tc = chain(rig, { path: mine.bin }), dir = createProject(rig.dir, 'blink', 'blink');
    assert.equal(tc.find()?.origin, 'path');
    const r = await tc.build(dir, 'uno');
    assert.deepEqual(r.need?.fix, { kind: 'core', pkg: 'arduino:avr' });
    assert.equal(r.need?.label, 'Install the Arduino board package (about 70 MB)');
    assert.ok(!rig.commands().some((c) => c.includes('compile')), 'nothing that could download was started');
    await tc.repair(r.need!.fix!, () => {}, new AbortController().signal);
    assert.deepEqual(rig.commands().slice(-2), ['core update-index', 'core install arduino:avr']);
    assert.equal((await tc.build(dir, 'uno')).ok, true);
    assert.equal(existsSync(rig.ownDir), false, 'their compiler was used; nothing was downloaded');
  } finally { await rig.close(); }
});

test('a compiler that cannot say where its packages are is simply tried, as before', { skip }, async () => {
  const rig = await makeRig();
  try {
    const mine = theirs(rig), tc = chain(rig, { path: mine.bin });
    process.env.FAKE_MODE = 'no-config';
    assert.equal((await tc.build(createProject(rig.dir, 'blink', 'blink'), 'uno')).ok, true);
  } finally { await rig.close(); }
});

test('the setup check tells the four states apart', { skip }, async () => {
  const rig = await makeRig();
  try {
    let st = await chain(rig).status();
    assert.deepEqual([st.compiler.found, st.avr, st.ready, st.compiler.settingMissing], [false, 'absent', false, false]);
    assert.equal(typeof st.ngspice.found, 'boolean'); assert.match(st.ngspice.how, /ngspice/);
    const mine = theirs(rig), tc = chain(rig, { path: mine.bin });
    st = await tc.status();
    assert.deepEqual([st.compiler.found, st.compiler.origin, st.avr, st.attiny, st.ready], [true, 'path', 'absent', 'absent', false]);
    assert.equal(st.compiler.path, path.join(mine.bin, 'arduino-cli')); assert.equal(st.compiler.ownBytes, undefined);
    mine.installed();
    st = await tc.status();
    assert.deepEqual([st.avr, st.ready], ['present', true]);
    const own = chain(rig); await own.repair({ kind: 'compiler' }, () => {}, new AbortController().signal);
    st = await own.status();
    assert.deepEqual([st.compiler.origin, st.avr, st.ready], ['own', 'present', true]); assert.ok(st.compiler.ownBytes! > 0);
    const wrong = new Toolchain({ ownDir: path.join(rig.dir, 'none'), setting: () => path.join(rig.dir, 'not-here'), where: { env: { PATH: '' }, home: rig.dir, platform: 'linux' } });
    assert.equal((await wrong.status()).compiler.settingMissing, true);
  } finally { await rig.close(); }
});

test('two presses of the button are one download, and the compiler cannot be removed while it is being set up', { skip }, async () => {
  const rig = await makeRig();
  try {
    const tc = chain(rig); rig.answer = 'half';
    const none = new AbortController().signal; let heardB = false;
    const a = tc.repair({ kind: 'compiler' }, () => {}, none);
    const b = tc.repair({ kind: 'compiler' }, () => { heardB = true; }, none);
    await until(() => rig.hits() === 1, 'the download to start');
    assert.equal(tc.busy, true);
    await assert.rejects(tc.remove(), /in use/);
    await assert.rejects(tc.repair({ kind: 'library', name: 'Servo' }, () => {}, none), (e: SetupError) => e instanceof SetupError && /still running/.test(e.message));
    rig.answer = 'file'; rig.release();                     // the held download breaks off...
    await assert.rejects(a); await assert.rejects(b);
    assert.equal(tc.busy, false); assert.ok(heardB, 'the second caller heard the progress too');
    await Promise.all([tc.repair({ kind: 'compiler' }, () => {}, none), tc.repair({ kind: 'compiler' }, () => {}, none)]);   // ...and trying again works
    assert.equal(rig.hits(), 2, 'one download per attempt, however many presses');
    await tc.remove(); assert.equal(tc.find(), null);
  } finally { await rig.close(); }
});

test('the session offers the fix, carries it out when asked, and runs the sketch again by itself', { skip }, async () => {
  const rig = await makeRig();
  try {
    const { s, out, of, clear } = await session(chain(rig), createProject(rig.dir, 'blink', 'blink'));
    await s.handle({ t: 'fix' }); assert.deepEqual(of('setup'), [], 'nothing is on offer yet');
    await s.handle({ t: 'start' });
    const e = of('error')[0];
    assert.equal(e.fix, COMPILER); assert.match(e.message, /Arduino compiler/); assert.equal(e.command, undefined);
    clear();
    await s.handle({ t: 'fix' });
    const setup = of('setup');
    assert.equal(setup[0].state, 'working'); assert.equal(setup.at(-1)!.state, 'done');
    assert.ok(setup.some((m) => /Downloading/.test(m.text)) && setup.some((m) => /board package/.test(m.text)));
    assert.ok(setup.length < 60, `progress is not a flood (${setup.length} messages)`);
    const after = out.slice(out.findIndex((m) => m.t === 'setup' && m.state === 'done'));
    assert.ok(after.some((m) => m.t === 'status' && m.state === 'building'), 'the run was started again');
    assert.equal(of('status').at(-1)!.state, 'running'); assert.deepEqual(of('error'), []);
    clear(); await s.handle({ t: 'fix' }); assert.deepEqual(of('setup'), [], 'the fix is offered once');
    s.dispose();
  } finally { await rig.close(); }
});

test('a fix can be cancelled or can fail, and stays on offer either way', { skip }, async () => {
  const rig = await makeRig();
  try {
    const { s, of, clear } = await session(chain(rig), createProject(rig.dir, 'blink', 'blink'));
    await s.handle({ t: 'start' }); clear();
    rig.answer = 'half';
    const going = s.handle({ t: 'fix' });
    await until(() => of('setup').some((m) => m.fraction !== undefined && m.fraction > 0), 'the download to be under way');
    await s.handle({ t: 'fix' });                                   // a second press while it runs changes nothing
    await s.handle({ t: 'cancelFix' }); await going;
    assert.equal(of('setup').at(-1)!.state, 'cancelled'); assert.equal(rig.hits(), 1);
    rig.answer = 'file'; process.env.FAKE_MODE = 'core-fails'; clear();
    await s.handle({ t: 'fix' });
    const failed = of('setup').at(-1)!;
    assert.equal(failed.state, 'failed'); assert.match(failed.text, /something broke/);
    delete process.env.FAKE_MODE; clear();
    await s.handle({ t: 'fix' });
    assert.equal(of('setup').at(-1)!.state, 'done'); assert.equal(of('status').at(-1)!.state, 'running');
    s.dispose();
  } finally { await rig.close(); }
});

test('a missing library is installed at a press, and a Mac without Rosetta is given the command', { skip }, async () => {
  const rig = await makeRig();
  try {
    const mine = theirs(rig); mine.installed();
    const tc = chain(rig, { path: mine.bin });
    process.env.FAKE_MODE = 'needs-servo';
    const a = await session(tc, createProject(rig.dir, 'servo', 'blink'));
    await a.s.handle({ t: 'start' });
    assert.equal(a.of('error')[0].fix, 'Install the Servo library (a small download)');
    a.clear(); await a.s.handle({ t: 'fix' });
    assert.deepEqual(rig.commands().filter((c) => c.startsWith('lib ')), ['lib update-index', 'lib install Servo']);
    assert.equal(a.of('status').at(-1)!.state, 'running'); a.s.dispose();

    process.env.FAKE_MODE = 'rosetta';
    const b = await session(tc, createProject(rig.dir, 'mac', 'button'));
    await b.s.handle({ t: 'start' });
    const e = b.of('error')[0];
    assert.equal(e.command, 'softwareupdate --install-rosetta --agree-to-license'); assert.equal(e.fix, undefined); assert.match(e.message, /Rosetta/);
    b.clear(); await b.s.handle({ t: 'fix' }); assert.deepEqual(b.of('setup'), [], 'a command is for the person to run, not Shibo');
    b.s.dispose();
  } finally { await rig.close(); }
});
