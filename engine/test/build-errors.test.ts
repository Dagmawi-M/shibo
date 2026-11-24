// Real builds: what a failed one reports, and what it reports when there is no compiler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSketch } from '../src/build.ts';
import { createProject } from '../src/templates.ts';
import { Session, type OutMsg } from '../src/session.ts';

const scratch = () => mkdtempSync(path.join(tmpdir(), 'shibo-be-'));
const broken = (parent: string) => {
  const dir = createProject(parent, 'Typo', 'blink');
  writeFileSync(path.join(dir, 'typo.ino'), 'void setup() { pinMode(13, OUTPUT) }\nvoid loop() {}\n');
  return dir;
};

test('a sketch with a mistake reports the compiler\'s error first, in its own file name', async () => {
  const t = scratch();
  const r = await buildSketch(broken(t), 'uno', path.join(t, 'cache'));
  assert.equal(r.ok, false); assert.equal(r.need, undefined);
  assert.match(r.log.split('\n')[0], /^typo\.ino:1:\d+: error: expected ';'/);
  assert.ok(!r.log.includes('\x1b') && !r.log.includes('Command failed') && !r.log.includes(t), r.log);
});

test('with no compiler the build says so and offers the download, without starting anything', async () => {
  const t = scratch(); const dir = createProject(t, 'blink', 'blink');
  const none = await buildSketch(dir, 'uno', path.join(t, 'cache'), null);
  assert.equal(none.ok, false); assert.deepEqual(none.need?.fix, { kind: 'compiler' }); assert.equal(none.log, none.need!.message);

  const before = process.env.PATH; process.env.PATH = '/nonexistent';
  try {
    const r = await buildSketch(dir, 'uno', path.join(t, 'cache2'));
    assert.deepEqual(r.need?.fix, { kind: 'compiler' });
  } finally { process.env.PATH = before; }
});

test('the session passes the error on as it is', async () => {
  const t = scratch();
  const s = new Session({ build: (d, b) => buildSketch(d, b, path.join(t, 'cache')) }); const out: OutMsg[] = [];
  s.onMessage((m) => out.push(m));
  await s.handle({ t: 'open', dir: broken(t) }); await s.handle({ t: 'start' });
  const e = out.find((m) => m.t === 'error') as { message: string };
  assert.match(e.message.split('\n')[0], /^typo\.ino:1:\d+: error: /);
  s.dispose();
});

test('a given compiler is the one that runs, with its own arguments and settings', async () => {
  const t = scratch(); const dir = createProject(t, 'blink', 'blink');
  const said = path.join(t, 'said.txt');
  const fake = path.join(t, 'fake cli.sh');
  writeFileSync(fake, `#!/bin/sh\necho "$MARK|$*" > "${said}"\nexit 3\n`, { mode: 0o755 });
  const r = await buildSketch(dir, 'uno', path.join(t, 'cache'), { cli: fake, args: ['--config-file', '/x.yaml'], env: { MARK: 'mine' } });
  assert.equal(r.ok, false);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(said, 'utf8'), /^mine\|--config-file \/x\.yaml --no-color compile -b arduino:avr:uno /);
});
