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

export const CLI_VERSION = '1.6.0';

/** The arduino-cli download for each kind of computer (platform-arch), with the SHA-256 from Arduino's 1.6.0-checksums.txt. */
export const CLI_ASSETS: Record<string, { file: string; sha256: string }> = {
  'linux-x64': { file: 'Linux_64bit.tar.gz', sha256: '321ee249f44c78053234fec0f36101092bc6021bf24939e15e0cc2449c5ed250' },
  'linux-arm64': { file: 'Linux_ARM64.tar.gz', sha256: '2ed4e1436bb3be1265966af8eba95dd25e28f3a9f92d0a58d371ed14dbaf550f' },
  'linux-arm': { file: 'Linux_ARMv7.tar.gz', sha256: '4936285be94c9327d8bc44124123789ed9bf6c0288bf826a4c2dd1ba98548667' },
  'darwin-x64': { file: 'macOS_64bit.tar.gz', sha256: 'af6a30cf5f57cc076b45fe55c6fd389440156f70706e7f8d3302a11a9fe32913' },
  'darwin-arm64': { file: 'macOS_ARM64.tar.gz', sha256: 'dc70f037fcbc8e7add892282bed5bab5eac317ff00bf0dd2f21e4a8e1d338a1c' },
  'win32-x64': { file: 'Windows_64bit.zip', sha256: '2769b9b282ce597db9679d8ec14d726d57004ca4205ef4d7a795bf36b6cdc9d8' },
  'win32-arm64': { file: 'Windows_ARM64.zip', sha256: 'ac31be09fcb5ca34af5450ba5a3106ea23394561d6a187cb9f4074756d18b0c6' },
};

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
  cancelled: 'Setup was cancelled. Nothing was installed.',
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

/** Fetch a file, following redirects, and return its SHA-256. The file is only as good as that checksum says. */
function download(url: string, file: string, o: SetupOptions, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e: unknown) => { if (!settled) { settled = true; reject(e); } };
    const req = (url.startsWith('https:') ? https : http).get(url, { signal: o.signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return fail(oops('network'));
        settled = true;
        return void download(new URL(res.headers.location, url).href, file, o, redirects - 1).then(resolve, reject);
      }
      if (status !== 200) { res.resume(); return fail(oops('network')); }
      const total = Number(res.headers['content-length']) || 0;
      const hash = createHash('sha256'); const out = fs.createWriteStream(file);
      let got = 0;
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk); got += chunk.length;
        o.progress?.({ text: 'Downloading the Arduino compiler', ...(total ? { fraction: Math.min(1, got / total) } : {}) });
      });
      res.on('error', fail); out.on('error', fail);
      res.on('aborted', () => fail(o.signal?.aborted ? oops('cancelled') : oops('network')));
      out.on('finish', () => { if (!settled) { settled = true; resolve(hash.digest('hex')); } });
      res.pipe(out);
    });
    req.on('error', (e: NodeJS.ErrnoException) => fail(o.signal?.aborted ? oops('cancelled') : e.code === 'ENOSPC' ? oops('disk') : oops('network')));
  });
}

function unpack(archive: string, into: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // The system's tar reads .tar.gz everywhere and .zip on Windows 10 and later.
    execFile('tar', ['-xf', archive, '-C', into], { signal, windowsHide: true }, (err) => {
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
  const tmp = path.join(ownDir, 'tmp'), checked = path.join(ownDir, 'checked');
  try {
    const have = fs.existsSync(own.cli) && fs.existsSync(checked) && fs.readFileSync(checked, 'utf8').trim() === asset.sha256;
    if (!have) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(path.join(tmp, 'unpack'), { recursive: true });
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
      fs.rmSync(checked, { force: true });
      fs.renameSync(unpacked, own.cli);
      fs.chmodSync(own.cli, 0o755);
      fs.writeFileSync(checked, asset.sha256 + '\n');
    }
    await installCore(own, 'arduino:avr', o);
    // arduino-cli keeps every archive it downloaded; unpacked, they are only taking up room.
    fs.rmSync(own.env.ARDUINO_DIRECTORIES_DOWNLOADS, { recursive: true, force: true });
    fs.writeFileSync(path.join(ownDir, 'ready'), JSON.stringify({ version: CLI_VERSION }) + '\n');
    return own;
  } catch (err) {
    throw asSetupError(err, o.signal);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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
