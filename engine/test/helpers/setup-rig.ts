// A stand-in for Arduino's download server and for arduino-cli itself, so the
// whole "set up for me" path can be tested without the network.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const FAKE_CLI = path.resolve(import.meta.dirname, '..', 'fixtures', 'fake-cli.sh');

export interface Rig {
  /** A folder whose path has a space in it, as Shibo's storage has on every Mac. */
  dir: string;
  ownDir: string;
  /** Options for setup.ts: the local server, the archive's real checksum, and a fixed platform. */
  setup: { base: string; assets: Record<string, { file: string; sha256: string }>; platform: string; arch: string };
  /** How the server answers the next requests. */
  answer: 'file' | 'html' | 'redirect' | 'half' | 'down';
  /** How many times the archive was asked for. */
  hits(): number;
  /** Every command the stand-in compiler was given, in order. */
  commands(): string[];
  /** Let a held 'half' download finish. */
  release(): void;
  close(): Promise<void>;
}

export async function makeRig(): Promise<Rig> {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo setup-'));
  const pack = path.join(dir, 'pack'); mkdirSync(pack);
  copyFileSync(FAKE_CLI, path.join(pack, 'arduino-cli'));
  const file = 'Linux_64bit.tar.gz', full = `arduino-cli_1.6.0_${file}`;
  execFileSync('tar', ['-czf', path.join(dir, full), '-C', pack, 'arduino-cli']);
  const bytes = readFileSync(path.join(dir, full));
  const log = path.join(dir, 'commands.log');
  process.env.FAKE_LOG = log; process.env.FAKE_STATE = dir;
  process.env.FAKE_HEX = path.resolve(import.meta.dirname, '..', 'fixtures', 'blink.hex');
  let hits = 0; const held: http.ServerResponse[] = [];
  const rig = { answer: 'file' } as Rig;
  const server = http.createServer((req, res) => {
    if (req.url === '/moved/' + full) { res.writeHead(302, { location: '/' + full }); return void res.end(); }
    if (req.url !== '/' + full) { res.writeHead(404); return void res.end(); }
    hits++;
    if (rig.answer === 'redirect') { rig.answer = 'file'; hits--; res.writeHead(302, { location: '/moved/' + full }); return void res.end(); }
    if (rig.answer === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return void res.end('<html>Please sign in to the hotel wifi</html>'); }
    res.writeHead(200, { 'content-length': bytes.length });
    if (rig.answer === 'half') { res.write(bytes.subarray(0, bytes.length >> 1)); held.push(res); return; }
    res.end(bytes);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  Object.assign(rig, {
    dir, ownDir: path.join(dir, 'Application Support', 'compiler'),
    setup: { base: `http://127.0.0.1:${port}/`, assets: { 'linux-x64': { file, sha256: createHash('sha256').update(bytes).digest('hex') } }, platform: 'linux', arch: 'x64' },
    hits: () => hits,
    commands: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    release: () => { for (const r of held.splice(0)) r.destroy(); },
    close: () => new Promise<void>((r) => { for (const h of held.splice(0)) h.destroy(); for (const k of ['FAKE_LOG', 'FAKE_MODE', 'FAKE_STATE', 'FAKE_HEX']) delete process.env[k]; server.closeAllConnections(); server.close(() => r()); }),
  });
  return rig;
}
