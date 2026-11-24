// Finding the Arduino compiler (arduino-cli) on this computer, and running it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompilerRun } from './build.ts';

/**
 * A compiler and where it came from: the person's setting, the PATH, one of
 * the usual places, or the copy Shibo downloaded for itself.
 */
export interface Compiler extends CompilerRun { origin: 'setting' | 'path' | 'known' | 'own' }

/** Where to look. Everything has a default taken from this computer; tests give their own. */
export interface Where {
  /** The path in the shibo.arduinoCli setting, if the person set one. */
  setting?: string;
  /** The folder Shibo keeps its own copy in. */
  ownDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  home?: string;
  /** Is there a program at this path? */
  exists?: (file: string) => boolean;
}

const isProgram = (file: string): boolean => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
};

const paths = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);
const programName = (platform: NodeJS.Platform) => (platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');

/** Shibo's own copy: where it is and the settings it runs with, whether or not it has been downloaded yet. */
export function ownCompiler(ownDir: string, platform: NodeJS.Platform = process.platform): Compiler {
  const p = paths(platform);
  return { cli: p.join(ownDir, programName(platform)), origin: 'own', args: [],
    env: { ARDUINO_DIRECTORIES_DATA: p.join(ownDir, 'data'), ARDUINO_DIRECTORIES_DOWNLOADS: p.join(ownDir, 'staging'), ARDUINO_UPDATER_ENABLE_NOTIFICATION: 'false' } };
}

/** Shibo's own copy is complete: the program is there and setup wrote its marker after the board package went in. */
export function ownReady(ownDir: string, platform: NodeJS.Platform = process.platform, exists: (f: string) => boolean = isProgram): boolean {
  return exists(ownCompiler(ownDir, platform).cli) && fs.existsSync(paths(platform).join(ownDir, 'ready'));
}

/** The person set a compiler in the settings, and no program is there. */
export function settingMissing(w: Where = {}): boolean {
  const s = w.setting?.trim();
  return !!s && !(w.exists ?? isProgram)(s);
}

/** The usual places a compiler is installed to that may not be on the PATH, the Arduino IDE's own copy among them. */
function knownPlaces(platform: NodeJS.Platform, home: string, env: Record<string, string | undefined>): string[] {
  const p = paths(platform), name = programName(platform);
  const inIde = ['resources', 'app', 'lib', 'backend', 'resources', name];
  if (platform === 'win32') {
    return [env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs', 'Arduino IDE', ...inIde),
      env.ProgramFiles && p.join(env.ProgramFiles, 'Arduino IDE', ...inIde)].filter((x): x is string => !!x);
  }
  const places = [p.join(home, '.local', 'bin', name), p.join(home, 'bin', name), '/usr/local/bin/' + name, '/opt/homebrew/bin/' + name];
  if (platform === 'darwin') {
    for (const apps of ['/Applications', p.join(home, 'Applications')]) places.push(p.join(apps, 'Arduino IDE.app', 'Contents', 'Resources', 'app', 'lib', 'backend', 'resources', name));
  }
  return places;
}

/**
 * The compiler a build should use, or null when there is none. First match
 * wins: the setting, the PATH, the usual places, Shibo's own copy.
 */
export function findCompiler(w: Where = {}): Compiler | null {
  const platform = w.platform ?? process.platform, env = w.env ?? process.env, home = w.home ?? os.homedir();
  const exists = w.exists ?? isProgram;
  const p = paths(platform), name = programName(platform);
  const found = (cli: string, origin: Compiler['origin']): Compiler => ({ cli, origin, args: [], env: {} });

  const setting = w.setting?.trim();
  if (setting && exists(setting)) return found(setting, 'setting');
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (dir && exists(p.join(dir, name))) return found(p.join(dir, name), 'path');
  }
  for (const file of knownPlaces(platform, home, env)) if (exists(file)) return found(file, 'known');
  if (w.ownDir && ownReady(w.ownDir, platform, exists)) return ownCompiler(w.ownDir, platform);
  return null;
}

/** Run the compiler with some arguments. Never rejects: `ok` says whether it finished well, `enoent` that it could not be started at all. */
export function runCli(c: CompilerRun, args: string[], o: { signal?: AbortSignal; onOutput?: (text: string) => void } = {}): Promise<{ ok: boolean; out: string; enoent: boolean }> {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (ok: boolean, enoent = false) => { if (!done) { done = true; resolve({ ok, out, enoent }); } };
    if (o.signal?.aborted) return finish(false);
    const child = spawn(c.cli, [...c.args, ...args], { env: { ...process.env, ...c.env }, signal: o.signal, windowsHide: true });
    const hear = (b: Buffer) => { const s = b.toString(); out += s; o.onOutput?.(s); };
    // A stopped program may leave helpers behind that still hold its output open: do not wait for them.
    o.signal?.addEventListener('abort', () => { child.stdout.destroy(); child.stderr.destroy(); }, { once: true });
    child.stdout.on('data', hear); child.stderr.on('data', hear);
    child.on('error', (err: NodeJS.ErrnoException) => finish(false, err.code === 'ENOENT'));
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * Is a board package ("arduino:avr") installed for this compiler? Answered by
 * looking in the compiler's data folder, never by anything that could start a
 * download. 'unknown' when the folder cannot be learned: the build is then
 * tried as it always was.
 */
export async function boardPackage(c: CompilerRun, pkg = 'arduino:avr'): Promise<'present' | 'absent' | 'unknown'> {
  let data = c.env.ARDUINO_DIRECTORIES_DATA;
  if (!data) {
    const r = await runCli(c, ['config', 'get', 'directories.data']);
    data = r.ok ? r.out.trim().split(/\r?\n/).pop()!.trim() : '';
    if (!data || !path.isAbsolute(data)) return 'unknown';
  }
  const [vendor, arch] = pkg.split(':');
  try { return fs.readdirSync(path.join(data, 'packages', vendor, 'hardware', arch)).length ? 'present' : 'absent'; }
  catch { return 'absent'; }
}
