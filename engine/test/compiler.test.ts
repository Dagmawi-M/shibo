// Which Arduino compiler a build uses, and whether the board package is there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findCompiler, settingMissing, ownCompiler, ownReady, runCli, boardPackage, type Where } from '../src/compiler.ts';

const posix = process.platform !== 'win32';
const scratch = () => mkdtempSync(path.join(tmpdir(), 'shibo c-'));        // a space, as in "Application Support"
const program = (file: string, body = 'exit 0') => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return file; };

test('the compiler is looked for in order: the setting, the PATH, the usual places, Shibo\'s own copy', { skip: !posix }, () => {
  const t = scratch(), home = path.join(t, 'home'), ownDir = path.join(t, 'own');
  const setting = program(path.join(t, 'chosen', 'arduino-cli'));
  const onPath = program(path.join(t, 'bin', 'arduino-cli'));
  const known = program(path.join(home, '.local', 'bin', 'arduino-cli'));
  const own = program(ownCompiler(ownDir).cli); writeFileSync(path.join(ownDir, 'ready'), '{}');
  const w: Where = { setting, ownDir, home, env: { PATH: `${path.join(t, 'empty')}${path.delimiter}${path.join(t, 'bin')}` }, platform: 'linux' };
  let c = findCompiler(w)!; assert.equal(c.origin, 'setting'); assert.equal(c.cli, setting); assert.deepEqual([c.args, c.env], [[], {}]);
  rmSync(setting); c = findCompiler(w)!; assert.equal(c.origin, 'path'); assert.equal(c.cli, onPath);
  assert.equal(settingMissing(w), true, 'the setting names a file that is not there');
  assert.equal(settingMissing({ ...w, setting: '' }), false); assert.equal(settingMissing({ ...w, setting: undefined }), false);
  rmSync(onPath); c = findCompiler(w)!; assert.equal(c.origin, 'known'); assert.equal(c.cli, known);
  rmSync(known); c = findCompiler(w)!; assert.equal(c.origin, 'own'); assert.equal(c.cli, own);
  assert.equal(c.env.ARDUINO_DIRECTORIES_DATA, path.join(ownDir, 'data'));
  assert.equal(c.env.ARDUINO_DIRECTORIES_DOWNLOADS, path.join(ownDir, 'staging'));
  assert.equal(c.env.ARDUINO_UPDATER_ENABLE_NOTIFICATION, 'false');
  rmSync(path.join(ownDir, 'ready'));
  assert.equal(ownReady(ownDir), false); assert.equal(findCompiler(w), null, 'a copy that was never finished is not used');
  // A folder with the right name is not a program.
  mkdirSync(path.join(t, 'bin', 'arduino-cli')); assert.equal(findCompiler(w), null);
});

