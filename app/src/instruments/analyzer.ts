// A logic analyzer: pick pins, see their levels over time. Scroll to zoom,
// drag to pan, and while paused click a moment to go back to it.
type Level = 0 | 1 | null;
export interface Signal { id: string; label: string; kind: 'pin' | 'buzzer' }
interface Trace { start: Level; times: number[]; levels: Level[] }

const ROW = 30, AXIS = 22, LABEL = 78, KEEP_NS = 60e9, MAX_PICK = 8;
const PICK_KEY = 'shibo.analyzer';
const SPANS = [1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8, 2e8, 5e8, 1e9, 2e9, 5e9, 1e10, 2e10, 6e10];

export function fmtTime(ns: number): string {
  const a = Math.abs(ns);
  if (a >= 1e9) return `${Number((ns / 1e9).toFixed(3))} s`;
  if (a >= 1e6) return `${Number((ns / 1e6).toFixed(3))} ms`;
  if (a >= 1e3) return `${Number((ns / 1e3).toFixed(1))} µs`;
  return `${Math.round(ns)} ns`;
}

export class Analyzer {
  readonly el: HTMLElement;
  private picker: HTMLElement;
  private canvas: HTMLCanvasElement;
  private readout: HTMLElement;
  private followBtn: HTMLButtonElement;
  private signals: Signal[] = [];
  private picked: string[] = [];
  private traces: Record<string, Trace> = {};
  private span = 2e9;               // ns across the plot
  private right = 0;                // ns at the right edge
  private follow = true;
  private head = 0; private now = 0; private paused = false;
  private hoverX: number | null = null;
  private frame = 0;
  private watch: (ids: string[]) => void;
  private seek: (ms: number) => void;

  constructor(watch: (ids: string[]) => void, seek: (ms: number) => void) {
    this.watch = watch; this.seek = seek;
    try { this.picked = JSON.parse(localStorage.getItem(PICK_KEY) ?? '[]').filter((x: unknown) => typeof x === 'string').slice(0, MAX_PICK); } catch { /* none remembered */ }
    this.el = document.createElement('div'); this.el.className = 'inst-analyzer';
    this.picker = document.createElement('div'); this.picker.className = 'inst-picker';
    const plot = document.createElement('div'); plot.className = 'inst-plot';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img'); this.canvas.setAttribute('aria-label', 'Logic analyzer: the level of each picked pin over time');
    const tools = document.createElement('div'); tools.className = 'inst-tools';
    const zoomIn = this.button('+', 'Zoom in (or scroll on the plot)', () => this.zoom(1 / 2.5, null));
    const zoomOut = this.button('−', 'Zoom out', () => this.zoom(2.5, null));
    this.followBtn = this.button('Follow', 'Keep the newest moment in view', () => { this.follow = true; this.draw(); });
    this.readout = document.createElement('span'); this.readout.className = 'inst-readout';
    tools.append(zoomOut, zoomIn, this.followBtn, this.readout);
    plot.append(this.canvas);
    this.el.append(this.picker, plot, tools);
    this.bindPlot();
    new ResizeObserver(() => this.draw()).observe(plot);
    this.drawPicker();
  }

  private button(text: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title; b.setAttribute('aria-label', title); b.onclick = fn; return b;
  }

  setSignals(list: Signal[]): void {
    this.signals = list;
    const known = new Set(list.map((s) => s.id));
    if (!this.picked.some((id) => known.has(id))) this.picked = list.filter((s) => s.kind === 'buzzer').map((s) => s.id).slice(0, 1);
    this.picked = this.picked.filter((id) => known.has(id));
    this.drawPicker();
    this.watch(this.picked);
  }

  /** Signals were picked or dropped. */
  private toggle(id: string): void {
    this.picked = this.picked.includes(id) ? this.picked.filter((x) => x !== id) : [...this.picked, id].slice(-MAX_PICK);
    try { localStorage.setItem(PICK_KEY, JSON.stringify(this.picked)); } catch { /* not remembered */ }
    this.drawPicker(); this.watch(this.picked); this.draw();
  }

