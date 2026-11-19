// A scriptable stand-in board plus a circuit, for testing parts at exact times.
import { Engine } from '../../src/engine.ts';
import { Circuit } from '../../src/circuit.ts';
import type { ChipBackend, I2CHandler, Level, PinDrive } from '../../src/types.ts';
import type { Project } from '../../src/project.ts';

export function rig(parts: { id: string; type: string; attrs?: Record<string, string> }[], wires: [string, string][], quantumNs = 100_000) {
  const drives = new Map<string, PinDrive>([['5V', { pin: '5V', level: 1 }], ['GND', { pin: 'GND', level: 0 }]]);
  const cbs: (() => void)[] = []; const inputs: Record<string, Level> = {}; const analog: Record<string, number> = {};
  const edges: [string, Level, number][] = [];
  let t = 0, end = 0; let script: [number, () => void][] = []; let i2c: I2CHandler | null = null; let spi: ((b: number) => number) | null = null;
  const b: ChipBackend = {
    id: 'u',
    runUntil(x) { end = x; while (script.length && script[0][0] <= end) { const [at, fn] = script.shift()!; t = Math.max(t, at); fn(); } t = Math.max(t, end); },
    interrupt(x) { end = Math.min(end, x); },
    nowNs: () => t,
    drives: () => [...drives.values()],
    setInput(p, l) { if (inputs[p] !== l) { inputs[p] = l; edges.push([p, l, t]); } },
    setAnalog(p, v) { analog[p] = v; },
    onChange(cb) { cbs.push(cb); }, onSerial() {}, serialWrite() {},
    onI2C(h) { i2c = h; }, i2cPins: { sda: 'A4', scl: 'A5' }, onSPI(f) { spi = f; }, spiPins: { mosi: '11', miso: '12', sck: '13' },
    saveState: () => t, restoreState(s) { t = s as number; },
  };
  const engine = new Engine({ quantumNs }); engine.addBackend(b);
  const project: Project = { version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }, ...parts.map((p) => ({ x: 0, y: 0, ...p }))], wires: wires.map(([from, to]) => ({ from, to })), boards: [] };
  const circuit = new Circuit(engine, project, { u: b });
  const set = (pin: string, level: Level | 'pullup' | 'input') => {
    if (level === 'input') drives.delete(pin); else if (level === 'pullup') drives.set(pin, { pin, level: null, pull: 'up' }); else drives.set(pin, { pin, level });
    cbs.forEach((c) => c());
  };
  return {
    engine, circuit, inputs, analog, edges, set,
    /** Drive a board pin at an exact time (ns). */
    at(time: number, pin: string, level: Level | 'pullup' | 'input') { script.push([time, () => set(pin, level)]); script.sort((a, c) => a[0] - c[0]); },
    run(ms: number) { engine.runUntil(Math.round(ms * 1e6)); },
    out: (id: string) => circuit.outputs()[id] ?? {},
    show: (id: string) => circuit.display()[id] ?? {},
    control: (id: string, name: string, v: number) => circuit.setControl(id, name, v),
    i2c: () => i2c!, spi: (byte: number) => spi!(byte),
    edgesOf: (pin: string) => edges.filter(([p]) => p === pin).map(([, l, at]) => [l, at] as [Level, number]),
  };
}
