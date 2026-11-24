// The circuit solver must never be left running after the program that started
// it has gone: ngspice does not stop when its pipes close, it spins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { findNgspice } from '../src/electrical/index.ts';

const BIN = findNgspice() ?? 'ngspice';
const hasSpice = (() => { try { execFileSync(BIN, ['-v'], { stdio: 'ignore', timeout: 5000, env: { ...process.env, LD_LIBRARY_PATH: path.join(path.dirname(path.dirname(BIN)), 'lib') } }); return true; } catch { return false; } })();
const needs = { skip: !hasSpice ? 'ngspice is not installed' : process.platform === 'win32' ? 'checked on Linux and macOS' : false };
const holder = path.resolve(import.meta.dirname, 'fixtures', 'hold-spice.ts');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (pid: number) => { const t = Date.now(); while (alive(pid)) { if (Date.now() - t > 4000) return false; await new Promise((r) => setTimeout(r, 50)); } return true; };

/** Run the holder until it has said the solver's process id. */
const start = (how: 'exit' | 'stay', env: NodeJS.ProcessEnv = process.env) => new Promise<{ pid: number; child: ReturnType<typeof spawn> }>((resolve, reject) => {
  const child = spawn(process.execPath, [holder, how], { stdio: ['ignore', 'pipe', 'inherit'], env });
  let out = '';
  child.stdout!.on('data', (d) => { out += d; const m = /pid (\d+)/.exec(out); if (m) resolve({ pid: Number(m[1]), child }); });
  child.on('exit', () => { if (!/pid \d+/.test(out)) reject(new Error('the holder ended without starting the solver')); });
});

test('the solver stops when the program that started it ends without closing it', needs, async () => {
  const { pid } = await start('exit');
  assert.ok(await gone(pid), `ngspice ${pid} was left running`);
});

test('the solver stops even when the program that started it is killed outright', needs, async () => {
  const { pid, child } = await start('stay');
  assert.ok(alive(pid));
  child.kill('SIGKILL');
  try { assert.ok(await gone(pid), `ngspice ${pid} was left running`); }
  finally { if (alive(pid)) process.kill(pid); }
});

test('on a computer where the helper cannot work, the solver is left alone, not stopped', needs, async () => {
  // No PATH at all: the helper's "cat" is not found. The solver must still be there afterwards.
  const { pid, child } = await start('stay', { ...process.env, PATH: '/nonexistent', SHIBO_NGSPICE: BIN });
  await new Promise((r) => setTimeout(r, 600));
  try { assert.ok(alive(pid), 'the solver was killed by its own guard'); }
  finally { child.kill('SIGKILL'); if (alive(pid)) { try { process.kill(pid); } catch { /* gone */ } } }
});
