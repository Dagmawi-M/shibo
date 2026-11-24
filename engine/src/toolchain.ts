// Everything about compiling a sketch on this computer behind one object: which
// compiler to use, the build itself, what is missing when a build cannot be
// made, and the repairs that put it right. The VS Code extension and the
// standalone app each make one and share it between their sessions.
import fs from 'node:fs';
import path from 'node:path';
import { buildSketch, packageOf, type BuildResult } from './build.ts';
import { needCore, type Fix } from './builderror.ts';
import { boardPackage, findCompiler, settingMissing, type Compiler, type Where } from './compiler.ts';
import { installCompiler, installCore, installLibrary, removeCompiler, folderSize, SetupError, type SetupOptions, type Step } from './setup.ts';
import { findNgspice } from './electrical/spice.ts';

/** What is installed and what is not, for the setup check. */
export interface SetupStatus {
  /** `ownBytes`: how much Shibo's own download takes on disk, whenever there is one, in use or not, finished or not. */
  compiler: { found: boolean; origin?: Compiler['origin']; path?: string; settingMissing: boolean; ownBytes?: number };
  avr: 'present' | 'absent' | 'unknown';
  attiny: 'present' | 'absent' | 'unknown';
  /** The circuit checker. `how` says how to get it on this kind of computer. */
  ngspice: { found: boolean; how: string };
  /** A sketch can be compiled: there is a compiler, and the Arduino board package is not known to be missing. */
  ready: boolean;
}

const NGSPICE_HOW: Record<string, string> = {
  linux: 'Install it with your package manager, for example: sudo pacman -S ngspice, or: sudo apt install ngspice',
  darwin: 'Install it with Homebrew: brew install ngspice',
  win32: 'Download it from https://ngspice.sourceforge.io/download.html',
};

export class Toolchain {
  private o: { ownDir: string; cacheDir?: string; setting?: () => string | undefined; where?: Where; setup?: SetupOptions };
  /** The one repair that is running, shared by everyone who asked for it. */
  private flight: { key: string; promise: Promise<void>; listeners: Set<(s: Step) => void>; stop: AbortController } | null = null;
  private building = 0;
  /** Board packages already seen for a compiler: they do not go away, so they are not looked for twice. */
  private seen = new Set<string>();

  /**
   * `ownDir`: where Shibo keeps the compiler it downloads. `cacheDir`: where builds are kept.
   * `setting`: reads the person's chosen compiler path each time. `where` and `setup` are for tests.
   */
  constructor(o: Toolchain['o']) { this.o = o; }

  private where(): Where { return { ...this.o.where, setting: this.o.setting?.(), ownDir: this.o.ownDir }; }

  /** The compiler a build would use now, or null. */
  find(): Compiler | null { return findCompiler(this.where()); }

  /** A build or a repair is running. */
  get busy(): boolean { return this.building > 0 || this.flight !== null; }

  private async hasPackage(c: Compiler, pkg: string): Promise<'present' | 'absent' | 'unknown'> {
    const key = `${c.cli}\n${pkg}`;
    if (this.seen.has(key)) return 'present';
    const r = await boardPackage(c, pkg);
    if (r === 'present') this.seen.add(key);
    return r;
  }

  /**
   * Compile the sketch in a folder for a board type. When the compiler or the
   * board package is missing the answer says so (`need`) and nothing is
   * started, so nothing is ever downloaded without the person asking.
   */
  async build(dir: string, board: string): Promise<BuildResult> {
    this.building++;
    try {
      const c = this.find(), pkg = packageOf(board);
      const sketch = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.ino'));
      // Only the Arduino package is looked for ahead of time: other packages can live in places this check does not know.
      if (c && pkg === 'arduino:avr' && sketch && await this.hasPackage(c, pkg) === 'absent') {
        const need = needCore(pkg, c);
        return { ok: false, log: need.message, need };
      }
      return await buildSketch(dir, board, this.o.cacheDir, c);
    } finally { this.building--; }
  }

  private async carryOut(fix: Fix, o: SetupOptions): Promise<void> {
    if (fix.kind === 'compiler') { await installCompiler(this.o.ownDir, o); return; }
    const c = this.find() ?? await installCompiler(this.o.ownDir, o);
    if (fix.kind === 'core') await installCore(c, fix.pkg, o);
    else await installLibrary(c, fix.name, o);
  }

  /**
   * Put right what a failed build needed. Asking for the same repair while it
   * runs joins it (one download, however many presses); aborting any caller's
   * signal stops it for all. Rejects with a SetupError whose message is for the person.
   */
  repair(fix: Fix, progress: (s: Step) => void, signal: AbortSignal): Promise<void> {
    const key = JSON.stringify(fix);
    if (this.flight && this.flight.key !== key) return Promise.reject(new SetupError('failed', 'Another setup step is still running. Wait for it to finish, then try again.'));
    if (!this.flight) {
      const stop = new AbortController(), listeners = new Set<(s: Step) => void>();
      const o: SetupOptions = { ...this.o.setup, signal: stop.signal, progress: (s) => { for (const l of listeners) l(s); } };
      const flight = { key, listeners, stop, promise: Promise.resolve() };
      flight.promise = this.carryOut(fix, o).finally(() => { if (this.flight === flight) this.flight = null; });
      this.flight = flight;
    }
    const f = this.flight;
    f.listeners.add(progress);
    if (signal.aborted) f.stop.abort(); else signal.addEventListener('abort', () => f.stop.abort(), { once: true });
    return f.promise;
  }

  /** What is installed, for the setup check. Looks at folders only; starts no download. */
  async status(): Promise<SetupStatus> {
    const w = this.where(), c = this.find();
    const avr = c ? await boardPackage(c, 'arduino:avr') : 'absent';
    const attiny = c ? await boardPackage(c, 'ATTinyCore:avr') : 'absent';
    const platform = w.platform ?? process.platform;
    const spice = findNgspice();
    const onPath = (w.env ?? process.env).PATH?.split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, platform === 'win32' ? 'ngspice.exe' : 'ngspice'))) ?? false;
    return {
      compiler: { found: !!c, ...(c ? { origin: c.origin, path: c.cli } : {}), settingMissing: settingMissing(w), ...(fs.existsSync(this.o.ownDir) ? { ownBytes: folderSize(this.o.ownDir) } : {}) },
      avr, attiny,
      ngspice: { found: spice !== null && (spice !== 'ngspice' || onPath), how: NGSPICE_HOW[platform] ?? NGSPICE_HOW.linux },
      ready: !!c && avr !== 'absent',
    };
  }

  /** Delete the compiler Shibo downloaded, with its board packages. Refused while it is in use. */
  async remove(): Promise<void> {
    if (this.busy) throw new Error('The compiler is in use. Wait for the build or the setup to finish, then try again.');
    this.seen.clear();
    await removeCompiler(this.o.ownDir);
  }
}
