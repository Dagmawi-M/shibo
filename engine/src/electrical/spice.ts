// One long-lived ngspice process, fed netlists line by line, answering
// operating points. If ngspice is not there, everything still works: the
// solver just says it is unavailable and parts show as unchecked.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Solution { ok: true; values: Map<string, number> }
export interface Failure { ok: false; reason: string }
export type Result = Solution | Failure;

const TIMEOUT_MS = 5000;
const NO_SPICE = 'ngspice was not found, so voltages and currents are not checked. Install ngspice, or set SHIBO_NGSPICE to its path.';

/**
 * Where ngspice is: the path given, else $SHIBO_NGSPICE, else "ngspice" on the PATH.
 * Returns null when a given path does not exist.
 */
export function findNgspice(given?: string | null): string | null {
  const p = given ?? process.env.SHIBO_NGSPICE ?? '';
  if (!p) return 'ngspice';
  return fs.existsSync(p) ? p : null;
}

/** Environment for an unpacked ngspice (bin/ngspice next to lib/ and share/ngspice/). */
function envFor(bin: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (bin.includes(path.sep)) {
    const root = path.dirname(path.dirname(bin));
    const lib = path.join(root, 'lib'), share = path.join(root, 'share', 'ngspice');
    if (fs.existsSync(lib)) env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${lib}${path.delimiter}${env.LD_LIBRARY_PATH}` : lib;
    if (fs.existsSync(share)) { env.SPICE_LIB_DIR = share; env.SPICE_SCRIPTS = path.join(share, 'scripts'); }
  }
  return env;
}

export class Spice {
  private bin: string | null;
  private proc: ChildProcess | null = null;
  private buf = '';
  private dead = '';                  // why the solver cannot be used, once we know
  private queue: { cmds: string; mark: string; done: (out: string | null) => void }[] = [];
  private current: { mark: string; done: (out: string | null) => void; timer: NodeJS.Timeout } | null = null;
  private n = 0;

  constructor(bin?: string | null) {
    this.bin = findNgspice(bin);
    if (!this.bin) this.dead = NO_SPICE;
  }

  /** Why the solver cannot be used, or '' if it can (as far as we know yet). */
  get unavailable(): string { return this.dead; }

  private start(): boolean {
    if (this.proc) return true;
    if (this.dead || !this.bin) return false;
    let p: ChildProcess;
    try { p = spawn(this.bin, ['-p'], { env: envFor(this.bin), stdio: ['pipe', 'pipe', 'pipe'] }); } catch { this.dead = NO_SPICE; return false; }
    this.proc = p;
    p.stdout!.setEncoding('utf8');
    p.stdout!.on('data', (d: string) => { this.buf += d; this.check(); });
    p.stderr!.on('data', () => {});            // ngspice chatters about code models it could not load; none are used
    p.stdin!.on('error', () => {});
    p.on('error', () => { this.dead = NO_SPICE; this.fail(); });
    p.on('exit', () => { if (this.proc === p) { this.proc = null; this.fail(); } });
    return true;
  }

  /** The process went away: whatever was waiting gets nothing, and the next call starts afresh. */
  private fail(): void {
    const cur = this.current; this.current = null; this.buf = '';
    if (cur) { clearTimeout(cur.timer); cur.done(null); }
    if (this.dead) for (const q of this.queue.splice(0)) q.done(null);
    else this.next();
  }

  private check(): void {
    const cur = this.current;
    if (!cur) return;
    const at = this.buf.indexOf(cur.mark);
    if (at < 0) return;
    const out = this.buf.slice(0, at); this.buf = this.buf.slice(at + cur.mark.length);
    clearTimeout(cur.timer); this.current = null;
    cur.done(out);
    this.next();
  }

  private next(): void {
    if (this.current || !this.queue.length || !this.start()) return;
    const q = this.queue.shift()!;
    const timer = setTimeout(() => { this.proc?.kill(); }, TIMEOUT_MS);       // a hung solve: restart the process
    this.current = { mark: q.mark, done: q.done, timer };
    this.proc!.stdin!.write(q.cmds);
  }

  private run(lines: string[]): Promise<string | null> {
    const mark = `__shibo_${++this.n}__`;
    return new Promise((done) => {
      if (this.dead) { done(null); return; }
      this.queue.push({ cmds: lines.join('\n') + `\necho ${mark}\n`, mark, done });
      this.next();
    });
  }

  /** Solve the DC operating point of a netlist (title line first, no .end). Values are keyed lower-case. */
  async op(netlist: string[]): Promise<Result> {
    const out = await this.run(['destroy all', ...netlist.map((l) => `circbyline ${l}`), 'circbyline .end', 'op', 'print all', 'remcirc']);
    if (out === null) return { ok: false, reason: this.dead || 'the circuit solver stopped unexpectedly' };
    const values = new Map<string, number>();
    for (const m of out.matchAll(/^(?:ngspice \d+ -> )?([\w#.]+) = ([-+0-9.eE]+|nan|inf)\s*$/gm)) values.set(m[1].toLowerCase(), Number(m[2]));
    if (/simulation\(s\) aborted|singular matrix/i.test(out) || !values.size) {
      // A process that never answers sensibly at all is not ngspice.
      if (!/ngspice|circuit/i.test(out)) { this.dead = NO_SPICE; this.proc?.kill(); }
      return { ok: false, reason: 'the circuit solver could not find a steady state for this circuit' };
    }
    return { ok: true, values };
  }

  close(): void {
    this.dead ||= 'closed';
    const p = this.proc; this.proc = null;
    if (p) { p.stdin!.end('quit\n'); setTimeout(() => p.kill(), 200).unref(); }
    this.fail();
  }
}
