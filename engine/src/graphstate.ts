// Snapshot and restore a graph of live objects in place.
//
// An emulator's state is spread over many objects that hold references to
// each other and to callbacks. Copying it would break those references, so
// instead we remember the contents of every object reachable from the roots
// and later write those contents back into the same objects.

type Saved =
  | { kind: 'typed'; target: any; copy: any }
  | { kind: 'array'; target: any[]; copy: any[] }
  | { kind: 'set'; target: Set<any>; copy: any[] }
  | { kind: 'map'; target: Map<any, any>; copy: [any, any][] }
  | { kind: 'object'; target: any; copy: Record<string, any> };

export type GraphState = Saved[];

export function captureGraph(roots: unknown[]): GraphState {
  const seen = new Set<unknown>();
  const out: Saved[] = [];
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v instanceof ArrayBuffer || v instanceof DataView) return;      // views over arrays we save directly
    if (ArrayBuffer.isView(v)) { out.push({ kind: 'typed', target: v, copy: (v as any).slice() }); return; }
    if (Array.isArray(v)) { out.push({ kind: 'array', target: v, copy: [...v] }); v.forEach(visit); return; }
    if (v instanceof Set) { out.push({ kind: 'set', target: v, copy: [...v] }); v.forEach(visit); return; }
    if (v instanceof Map) { out.push({ kind: 'map', target: v, copy: [...v] }); v.forEach((x, k) => { visit(k); visit(x); }); return; }
    const copy: Record<string, any> = {};
    for (const k of Object.keys(v)) copy[k] = (v as any)[k];
    out.push({ kind: 'object', target: v, copy });
    for (const k of Object.keys(copy)) visit(copy[k]);
  };
  roots.forEach(visit);
  return out;
}

export function restoreGraph(state: GraphState): void {
  for (const s of state) {
    switch (s.kind) {
      case 'typed': s.target.set(s.copy); break;
      case 'array': s.target.length = 0; s.target.push(...s.copy); break;
      case 'set': s.target.clear(); for (const x of s.copy) s.target.add(x); break;
      case 'map': s.target.clear(); for (const [k, x] of s.copy) s.target.set(k, x); break;
      case 'object':
        for (const k of Object.keys(s.target)) if (!(k in s.copy)) delete s.target[k];
        for (const k of Object.keys(s.copy)) {
          const d = Object.getOwnPropertyDescriptor(s.target, k);
          if (!d || d.writable) s.target[k] = s.copy[k];
        }
        break;
    }
  }
}
