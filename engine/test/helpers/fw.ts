// Runs a real compiled sketch on the emulated Uno inside a circuit.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Engine } from '../../src/engine.ts';
import { Circuit } from '../../src/circuit.ts';
import { UnoBackend } from '../../src/backends/avr.ts';
import { buildUno } from '../../src/build.ts';
import type { Project } from '../../src/project.ts';

export async function fw(sketch: string, parts: { id: string; type: string; attrs?: Record<string, string> }[], wires: [string, string][]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-fw-'));
  writeFileSync(path.join(dir, 'fw.ino'), sketch);
  const built = await buildUno(dir);
  if (!built.ok) throw new Error('sketch did not build:\n' + built.log);
  const engine = new Engine(); const uno = new UnoBackend('u', built.hex!); engine.addBackend(uno);
  const project: Project = { version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, ...parts.map((p) => ({ x: 0, y: 0, ...p }))], wires: wires.map(([from, to]) => ({ from, to })), boards: [{ part: 'u', firmware: '' }] };
  const circuit = new Circuit(engine, project, { u: uno });
  let serial = ''; uno.onSerial((b) => { serial += String.fromCharCode(b); });
  return {
    engine, circuit, run: (ms: number) => engine.runUntil(engine.now + Math.round(ms * 1e6)),
    serial: () => serial, lines: () => serial.split(/\r?\n/).filter(Boolean),
    out: (id: string) => circuit.outputs()[id] ?? {}, show: (id: string) => circuit.display()[id] ?? {},
    control: (id: string, name: string, v: number) => circuit.setControl(id, name, v),
  };
}
/** Power wires for a part with the usual VCC and GND pins. */
export const power = (id: string, vcc = 'VCC', gnd = 'GND'): [string, string][] => [[`${id}:${vcc}`, 'u:5V'], [`${id}:${gnd}`, 'u:GND']];
