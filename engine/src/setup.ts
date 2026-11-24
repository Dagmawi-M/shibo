// "Set up for me": download the Arduino compiler into Shibo's own folder, check
// it is the file Arduino published, install the board package with it, and
// install what else a sketch turns out to need. Nothing here runs unless the
// person asked for it.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { ownCompiler, ownReady, runCli, type Compiler } from './compiler.ts';
import type { CompilerRun } from './build.ts';

import { CLI_ASSETS, CLI_VERSION } from './assets.ts';
export { CLI_ASSETS, CLI_VERSION };

/** Where a step of setup has got to: what is happening and, when it can be measured, how far along (0 to 1). */
export interface Step { text: string; fraction?: number }

/** `progress` and `signal` are for the person watching; the rest lets tests stand in for Arduino's server and this computer. */
export interface SetupOptions {
  progress?: (s: Step) => void;
  signal?: AbortSignal;
  base?: string;
  assets?: Record<string, { file: string; sha256: string }>;
  platform?: string;
  arch?: string;
}

/** Why setup stopped. The message is a plain sentence for the person. */
export class SetupError extends Error {
  kind: 'network' | 'checksum' | 'disk' | 'unsupported' | 'cancelled' | 'failed';
  constructor(kind: SetupError['kind'], message: string) { super(message); this.kind = kind; this.name = 'SetupError'; }
}

const SAY = {
  network: 'The download did not get through. Check the internet connection, then try again.',
  checksum: 'The downloaded file is not the one Arduino published, so it was not used. This can happen on a network that shows a sign-in page first. Try again on another connection.',
  disk: 'There is not enough free disk space to finish. Free some space, then try again.',
  unsupported: 'Shibo cannot download the Arduino compiler for this kind of computer. Install arduino-cli yourself, then run the sketch again.',
  cancelled: 'Setup was cancelled. You can start it again at any time.',
};
const oops = (kind: keyof typeof SAY) => new SetupError(kind, SAY[kind]);
const BASE = 'https://downloads.arduino.cc/arduino-cli/';

/** Turn whatever went wrong into the SetupError that says it best. */
function asSetupError(err: unknown, signal?: AbortSignal): SetupError {
  if (err instanceof SetupError) return err;
  if (signal?.aborted) return oops('cancelled');
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'ENOSPC') return oops('disk');
  return new SetupError('failed', `Setup did not finish: ${e?.message ?? String(err)}`);
}

/** Where a redirect leads, or null if it must not be followed: never from a secure address to an insecure one, never to anything but the web. */
export function redirectTarget(from: string, location: string): string | null {
  let to: URL;
  try { to = new URL(location, from); } catch { return null; }
  if (to.protocol !== 'https:' && to.protocol !== 'http:') return null;
  if (from.startsWith('https:') && to.protocol !== 'https:') return null;
  return to.href;
}

/** Fetch a file, following redirects, and return its SHA-256. The file is only as good as that checksum says. */
function download(url: string, file: string, o: SetupOptions, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false, out: fs.WriteStream | null = null;
    // However it ends badly, nothing is left open: an open file cannot be deleted on Windows.
    const fail = (e: unknown) => { if (settled) return; settled = true; out?.destroy(); req.destroy(); reject(e); };
    const req = (url.startsWith('https:') ? https : http).get(url, { signal: o.signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = redirectTarget(url, res.headers.location);
        if (redirects <= 0 || !next) return fail(oops('network'));
        settled = true;
        return void download(next, file, o, redirects - 1).then(resolve, reject);
      }
      if (status !== 200) { res.resume(); return fail(oops('network')); }
      const total = Number(res.headers['content-length']) || 0;
      const hash = createHash('sha256'); const sink = out = fs.createWriteStream(file);
      let got = 0;
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk); got += chunk.length;
        o.progress?.({ text: 'Downloading the Arduino compiler', ...(total ? { fraction: Math.min(1, got / total) } : {}) });
      });
      res.on('error', fail); sink.on('error', fail);
      res.on('aborted', () => fail(o.signal?.aborted ? oops('cancelled') : oops('network')));
      sink.on('finish', () => { if (!settled) { settled = true; resolve(hash.digest('hex')); } });
      res.pipe(sink);
    });
    req.on('error', (e: NodeJS.ErrnoException) => fail(o.signal?.aborted ? oops('cancelled') : e.code === 'ENOSPC' ? oops('disk') : oops('network')));
  });
}

/**
 * The tar to unpack with. On Windows it is the system's own (it reads .zip, and
 * a tar from Git or MSYS that happens to come first on the PATH does not).
 */
export function tarProgram(platform: string = process.platform, env: Record<string, string | undefined> = process.env): string {
  return platform === 'win32' ? path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

function unpack(archive: string, into: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // The system's tar reads .tar.gz everywhere and .zip on Windows 10 and later.
    execFile(tarProgram(), ['-xf', archive, '-C', into], { signal, windowsHide: true }, (err) => {
      if (!err) return resolve();
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new SetupError('unsupported', 'This computer has no "tar" program to unpack the download with. Install arduino-cli yourself, then run the sketch again.'));
      reject(err);
    });
  });
}

