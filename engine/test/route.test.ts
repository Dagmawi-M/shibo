// The editor's wire routing: pure geometry, so it is tested here without a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoRoute, bendPath, nearestSegment, dragSegment, simplify, smoothPath, type Pt, type Rect } from '../../app/src/route.ts';

const orthogonal = (pts: Pt[]) => pts.every((p, i) => i === 0 || p[0] === pts[i - 1][0] || p[1] === pts[i - 1][1]);
/** Does the segment from p to q pass through the inside of r? */
function crosses(p: Pt, q: Pt, r: Rect): boolean {
  const steps = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]));
  for (let i = 0; i <= steps; i++) {
    const x = p[0] + ((q[0] - p[0]) * i) / Math.max(steps, 1), y = p[1] + ((q[1] - p[1]) * i) / Math.max(steps, 1);
    if (x > r.x + 1 && x < r.x + r.w - 1 && y > r.y + 1 && y < r.y + r.h - 1) return true;
  }
  return false;
}

test('a wire with nothing in the way takes a short, square path', () => {
  const pts = autoRoute([0, 0], [100, 50], []);
  assert.deepEqual(pts[0], [0, 0]); assert.deepEqual(pts.at(-1), [100, 50]);
  assert.ok(orthogonal(pts), JSON.stringify(pts));
  assert.ok(pts.length <= 4, JSON.stringify(pts));
});

test('a wire goes around a part that lies between its ends', () => {
  const block: Rect = { x: 40, y: -60, w: 40, h: 120 };
  const pts = autoRoute([0, 0], [120, 0], [block]);
  assert.ok(orthogonal(pts), JSON.stringify(pts));
  for (let i = 1; i < pts.length; i++) assert.ok(!crosses(pts[i - 1], pts[i], block), `segment ${i} crosses the part: ${JSON.stringify(pts)}`);
});

test('a wire can leave a part its pin sits on', () => {
  // Both pins lie inside their own parts' outlines, as board headers do.
  const board: Rect = { x: 0, y: 0, w: 200, h: 140 }, led: Rect = { x: 300, y: 200, w: 30, h: 60 };
  const pts = autoRoute([150, 6], [310, 250], [board, led], { own: [board, led] });
  assert.deepEqual(pts[0], [150, 6]); assert.deepEqual(pts.at(-1), [310, 250]);
  assert.ok(orthogonal(pts));
  // It leaves the board by the near edge rather than crossing it.
  for (let i = 1; i < pts.length; i++) assert.ok(!crosses(pts[i - 1], pts[i], { x: 0, y: 20, w: 200, h: 120 }), JSON.stringify(pts));
});

test('bend points are joined square, and straight runs are merged', () => {
  assert.deepEqual(bendPath([0, 0], [[50, 30]], [100, 30]), [[0, 0], [50, 0], [50, 30], [100, 30]]);
  assert.deepEqual(simplify([[0, 0], [10, 0], [20, 0], [20, 0], [20, 10]]), [[0, 0], [20, 0], [20, 10]]);
});

test('dragging the middle of a wire moves that run, and the ends stay on their pins', () => {
  const pts: Pt[] = [[0, 0], [50, 0], [50, 100], [100, 100]];
  assert.equal(nearestSegment(pts, [52, 40]), 1);
  assert.deepEqual(dragSegment(pts, 1, [80, 40]), [[0, 0], [80, 0], [80, 100], [100, 100]]);
  // Dragging the first run keeps the start on its pin with a new corner.
  assert.deepEqual(simplify(dragSegment(pts, 0, [20, -30])), [[0, 0], [0, -30], [50, -30], [50, 100], [100, 100]]);
  assert.deepEqual(simplify(dragSegment(pts, 2, [70, 120])), [[0, 0], [50, 0], [50, 120], [100, 120], [100, 100]]);
});

test('the drawn path rounds its corners and starts and ends on the pins', () => {
  const d = smoothPath([[0, 0], [50, 0], [50, 40]], 6);
  assert.match(d, /^M0 0 /); assert.match(d, /Q50 0 /); assert.match(d, / L50 40$/);
  assert.equal(smoothPath([[0, 0], [10, 0]], 6), 'M0 0 L10 0');
});
