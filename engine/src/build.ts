import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cleanLog, diagnose, needCompiler, type Need } from './builderror.ts';

/** Said when there is nothing to compile. The session passes it on as it is. */
export const NO_SKETCH = 'There is no sketch yet. Write one, or use "Create sketch" to start from your circuit.';

/** Where builds go when the caller does not say: `.build/` beside the engine. */
const defaultCache = () => path.resolve(import.meta.dirname, '..', '..', '.build');

/** The arduino-cli board each board type compiles for. */
const FQBN: Record<string, string> = {
  uno: 'arduino:avr:uno',
  nano: 'arduino:avr:nano:cpu=atmega328',
  mega: 'arduino:avr:mega:cpu=atmega2560',
  // ATTinyCore's Micronucleus (Digispark) board, at 16 MHz: USB cannot be emulated, so no 16.5 MHz USB tuning.
  attiny85: 'ATTinyCore:avr:attinyx5micr:sketchclock=16pll',
};

/** The arduino-cli FQBN for a board type, or undefined if Shibo cannot compile for it. */
export function fqbnOf(board: string): string | undefined { return Object.hasOwn(FQBN, board) ? FQBN[board] : undefined; }

/** Compile for the Uno. */
export function buildUno(projectDir: string, cacheDir?: string) { return buildSketch(projectDir, 'uno', cacheDir); }

/** The program that compiles: where it is, what it is always given, and the settings it runs with. */
export interface CompilerRun { cli: string; args: string[]; env: Record<string, string> }

/** A build: the firmware, or why there is none. `need` says what is missing when the setup, not the sketch, is at fault. */
export interface BuildResult { ok: boolean; log: string; hex?: string; need?: Need }

/** The board package a board type is built with ("arduino:avr"). */
export function packageOf(board: string): string | undefined { return fqbnOf(board)?.split(':').slice(0, 2).join(':'); }

/**
 * Compile an Arduino sketch folder for a board type. The project folder is never
 * written to: sources are copied to a scratch folder, and a build is reused
 * while the sources are unchanged.
 *
 * `compiler` left out means arduino-cli from the PATH; null means none was found.
 */
export function buildSketch(projectDir: string, board: string, cacheDir?: string, compiler?: CompilerRun | null): Promise<BuildResult> {
  const fqbn = fqbnOf(board);
  if (!fqbn) return Promise.resolve({ ok: false, log: `Shibo cannot compile for a "${board}" board yet` });
  const BUILD = cacheDir ?? defaultCache();
  const files = fs.readdirSync(projectDir).filter((f) => /\.(ino|h|hpp|c|cpp)$/.test(f)).sort();
  const ino = files.find((f) => f.endsWith('.ino'));
  if (!ino) return Promise.resolve({ ok: false, log: NO_SKETCH });
  const hash = createHash('sha1');
  for (const f of files) hash.update(f).update(fs.readFileSync(path.join(projectDir, f)));
  const dir = path.join(BUILD, board + '-' + hash.digest('hex').slice(0, 16));
  const hexPath = path.join(dir, 'out', 'sk.ino.hex');
  if (fs.existsSync(hexPath)) return Promise.resolve({ ok: true, log: 'cached', hex: fs.readFileSync(hexPath, 'utf8') });

  if (compiler === null) { const need = needCompiler(); return Promise.resolve({ ok: false, log: need.message, need }); }
  const cli = compiler?.cli ?? 'arduino-cli';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'sk'), { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(projectDir, f), path.join(dir, 'sk', f === ino ? 'sk.ino' : f));
  return new Promise((resolve) => {
    execFile(cli, [...(compiler?.args ?? []), '--no-color', 'compile', '-b', fqbn, '--output-dir', path.join(dir, 'out'), path.join(dir, 'sk')],
      { maxBuffer: 1 << 24, env: { ...process.env, ...compiler?.env } }, (err, stdout, stderr) => {
        const log = stdout + stderr;
        if (err) {
          fs.rmSync(dir, { recursive: true, force: true });
          const enoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
          const need = diagnose(log, { enoent, cli, env: compiler?.env }) ?? undefined;
          if (need) return resolve({ ok: false, log: need.message, need });
          // Said once, in the sketch's own file name. With no output at all, the reason the program gave for stopping.
          return resolve({ ok: false, log: cleanLog(log, dir, ino) || err.message });
        }
        resolve({ ok: true, log, hex: fs.readFileSync(hexPath, 'utf8') });
      });
  });
}