/** Run one arduino-cli step of setup and turn a failure into words. */
async function step(c: CompilerRun, args: string[], o: SetupOptions, say: (line: string) => Step | null): Promise<void> {
  const r = await runCli(c, args, { signal: o.signal, onOutput: (text) => {
    for (const line of text.split(/[\r\n]+/)) { const s = line.trim() && say(line.trim()); if (s) o.progress?.(s); }
  } });
  if (r.ok) return;
  if (o.signal?.aborted) throw oops('cancelled');
  if (/no such host|dial tcp|i\/o timeout|connection re(fused|set)|network is unreachable|TLS handshake|context deadline/i.test(r.out)) throw oops('network');
  if (/no space left/i.test(r.out)) throw oops('disk');
  const last = r.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
  throw new SetupError('failed', `Setup did not finish: ${r.enoent ? 'the compiler could not be started.' : last || 'the compiler stopped without saying why.'}`);
}

/** "name 12.00 MiB / 34.00 MiB 35.29%" from arduino-cli becomes a fraction of that one download. */
const measured = (text: string) => (line: string): Step | null => {
  const pct = /(\d+(?:\.\d+)?)%/.exec(line);
  return pct ? { text, fraction: Math.min(1, Number(pct[1]) / 100) } : { text };
};

/** Install a board package ("arduino:avr") with the given compiler. */
export async function installCore(c: CompilerRun, pkg: string, o: SetupOptions = {}): Promise<void> {
  const what = pkg === 'arduino:avr' ? 'the Arduino board package' : `the ${pkg} board package`;
  o.progress?.({ text: 'Getting the list of board packages' });
  await step(c, ['core', 'update-index'], o, () => null);
  o.progress?.({ text: `Installing ${what}` });
  await step(c, ['core', 'install', pkg], o, measured(`Installing ${what}`));
}

/** Install a library by its name in Arduino's library manager, with whatever it depends on. */
export async function installLibrary(c: CompilerRun, name: string, o: SetupOptions = {}): Promise<void> {
  o.progress?.({ text: 'Getting the list of libraries' });
  await step(c, ['lib', 'update-index'], o, () => null);
  o.progress?.({ text: `Installing the ${name} library` });
  await step(c, ['lib', 'install', name], o, measured(`Installing the ${name} library`));
}

/**
 * Download arduino-cli into `ownDir`, check it against Arduino's published
 * checksum, unpack it, and install the Arduino board package with it. The
 * folder only counts as set up once all of that has worked (the `ready` file
 * is written last), and a compiler that was already checked is not fetched again.
 */
export async function installCompiler(ownDir: string, o: SetupOptions = {}): Promise<Compiler> {
  const platform = (o.platform ?? process.platform) as NodeJS.Platform;
  const asset = (o.assets ?? CLI_ASSETS)[`${platform}-${o.arch ?? process.arch}`];
  if (!asset) throw oops('unsupported');
  const own = ownCompiler(ownDir, platform);
  if (ownReady(ownDir, platform)) return own;
  const checked = path.join(ownDir, 'checked');
  const have = () => fs.existsSync(own.cli) && fs.existsSync(checked) && fs.readFileSync(checked, 'utf8').trim() === asset.sha256;
  let tmp = '';
  try {
    if (!have()) {
      // A folder of this run's own: two windows may be setting up at once.
      fs.mkdirSync(ownDir, { recursive: true });
      tmp = fs.mkdtempSync(path.join(ownDir, 'tmp-'));
      fs.mkdirSync(path.join(tmp, 'unpack'));
      const name = `arduino-cli_${CLI_VERSION}_${asset.file}`, archive = path.join(tmp, name + '.part');
      o.progress?.({ text: 'Downloading the Arduino compiler', fraction: 0 });
      const sum = await download((o.base ?? BASE) + name, archive, o);
      if (sum !== asset.sha256) throw oops('checksum');
      o.progress?.({ text: 'Unpacking the Arduino compiler' });
      // tar picks the format from the name on some systems, so give the checked file its real name first.
      fs.renameSync(archive, path.join(tmp, name));
      await unpack(path.join(tmp, name), path.join(tmp, 'unpack'), o.signal);
      const unpacked = path.join(tmp, 'unpack', path.basename(own.cli));
      if (!fs.existsSync(unpacked)) throw new SetupError('failed', 'Setup did not finish: the download did not contain the compiler.');
      if (!have()) {                                                   // unless another window put the same checked file there meanwhile
        fs.rmSync(checked, { force: true });
        fs.renameSync(unpacked, own.cli);
        fs.chmodSync(own.cli, 0o755);
        fs.writeFileSync(checked, asset.sha256 + '\n');
      }
    }
    await installCore(own, 'arduino:avr', o);
    // arduino-cli keeps every archive it downloaded; unpacked, they are only taking up room.
    fs.rmSync(own.env.ARDUINO_DIRECTORIES_DOWNLOADS, { recursive: true, force: true });
    fs.writeFileSync(path.join(ownDir, 'ready'), JSON.stringify({ version: CLI_VERSION }) + '\n');
    return own;
  } catch (err) {
    throw asSetupError(err, o.signal);
  } finally {
    // Tidying up must never hide what really happened.
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left for the next run or for Remove */ } }
  }
}

/** Take Shibo's own compiler, its board packages and its downloads away again. */
export async function removeCompiler(ownDir: string): Promise<void> {
  await fs.promises.rm(ownDir, { recursive: true, force: true });
}

/** How much disk a folder takes, in bytes; 0 if it is not there. */
export function folderSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += folderSize(p);
    else { try { total += fs.lstatSync(p).size; } catch { /* gone meanwhile */ } }
  }
  return total;
}
