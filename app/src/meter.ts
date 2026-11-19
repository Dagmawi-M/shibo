// The live meter: what a wire reads (voltage to GND, current along it) as the
// electrical layer last solved it. Shown when the pointer rests on a wire.
export interface Reading { volts: number; amps: number | null }
export interface ElectricalMsg { state: 'ok' | 'unchecked'; reason?: string; wires: (Reading | null)[]; parts: Record<string, 'ok' | 'warn' | 'unchecked'> }

const amps = (a: number): string => {
  const x = Math.abs(a);
  return x >= 1 ? `${x.toFixed(2)} A` : x >= 1e-3 ? `${(x * 1e3).toFixed(x >= 0.01 ? 1 : 2)} mA` : `${Math.round(x * 1e6)} µA`;
};

/** One line for a wire, `from → to` being the way it was drawn. */
export function meterText(m: ElectricalMsg | null, index: number, from: string, to: string): string {
  if (!m) return '';
  if (m.state === 'unchecked') return m.reason ? `Not measured: ${m.reason}` : 'Not measured';
  const r = m.wires[index];
  if (!r) return 'Not measured';
  const v = `${r.volts.toFixed(2)} V`;
  if (r.amps === null) return `${v} (current not measured on this wire: it closes a loop)`;
  if (Math.abs(r.amps) < 1e-6) return `${v}, no current`;
  return `${v}, ${amps(r.amps)} from ${r.amps > 0 ? from : to} to ${r.amps > 0 ? to : from}`;
}
