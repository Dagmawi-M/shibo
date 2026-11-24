// "Set up for me": download the compiler, check it, install the board package, and take it away again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installCompiler, installCore, installLibrary, removeCompiler, folderSize, tarProgram, redirectTarget, SetupError, CLI_ASSETS, CLI_VERSION, type Step } from '../src/setup.ts';
import { ownCompiler, ownReady, boardPackage } from '../src/compiler.ts';
import { makeRig } from './helpers/setup-rig.ts';

const skip = process.platform === 'win32';
const fails = async (p: Promise<unknown>, kind: SetupError['kind']) => {
  const err = await p.then(() => null, (e) => e);
  assert.ok(err instanceof SetupError, `expected a ${kind} failure, got ${err}`); assert.equal(err.kind, kind);
  assert.ok(err.message.length > 20 && !/[!]/.test(err.message), err.message);
  return err as SetupError;
};
const leftovers = (ownDir: string) => (existsSync(ownDir) ? readdirSync(ownDir).filter((f) => f.startsWith('tmp') || f.endsWith('.part')) : []);

test('the published checksums are the ones Arduino lists for 1.6.0', () => {
  assert.equal(CLI_VERSION, '1.6.0');
  assert.deepEqual(CLI_ASSETS, {
    'linux-x64': { file: 'Linux_64bit.tar.gz', sha256: '321ee249f44c78053234fec0f36101092bc6021bf24939e15e0cc2449c5ed250' },
    'linux-arm64': { file: 'Linux_ARM64.tar.gz', sha256: '2ed4e1436bb3be1265966af8eba95dd25e28f3a9f92d0a58d371ed14dbaf550f' },
    'linux-arm': { file: 'Linux_ARMv7.tar.gz', sha256: '4936285be94c9327d8bc44124123789ed9bf6c0288bf826a4c2dd1ba98548667' },
    'darwin-x64': { file: 'macOS_64bit.tar.gz', sha256: 'af6a30cf5f57cc076b45fe55c6fd389440156f70706e7f8d3302a11a9fe32913' },
    'darwin-arm64': { file: 'macOS_ARM64.tar.gz', sha256: 'dc70f037fcbc8e7add892282bed5bab5eac317ff00bf0dd2f21e4a8e1d338a1c' },
    'win32-x64': { file: 'Windows_64bit.zip', sha256: '2769b9b282ce597db9679d8ec14d726d57004ca4205ef4d7a795bf36b6cdc9d8' },
    'win32-arm64': { file: 'Windows_ARM64.zip', sha256: 'ac31be09fcb5ca34af5450ba5a3106ea23394561d6a187cb9f4074756d18b0c6' },
  });
});

test('setup downloads the compiler, installs the board package, and says how far along it is', { skip }, async () => {
  const rig = await makeRig();
  try {
    const steps: Step[] = [];
    const c = await installCompiler(rig.ownDir, { ...rig.setup, progress: (s) => steps.push(s) });
    assert.equal(c.origin, 'own'); assert.equal(c.cli, ownCompiler(rig.ownDir).cli);
    assert.deepEqual(rig.commands(), ['core update-index', 'core install arduino:avr']);
    assert.equal(ownReady(rig.ownDir), true); assert.equal(await boardPackage(c), 'present');
    assert.ok(steps.some((s) => s.fraction === 1), 'the download reached the end');
    assert.ok(steps.every((s) => s.text && (s.fraction === undefined || (s.fraction >= 0 && s.fraction <= 1))));
    assert.ok(steps.some((s) => /board package/i.test(s.text)));
    assert.deepEqual(leftovers(rig.ownDir), []);
    assert.equal(existsSync(path.join(rig.ownDir, 'staging')), false, 'the archives the board package came in are not kept');
    assert.ok(folderSize(rig.ownDir) > 0);
    // Doing it again is harmless and fetches nothing new.
    await installCompiler(rig.ownDir, rig.setup);
    assert.equal(rig.hits(), 1);
  } finally { await rig.close(); }
});

test('a file that is not the one Arduino published is never unpacked', { skip }, async () => {
  const rig = await makeRig();
  try {
    const wrong = { ...rig.setup, assets: { 'linux-x64': { ...rig.setup.assets['linux-x64'], sha256: 'f'.repeat(64) } } };
    await fails(installCompiler(rig.ownDir, wrong), 'checksum');
    rig.answer = 'html';                                         // a sign-in page in place of the file
    const err = await fails(installCompiler(rig.ownDir, rig.setup), 'checksum');
    assert.match(err.message, /not the one Arduino published/);
    assert.equal(ownReady(rig.ownDir), false); assert.equal(existsSync(ownCompiler(rig.ownDir).cli), false);
    assert.deepEqual(leftovers(rig.ownDir), []); assert.deepEqual(rig.commands(), []);
  } finally { await rig.close(); }
});

test('a redirect is followed, and no server at all is a network problem', { skip }, async () => {
  const rig = await makeRig();
  try {
    rig.answer = 'redirect';
    await installCompiler(rig.ownDir, rig.setup);
    assert.equal(ownReady(rig.ownDir), true);
    await removeCompiler(rig.ownDir);
    await fails(installCompiler(rig.ownDir, { ...rig.setup, base: 'http://127.0.0.1:1/' }), 'network');
    assert.equal(ownReady(rig.ownDir), false);
  } finally { await rig.close(); }
});

