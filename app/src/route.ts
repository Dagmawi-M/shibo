// Wire geometry for the editor: square routes that go around parts, the bend
// points someone dragged in, and the rounded path that is drawn. Pure: no page.

export type Pt = [number, number];
export interface Rect { x: number; y: number; w: number; h: number }

const PAD = 12;              // how far a wire keeps clear of a part it goes round
const TURN = 18;             // what a corner costs, in canvas units of length
const THROUGH = 60;          // the cost of running across another part, per unit of length
const OWN = 3;               // ...and across the part a wire's own pin sits on
const MARGIN = 160;          // how far beyond its two ends a wire may wander

const inside = (x: number, y: number, r: Rect) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
const overlaps = (r: Rect, b: Rect) => r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y;
const sorted = (v: Set<number>) => [...v].sort((p, q) => p - q);

/**
 * A square (horizontal and vertical runs only) path from a to b that keeps off
 * the parts in `rects`. `own` are the parts the two pins sit on: a wire may
 * cross those to get out, at a small cost. Returns every corner, ends included.
 */
export function autoRoute(a: Pt, b: Pt, rects: Rect[], opts: { own?: Rect[] } = {}): Pt[] {
  const own = new Set(opts.own ?? []);
  const area: Rect = { x: Math.min(a[0], b[0]) - MARGIN, y: Math.min(a[1], b[1]) - MARGIN, w: Math.abs(a[0] - b[0]) + 2 * MARGIN, h: Math.abs(a[1] - b[1]) + 2 * MARGIN };
  const near = rects.filter((r) => overlaps(r, area));
  // The lines a route may run along: through both pins, halfway between them, and round every part near enough to matter.
  const xs = new Set([a[0], b[0], (a[0] + b[0]) / 2, area.x, area.x + area.w]), ys = new Set([a[1], b[1], (a[1] + b[1]) / 2, area.y, area.y + area.h]);
  for (const r of near) {
    for (const x of [r.x - PAD, r.x, r.x + r.w, r.x + r.w + PAD]) xs.add(Math.round(x));
    for (const y of [r.y - PAD, r.y, r.y + r.h, r.y + r.h + PAD]) ys.add(Math.round(y));
  }
  const X = sorted(xs).filter((x) => x >= area.x && x <= area.x + area.w), Y = sorted(ys).filter((y) => y >= area.y && y <= area.y + area.h);
  const nx = X.length, ny = Y.length;
  const ia = X.indexOf(a[0]) + nx * Y.indexOf(a[1]), ib = X.indexOf(b[0]) + nx * Y.indexOf(b[1]);
  if (ia === ib) return [a, b];

  /** What one step along a grid line costs, by how much of it lies over a part. */
  const stepCost = (x0: number, y0: number, x1: number, y1: number): number => {
    const len = Math.abs(x1 - x0) + Math.abs(y1 - y0), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    let k = 1;
    for (const r of near) if (inside(mx, my, r)) k = Math.max(k, own.has(r) ? OWN : THROUGH);
    return len * k;
  };
  // A* over (grid point, direction of arrival). Directions: 0 right, 1 down, 2 left, 3 up.
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const n = nx * ny * 4, best = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1);
  const bx = b[0], by = b[1];
  const h = (i: number) => Math.abs(X[i % nx] - bx) + Math.abs(Y[Math.floor(i / nx)] - by);
  const heap = new Heap();
  for (let d = 0; d < 4; d++) { best[ia * 4 + d] = 0; heap.push(ia * 4 + d, h(ia)); }
  let end = -1;
  while (heap.size) {
    const s = heap.pop(), node = s >> 2, dir = s & 3;
    if (node === ib) { end = s; break; }
    const cx = node % nx, cy = Math.floor(node / nx), g = best[s];
    for (let d = 0; d < 4; d++) {
      if (d === (dir + 2) % 4) continue;                    // never straight back
      const tx = cx + DX[d], ty = cy + DY[d];
      if (tx < 0 || ty < 0 || tx >= nx || ty >= ny) continue;
      const next = (tx + nx * ty) * 4 + d;
      const cost = g + stepCost(X[cx], Y[cy], X[tx], Y[ty]) + (d === dir || node === ia ? 0 : TURN);
      if (cost < best[next]) { best[next] = cost; from[next] = s; heap.push(next, cost + h(tx + nx * ty)); }
    }
  }
  if (end < 0) return simplify([a, [b[0], a[1]], b]);
  const path: Pt[] = [];
  for (let s = end; s >= 0; s = from[s]) { const node = s >> 2; path.push([X[node % nx], Y[Math.floor(node / nx)]]); }
  path.reverse();
  path[0] = a; path[path.length - 1] = b;
  return simplify(path);
}