  private drawPicker(): void {
    this.picker.replaceChildren();
    if (!this.signals.length) { const p = document.createElement('span'); p.className = 'inst-mute'; p.textContent = 'Run the sketch to pick pins to watch.'; this.picker.append(p); return; }
    for (const s of this.signals) {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'inst-chip'; b.textContent = s.label.replace(/^\S+ /, ''); b.title = `Watch ${s.label}`;
      b.setAttribute('aria-pressed', String(this.picked.includes(s.id)));
      b.onclick = () => this.toggle(s.id);
      this.picker.append(b);
    }
  }

  onTrace(m: { reset: boolean; nowNs: number; data: Record<string, Trace> }): void {
    if (m.reset) this.traces = {};
    for (const [id, d] of Object.entries(m.data)) {
      const t = this.traces[id];
      if (!t || m.reset) { this.traces[id] = { start: d.start, times: [...d.times], levels: [...d.levels] }; continue; }
      t.times.push(...d.times); t.levels.push(...d.levels);
      // Keep a minute, like the engine does.
      const cut = m.nowNs - KEEP_NS;
      let i = 0; while (i < t.times.length - 1 && t.times[i + 1] < cut) i++;
      if (i) { t.start = t.levels[i - 1]; t.times.splice(0, i); t.levels.splice(0, i); }
    }
    this.head = Math.max(this.head, m.nowNs);
    this.draw();
  }

  setTime(nowNs: number, headNs: number, paused: boolean): void {
    this.now = nowNs; this.head = headNs; this.paused = paused; this.draw();
  }

  /** A new run: nothing recorded yet. */
  clear(): void { this.traces = {}; this.head = this.now = 0; this.follow = true; this.signals = []; this.drawPicker(); this.draw(); }

  private zoom(k: number, atX: number | null): void {
    const i = Math.max(0, Math.min(SPANS.length - 1, SPANS.findIndex((s) => s >= this.span) + (k < 1 ? -1 : 1)));
    const next = SPANS[i];
    if (atX !== null && !this.follow) {
      const t = this.timeAt(atX);
      this.right = t + (this.right - t) * (next / this.span);
    }
    this.span = next; this.draw();
  }

  private plotWidth(): number { return Math.max(1, this.canvas.clientWidth - LABEL); }
  private viewRight(): number { return this.follow ? Math.max(this.head, this.span) : this.right; }
  private timeAt(x: number): number { return this.viewRight() - this.span + ((x - LABEL) / this.plotWidth()) * this.span; }