test('cancelling part way leaves nothing behind, and trying again works', { skip }, async () => {
  const rig = await makeRig();
  try {
    rig.answer = 'half';
    const stop = new AbortController(); let heard = false;
    const p = installCompiler(rig.ownDir, { ...rig.setup, signal: stop.signal, progress: (s) => { if (s.fraction && !heard) { heard = true; stop.abort(); } } });
    await fails(p, 'cancelled');
    assert.equal(ownReady(rig.ownDir), false); assert.deepEqual(leftovers(rig.ownDir), []);
    rig.answer = 'file';
    await installCompiler(rig.ownDir, rig.setup);
    assert.equal(ownReady(rig.ownDir), true);
  } finally { await rig.close(); }
});

test('if the board package does not go in, setup is not complete; the next try does not download the compiler again', { skip }, async () => {
  const rig = await makeRig();
  try {
    process.env.FAKE_MODE = 'core-fails';
    const err = await fails(installCompiler(rig.ownDir, rig.setup), 'failed');
    assert.match(err.message, /something broke/);
    assert.equal(ownReady(rig.ownDir), false);
    process.env.FAKE_MODE = 'offline';
    await fails(installCompiler(rig.ownDir, rig.setup), 'network');
    delete process.env.FAKE_MODE;
    await installCompiler(rig.ownDir, rig.setup);
    assert.equal(ownReady(rig.ownDir), true); assert.equal(rig.hits(), 1, 'the checked compiler was kept');
  } finally { await rig.close(); }
});

test('a computer Shibo has no compiler for is told so', async () => {
  const err = await fails(installCompiler('/nonexistent/x', { platform: 'sunos', arch: 'x64' }), 'unsupported');
  assert.match(err.message, /yourself/);
});

test('board packages and libraries are installed with the compiler in use', { skip }, async () => {
  const rig = await makeRig();
  try {
    const c = await installCompiler(rig.ownDir, rig.setup);
    const steps: Step[] = [];
    await installLibrary(c, 'Adafruit SSD1306', { progress: (s) => steps.push(s) });
    await installCore(c, 'arduino:avr');
    assert.deepEqual(rig.commands().slice(2), ['lib update-index', 'lib install Adafruit SSD1306', 'core update-index', 'core install arduino:avr']);
    assert.ok(steps.some((s) => /Adafruit SSD1306/.test(s.text)));
    const gone = { ...c, cli: path.join(rig.dir, 'nope') };
    await fails(installLibrary(gone, 'Servo'), 'failed');
  } finally { await rig.close(); }
});

test('the downloaded compiler can be removed', { skip }, async () => {
  const rig = await makeRig();
  try {
    await installCompiler(rig.ownDir, rig.setup);
    await removeCompiler(rig.ownDir);
    assert.equal(existsSync(rig.ownDir), false); assert.equal(ownReady(rig.ownDir), false);
    await removeCompiler(rig.ownDir);                              // nothing there: not an error
    mkdirSync(rig.ownDir, { recursive: true }); writeFileSync(path.join(rig.ownDir, 'x'), '12345');
    assert.equal(folderSize(rig.ownDir), 5); assert.equal(folderSize(path.join(rig.dir, 'nope')), 0);
  } finally { await rig.close(); }
});

test('a cancelled download says only what is true, and leaves no file open', { skip: skip || !existsSync('/proc/self/fd') }, async () => {
  const rig = await makeRig();
  try {
    const open = () => readdirSync('/proc/self/fd').length;
    const before = open();
    rig.answer = 'half';
    const stop = new AbortController(); let heard = false;
    const err = await fails(installCompiler(rig.ownDir, { ...rig.setup, signal: stop.signal, progress: (s) => { if (s.fraction && !heard) { heard = true; stop.abort(); } } }), 'cancelled');
    assert.ok(!/nothing was installed/i.test(err.message), 'a later step may already have put files in place');
    rig.release();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(open() <= before, `files or sockets were left open (${before} before, ${open()} after)`);
  } finally { await rig.close(); }
});

test('two windows setting up at once do not trip over each other', { skip }, async () => {
  const rig = await makeRig();
  try {
    const both = await Promise.allSettled([installCompiler(rig.ownDir, rig.setup), installCompiler(rig.ownDir, rig.setup)]);
    assert.deepEqual(both.map((r) => r.status), ['fulfilled', 'fulfilled']);
    assert.equal(ownReady(rig.ownDir), true); assert.deepEqual(leftovers(rig.ownDir), []);
  } finally { await rig.close(); }
});

test('on Windows the system\'s own tar unpacks the download, whatever else is on the PATH', () => {
  assert.equal(tarProgram('win32', { SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\tar.exe');
  assert.equal(tarProgram('win32', {}), 'C:\\Windows\\System32\\tar.exe');
  assert.equal(tarProgram('linux', {}), 'tar'); assert.equal(tarProgram('darwin', {}), 'tar');
});

test('a download is never sent on from a secure address to an insecure one', () => {
  assert.equal(redirectTarget('https://downloads.arduino.cc/a/x.tar.gz', '/b/x.tar.gz'), 'https://downloads.arduino.cc/b/x.tar.gz');
  assert.equal(redirectTarget('https://downloads.arduino.cc/a/x', 'https://cdn.example/x'), 'https://cdn.example/x');
  assert.equal(redirectTarget('https://downloads.arduino.cc/a/x', 'http://cdn.example/x'), null);
  assert.equal(redirectTarget('http://127.0.0.1:1/x', 'http://127.0.0.1:2/y'), 'http://127.0.0.1:2/y');
  assert.equal(redirectTarget('https://a/x', 'ftp://a/x'), null);
});
