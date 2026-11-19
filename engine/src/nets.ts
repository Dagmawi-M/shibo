import type { Level } from './types.ts';

/** A connection between two nodes. Node names are "partId:pin". */
export type Link = { a: string; b: string; kind: 'wire' | 'resistor' };
export type Drive = { node: string; level: Level; pull?: 'up' | 'down' };

/**
 * The always-on logic layer. Wires merge nodes into nets. A net reads:
 * its strong driver; else a strong level reached through one resistor;
 * else a pull; else floating. Opposing strong drivers are "contended".
 * Resistors to both levels (a divider) read as floating here.
 */
export function resolve(links: Link[], drives: Drive[]): { level(node: string): Level; net(node: string): string; strong(node: string): boolean; contended: string[] } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const l of links) if (l.kind === 'wire') parent.set(find(l.a), find(l.b));

  const strong = new Map<string, Level>();
  const pulls = new Map<string, Level>();
  const bad = new Map<string, string>();           // net -> smallest node name on it
  for (const d of drives) {
    const net = find(d.node);
    if (d.level !== null) {
      if (strong.has(net) && strong.get(net) !== d.level) bad.set(net, d.node);
      else strong.set(net, d.level);
    }
    if (d.pull && !pulls.has(net)) pulls.set(net, d.pull === 'up' ? 1 : 0);
  }
  for (const [net] of bad) {
    strong.delete(net);
    const names = drives.filter((d) => find(d.node) === net && d.level !== null).map((d) => d.node).sort();
    bad.set(net, names[0]);
  }
  const resistors = links.filter((l) => l.kind === 'resistor');

  const level = (node: string): Level => {
    const net = find(node);
    if (bad.has(net)) return null;
    if (strong.has(net)) return strong.get(net)!;
    // Levels reaching this net through one resistor. If they disagree (a
    // divider), the logic layer cannot say; that is the analog layer's job.
    let via: Level = null;
    for (const r of resistors) {
      const a = find(r.a), b = find(r.b);
      const other = a === net ? b : b === net ? a : null;
      if (other === null || !strong.has(other)) continue;
      const l = strong.get(other)!;
      if (via !== null && via !== l) return null;
      via = l;
    }
    if (via !== null) return via;
    if (pulls.has(net)) return pulls.get(net)!;
    for (const r of resistors) {               // a pull on the far side of a resistor
      const a = find(r.a), b = find(r.b);
      if (a === net && pulls.has(b)) return pulls.get(b)!;
      if (b === net && pulls.has(a)) return pulls.get(a)!;
    }
    return null;
  };
  /** Is this net held by an output directly, with no resistor in between? */
  const isStrong = (node: string): boolean => { const net = find(node); return strong.has(net) && !bad.has(net); };
  return { level, net: find, strong: isStrong, contended: [...bad.values()].sort() };
}