test('on Windows and macOS the usual places include the Arduino IDE\'s own copy', () => {
  const seen: string[] = [];
  const none = (p: string) => { seen.push(p); return false; };
  findCompiler({ platform: 'win32', home: 'C:\\Users\\u', env: { PATH: 'C:\\tools;C:\\bin', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, exists: none });
  assert.ok(seen.includes('C:\\tools\\arduino-cli.exe') && seen.includes('C:\\bin\\arduino-cli.exe'), 'the PATH is searched for the .exe');
  assert.ok(seen.includes('C:\\Users\\u\\AppData\\Local\\Programs\\Arduino IDE\\resources\\app\\lib\\backend\\resources\\arduino-cli.exe'));
  assert.ok(seen.includes('C:\\Program Files\\Arduino IDE\\resources\\app\\lib\\backend\\resources\\arduino-cli.exe'));
  const win = findCompiler({ platform: 'win32', home: 'C:\\Users\\u', env: { PATH: 'C:\\tools' }, exists: (p) => p === 'C:\\tools\\arduino-cli.exe' })!;
  assert.deepEqual([win.origin, win.cli], ['path', 'C:\\tools\\arduino-cli.exe']);

  seen.length = 0;
  findCompiler({ platform: 'darwin', home: '/Users/u', env: { PATH: '/usr/bin' }, exists: none });
  for (const p of ['/usr/bin/arduino-cli', '/opt/homebrew/bin/arduino-cli', '/usr/local/bin/arduino-cli', '/Users/u/.local/bin/arduino-cli',
    '/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli']) assert.ok(seen.includes(p), p);
  assert.equal(ownCompiler('C:\\s\\compiler', 'win32').cli, 'C:\\s\\compiler\\arduino-cli.exe');
});

test('running the compiler: its arguments first, its settings on top, stopped on request', { skip: !posix }, async () => {
  const t = scratch(), said = path.join(t, 'said.txt');
  const cli = program(path.join(t, 'cli'), `echo "$MARK|$*" > "${said}"; echo out; echo err >&2; [ "$1" = fail ] && exit 2; [ "$3" = wait ] && sleep 30; exit 0`);
  const c = { cli, origin: 'path' as const, args: ['--a', 'b'], env: { MARK: 'm' } };
  const heard: string[] = [];
  const r = await runCli(c, ['x'], { onOutput: (s) => heard.push(s) });
  assert.equal(r.ok, true); assert.match(r.out, /out/); assert.match(r.out, /err/); assert.equal(r.enoent, false);
  assert.equal(readFileSync(said, 'utf8').trim(), 'm|--a b x'); assert.ok(heard.join('').includes('out'));
  assert.equal((await runCli({ ...c, args: [] }, ['fail'])).ok, false);
  const gone = await runCli({ ...c, cli: path.join(t, 'nope') }, ['x']); assert.deepEqual([gone.ok, gone.enoent], [false, true]);
  const stop = new AbortController(); const started = Date.now();
  const waiting = runCli(c, ['wait'], { signal: stop.signal }); setTimeout(() => stop.abort(), 150);
  assert.equal((await waiting).ok, false); assert.ok(Date.now() - started < 5000, 'it did not wait for the program to finish');
});

test('the board package is looked for in the compiler\'s own folders, without starting a download', { skip: !posix }, async () => {
  const t = scratch(), ownDir = path.join(t, 'own');
  const own = ownCompiler(ownDir); program(own.cli, 'echo "must not run" >&2; exit 9');
  assert.equal(await boardPackage(own), 'absent');
  mkdirSync(path.join(ownDir, 'data', 'packages', 'arduino', 'hardware', 'avr', '1.8.8'), { recursive: true });
  assert.equal(await boardPackage(own), 'present');
  assert.equal(await boardPackage(own, 'ATTinyCore:avr'), 'absent');
  mkdirSync(path.join(ownDir, 'data', 'packages', 'arduino', 'hardware', 'empty'), { recursive: true });
  assert.equal(await boardPackage(own, 'arduino:empty'), 'absent', 'a folder with no version in it is not an installed package');

  // Someone's own compiler: ask it where its data is (a question that fetches nothing), then look there.
  const data = path.join(t, 'their data');
  const theirs = { cli: program(path.join(t, 'theirs'), `[ "$1 $2 $3" = "config get directories.data" ] && { echo "${data}"; exit 0; }; exit 7`), origin: 'path' as const, args: [], env: {} };
  assert.equal(await boardPackage(theirs), 'absent');
  mkdirSync(path.join(data, 'packages', 'arduino', 'hardware', 'avr', '1.8.6'), { recursive: true });
  assert.equal(await boardPackage(theirs), 'present');
  // An old or odd compiler that cannot answer: unknown, so the build is tried as before.
  assert.equal(await boardPackage({ ...theirs, cli: program(path.join(t, 'old'), 'exit 1') }), 'unknown');
  assert.equal(await boardPackage({ ...theirs, cli: program(path.join(t, 'odd'), 'echo relative/path') }), 'unknown');
});