  private bindPlot(): void {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const x = e.offsetX;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { this.panBy(((e.deltaX || e.deltaY) / this.plotWidth()) * this.span); return; }
      if (this.follow && x > LABEL) { this.right = this.viewRight(); this.follow = false; }
      this.zoom(e.deltaY < 0 ? 0.5 : 2, x);
    }, { passive: false });
    let drag: { x: number; right: number; moved: boolean } | null = null;
    c.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { x: e.clientX, right: this.viewRight(), moved: false }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      this.hoverX = e.offsetX;
      if (drag && Math.abs(e.clientX - drag.x) > 3) {
        drag.moved = true; this.follow = false;
        this.right = drag.right - ((e.clientX - drag.x) / this.plotWidth()) * this.span;
      }
      this.draw();
    });
    c.addEventListener('pointerup', (e) => {
      const d = drag; drag = null;
      if (d && !d.moved && this.paused && e.offsetX > LABEL) this.seek(Math.max(0, this.timeAt(e.offsetX)) / 1e6);
    });
    c.addEventListener('pointerleave', () => { this.hoverX = null; this.draw(); });
  }

  private panBy(ns: number): void { this.right = this.viewRight() + ns; this.follow = false; this.draw(); }

  draw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); });
  }

  private paint(): void {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const rows = this.picked.length, h = Math.max(1, rows) * ROW + AXIS;
    c.style.height = `${h}px`;
    const w = c.clientWidth;
    if (!w) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.el);
    const ink = css.getPropertyValue('--ink').trim() || '#1c2330', mute = css.getPropertyValue('--mute').trim() || '#667085';
    const line = css.getPropertyValue('--line').trim() || '#dfe3e8', trace = css.getPropertyValue('--accent').trim() || '#14784f';
    const cursor = css.getPropertyValue('--select').trim() || '#2563eb';
    g.clearRect(0, 0, w, h);
    g.font = '11px ui-monospace, monospace'; g.textBaseline = 'middle';
    const pw = this.plotWidth(), right = this.viewRight(), left = right - this.span;
    const xOf = (t: number) => LABEL + ((t - left) / this.span) * pw;
    // grid and time axis
    const stepNs = SPANS.find((s) => s >= this.span / 8) ?? this.span / 8;
    g.strokeStyle = line; g.fillStyle = mute; g.lineWidth = 1;
    for (let t = Math.ceil(left / stepNs) * stepNs; t <= right; t += stepNs) {
      const x = Math.round(xOf(t)) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, rows * ROW); g.stroke();
      if (x > LABEL + 20 && x < w - 20) { g.textAlign = 'center'; g.fillText(fmtTime(t), x, rows * ROW + AXIS / 2); }
    }
    if (!rows) { g.textAlign = 'left'; g.fillStyle = mute; g.fillText('Pick pins above to see their levels over time.', LABEL, ROW / 2); }
    this.picked.forEach((id, r) => {
      const y0 = r * ROW, hi = y0 + 7, lo = y0 + ROW - 7;
      const s = this.signals.find((x) => x.id === id);
      g.textAlign = 'left'; g.fillStyle = ink; g.fillText((s?.label ?? id).replace(/^\S+ /, ''), 6, y0 + ROW / 2);
      g.strokeStyle = line; g.beginPath(); g.moveTo(LABEL, y0 + ROW - 0.5); g.lineTo(w, y0 + ROW - 0.5); g.stroke();
      const t = this.traces[id];
      if (!t) return;
      // Find the first change in view, and the level before it.
      let lo2 = 0, hi2 = t.times.length;
      while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (t.times[m] < left) lo2 = m + 1; else hi2 = m; }
      let level: Level = lo2 > 0 ? t.levels[lo2 - 1] : t.start;
      const yOf = (l: Level) => (l === 1 ? hi : l === 0 ? lo : (hi + lo) / 2);
      const end = Math.min(right, this.head);
      const begin = t.times.length ? Math.max(left, lo2 > 0 || t.start !== null ? left : t.times[0]) : left;
      g.strokeStyle = trace; g.lineWidth = 1.5; g.beginPath();
      g.moveTo(Math.max(LABEL, xOf(begin)), yOf(level));
      // More changes than pixels: those columns are drawn as a shaded band.
      const busy: number[] = [];
      let lastPx = -1;
      for (let i = lo2; i < t.times.length && t.times[i] <= end; i++) {
        const nx = xOf(t.times[i]), px = Math.floor(nx);
        if (px === lastPx) { if (busy.at(-1) !== px) busy.push(px); }
        else g.lineTo(nx, yOf(level));
        g.lineTo(nx, yOf(t.levels[i]));
        level = t.levels[i]; lastPx = px;
      }
      g.lineTo(Math.max(LABEL, xOf(end)), yOf(level)); g.stroke();
      g.fillStyle = trace; g.globalAlpha = 0.4;
      for (const px of busy) g.fillRect(px, hi, 1, lo - hi);
      g.globalAlpha = 1;
      if (level === null) { g.fillStyle = mute; g.textAlign = 'right'; g.fillText('floating', w - 4, y0 + ROW / 2); }
    });
    // where the run is now, when scrubbing back
    if (this.paused && this.now < this.head) {
      const x = Math.round(xOf(this.now)) + 0.5;
      g.strokeStyle = cursor; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, rows * ROW); g.stroke();
    }
    if (this.hoverX !== null && this.hoverX > LABEL) {
      g.strokeStyle = mute; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(this.hoverX + 0.5, 0); g.lineTo(this.hoverX + 0.5, rows * ROW); g.stroke(); g.setLineDash([]);
    }
    this.followBtn.setAttribute('aria-pressed', String(this.follow));
    const at = this.hoverX !== null && this.hoverX > LABEL ? ` · pointer at ${fmtTime(this.timeAt(this.hoverX))}` : '';
    this.readout.textContent = `${fmtTime(this.span)} across${at}${this.paused ? ' · click to go to a moment' : ''}`;
  }
}
