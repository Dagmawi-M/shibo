#!/usr/bin/env node
// Headless runner:
//   shibo run <projectDir> [--ms N] [--press id@t[:dur]] [--set id.control=value@t]
//                [--serial text@t] [--expect text] [--rewind-check t]
// Times are milliseconds of simulated time.
// Exit 0 ok, 1 a check failed, 2 bad input, 3 the sketch did not build.
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/engine.ts';
import { Circuit } from '../src/circuit.ts';
import { UnoBackend } from '../src/backends/avr.ts';
import { buildUno } from '../src/build.ts';
import { importWokwi, validate } from '../src/project.ts';

const MS = 1e6;
const USAGE = 'usage: shibo run <projectDir> [--ms N] [--press id@t[:dur]] [--set id.control=value@t] [--serial text@t] [--expect text] [--rewind-check t]';
function bad(msg: string): never { console.error(msg); process.exit(2); }

const [cmd, dir, ...args] = process.argv.slice(2);
if (cmd !== 'run' || !dir) bad(USAGE);
const projectDir = path.resolve(dir);
const diagramPath = path.join(projectDir, 'diagram.json');
if (!fs.existsSync(diagramPath)) bad(`no diagram.json in ${projectDir}`);

let ms = 2000; let rewindAt: number | null = null;
const expects: string[] = [];
type Ev = { t: number; what: string; control?: [string, string, number]; fn: (c: Circuit, serial: (s: string) => void) => void };
const events: Ev[] = [];
const num = (s: string | undefined, what: string): number => {
  const n = Number(s);
  if (s === undefined || s === '' || !Number.isFinite(n) || n < 0) bad(`${what}: "${s}" is not a time or number\n${USAGE}`);
  return n;
};
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i], v = args[i + 1];
  if (v === undefined) bad(`${flag} needs a value\n${USAGE}`);
  switch (flag) {
    case '--ms': ms = num(v, '--ms'); break;
    case '--expect': expects.push(v); break;
    case '--rewind-check': rewindAt = num(v, '--rewind-check'); break;
    case '--press': {
      const m = /^(.+)@([\d.]+)(?::([\d.]+))?$/.exec(v) ?? bad(`--press wants id@time[:duration], got "${v}"`);
      const t = num(m[2], '--press'), d = m[3] === undefined ? 200 : num(m[3], '--press');
      events.push({ t, what: `--press ${v}`, control: [m[1], 'pressed', 1], fn: (c) => c.setControl(m[1], 'pressed', 1) });
      events.push({ t: t + d, what: `--press ${v} (release)`, fn: (c) => c.setControl(m[1], 'pressed', 0) });
      break;
    }
    case '--set': {
      const m = /^(.+)\.([^.=]+)=([^@]+)@([\d.]+)$/.exec(v) ?? bad(`--set wants id.control=value@time, got "${v}"`);
      if (m[3].trim() === '' || !Number.isFinite(Number(m[3]))) bad(`--set ${v}: "${m[3]}" is not a number`);
      events.push({ t: num(m[4], '--set'), what: `--set ${v}`, control: [m[1], m[2], Number(m[3])], fn: (c) => c.setControl(m[1], m[2], Number(m[3])) });
      break;
    }
    case '--serial': {
      const m = /^(.*)@([\d.]+)$/s.exec(v) ?? bad(`--serial wants text@time, got "${v}"`);
      events.push({ t: num(m[2], '--serial'), what: `--serial`, fn: (_c, serial) => serial(m[1].replace(/\\n/g, '\n')) });
      break;
    }
    default: bad(`unknown option ${flag}\n${USAGE}`);
  }
}
for (const e of events) {
  // A release may land after the end of the run; only the start of an event must fit.
  if (e.t > ms && !e.what.endsWith('(release)')) bad(`${e.what}: time ${e.t} ms is after the end of the run (${ms} ms)`);
}
if (rewindAt !== null && rewindAt > ms) bad(`--rewind-check: time ${rewindAt} ms is after the end of the run (${ms} ms)`);

let imported: ReturnType<typeof importWokwi>;
try { imported = importWokwi(JSON.parse(fs.readFileSync(diagramPath, 'utf8'))); }
catch (err) { bad(`cannot read ${diagramPath}: ${(err as Error).message}`); }
const { project, unmapped } = imported;
for (const u of unmapped) console.error(`note: no model for ${u}; it is drawn but does nothing`);
const problems = validate(project);
if (problems.length) bad(problems.join('\n'));
const board = project.boards[0];
if (!board) bad('this project has no board the engine can run yet (only the Arduino Uno so far)');

const built = await buildUno(projectDir);
if (!built.ok) { console.error(`the sketch did not build:\n${built.log}`); process.exit(3); }

const engine = new Engine();
const uno = new UnoBackend(board.part, built.hex!);
engine.addBackend(uno);
const circuit = new Circuit(engine, project, { [board.part]: uno });

// Serial bytes become log lines; the half-built line is state, so it rewinds too.
const serial = { line: '', all: '' };
engine.addStateful({ saveState: () => ({ ...serial }), restoreState: (s) => Object.assign(serial, s) });
uno.onSerial((b) => {
  const ch = String.fromCharCode(b); serial.all += ch;
  if (ch === '\n') { engine.record(`serial ${serial.line.replace(/\r$/, '')}`); serial.line = ''; } else serial.line += ch;
});

for (const e of events) {
  if (!e.control) continue;
  try { circuit.checkControl(...e.control); } catch (err) { bad(`${e.what}: ${(err as Error).message}`); }
}
for (const e of events) if (e.t <= ms) engine.at(e.t * MS, () => e.fn(circuit, (s) => { for (const ch of s) uno.serialWrite(ch.charCodeAt(0)); }));

let status = 0;
if (rewindAt !== null) {
  engine.runUntil(rewindAt * MS);
  const snap = engine.snapshot();
  engine.runUntil(ms * MS);
  const first = [...engine.log];
  engine.restore(snap);
  engine.runUntil(ms * MS);
  const same = first.length === engine.log.length && first.every((l, i) => l === engine.log[i]);
  print(engine.log);
  console.log(same ? `rewind check: identical (${first.length} log lines, rewound to ${rewindAt} ms)` : 'rewind check: DIFFERENT');
  if (!same) status = 1;
} else {
  engine.runUntil(ms * MS);
  print(engine.log);
}
if (serial.line) console.log(`[${ms.toFixed(3).padStart(10)} ms] serial (no newline yet) ${serial.line}`);
for (const n of circuit.contended()) { console.error(`still shorted at the end: ${n} (two outputs driving one net to different levels)`); status = 1; }
for (const e of expects) if (!serial.all.includes(e)) { console.error(`expected serial text not seen: ${e}`); status = 1; }
if (expects.length && status === 0) console.log('PASS');
process.exit(status);

function print(log: string[]): void {
  for (const l of log) {
    const i = l.indexOf(' ');
    console.log(`[${(Number(l.slice(0, i)) / MS).toFixed(3).padStart(10)} ms] ${l.slice(i + 1)}`);
  }
}
