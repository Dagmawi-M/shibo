import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const STARTER = new URL('./fixtures/starter', import.meta.url).pathname;
const cli = new URL('../bin/shibo.ts', import.meta.url).pathname;
const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'run', STARTER, ...args], { encoding: 'utf8' });

test('starter: button press is reported', () => {
  const r = run('--ms', '1500', '--press', 'btn1@300:100', '--expect', 'LED ON');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /out led1\.lit=true/);
});

test('starter: a missing expected text fails the run', () => {
  const r = run('--ms', '1500', '--expect', 'LED ON');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /expected serial text not seen: LED ON/);
});

test('starter: rewind reproduces the run', () => {
  const r = run('--ms', '1500', '--press', 'btn1@300:100', '--expect', 'LED ON', '--rewind-check', '200');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /rewind check: identical/);
});

test('two runs print identical logs', () => {
  const a = run('--ms', '1500', '--press', 'btn1@300:100'), b = run('--ms', '1500', '--press', 'btn1@300:100');
  assert.equal(a.status, 0, a.stderr);
  assert.ok(a.stdout.length > 0);
  assert.equal(a.stdout, b.stdout);
});

test('an event after the end is rejected', () => {
  const r = run('--ms', '100', '--press', 'btn1@500');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /500/);
});

test('an unknown part or control is rejected', () => {
  const r = run('--ms', '100', '--press', 'nope@50');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope/);
});