/** The path through someone's bend points: each step goes across, then up or down. */
export function bendPath(a: Pt, points: Pt[], b: Pt): Pt[] {
  const all = [a, ...points, b], out: Pt[] = [a];
  for (let i = 1; i < all.length; i++) {
    const u = out[out.length - 1], v = all[i];
    if (u[0] !== v[0] && u[1] !== v[1]) out.push([v[0], u[1]]);
    out.push(v);
  }
  return simplify(out);
}

/** Drop repeated points and the middle of any straight run. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && q[0] === p[0] && q[1] === p[1]) continue;
    const o = out[out.length - 2];
    if (o && q && ((o[0] === q[0] && q[0] === p[0]) || (o[1] === q[1] && q[1] === p[1]))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** Which run of the path is closest to p. */
export function nearestSegment(pts: Pt[], p: Pt): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len)) : 0;
    const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Slide run `i` of the path sideways to pass through p. The two ends never
 * leave their pins: moving the first or last run adds a corner instead.
 */
export function dragSegment(pts: Pt[], i: number, p: Pt): Pt[] {
  let out = pts.map((q) => [q[0], q[1]] as Pt);
  const flat = out[i][1] === out[i + 1][1];           // a run across, so it moves up or down
  if (i === 0) { out = [[out[0][0], out[0][1]], ...out]; i = 1; }
  if (i + 1 === out.length - 1) out.push([out[out.length - 1][0], out[out.length - 1][1]]);
  const k = flat ? 1 : 0;
  out[i][k] = p[k]; out[i + 1][k] = p[k];
  return out;
}

const num = (v: number) => String(Math.round(v * 10) / 10);

/** SVG path data for the corners, with each corner rounded off. */
export function smoothPath(pts: Pt[], r = 6): string {
  if (pts.length < 2) return '';
  let d = `M${num(pts[0][0])} ${num(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], c = pts[i], q = pts[i + 1];
    const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]), l2 = Math.hypot(q[0] - c[0], q[1] - c[1]);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 0.5) { d += ` L${num(c[0])} ${num(c[1])}`; continue; }
    const s: Pt = [c[0] - ((c[0] - p[0]) / l1) * rr, c[1] - ((c[1] - p[1]) / l1) * rr], e: Pt = [c[0] + ((q[0] - c[0]) / l2) * rr, c[1] + ((q[1] - c[1]) / l2) * rr];
    d += ` L${num(s[0])} ${num(s[1])} Q${num(c[0])} ${num(c[1])} ${num(e[0])} ${num(e[1])}`;
  }
  const z = pts[pts.length - 1];
  return `${d} L${num(z[0])} ${num(z[1])}`;
}

/** A small binary min-heap of integer keys by priority. */
class Heap {
  private keys: number[] = []; private pri: number[] = [];
  get size(): number { return this.keys.length; }
  push(k: number, p: number): void {
    const K = this.keys, P = this.pri; let i = K.length; K.push(k); P.push(p);
    while (i > 0) { const up = (i - 1) >> 1; if (P[up] <= p) break; K[i] = K[up]; P[i] = P[up]; i = up; }
    K[i] = k; P[i] = p;
  }
  pop(): number {
    const K = this.keys, P = this.pri, top = K[0], k = K.pop()!, p = P.pop()!;
    if (K.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= K.length) break;
        if (c + 1 < K.length && P[c + 1] < P[c]) c++;
        if (P[c] >= p) break;
        K[i] = K[c]; P[i] = P[c]; i = c;
      }
      K[i] = k; P[i] = p;
    }
    return top;
  }
}
