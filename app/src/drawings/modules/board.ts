// Simple drawings for chips and breakout boards that have no picture in
// @wokwi/elements. Each is a custom element with a `pinInfo` list, like the
// wokwi elements, so the editor wires to it the same way.
const PITCH = 9.6;                 // 0.1 inch header spacing, in CSS pixels
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

interface PinSpot { name: string; x: number; y: number; signals: never[] }

function define(tag: string, width: number, height: number, svg: string, pins: PinSpot[], extra?: (el: HTMLElement & Record<string, any>) => void): void {
  if (customElements.get(tag)) return;
  customElements.define(tag, class extends HTMLElement {
    readonly pinInfo = pins;
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>:host{display:inline-block;line-height:0}svg{display:block}text{font-family:ui-monospace,monospace;user-select:none}</style>
        <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svg}</svg>`;
      extra?.(this as never);
    }
  });
}

/** A 16-pin (or any even count) DIP chip. Pins are listed in package order: 1 at bottom left, counter-clockwise. */
export function dip(tag: string, title: string, pins: string[]): void {
  const half = pins.length / 2, w = half * PITCH + 8, h = 62, body = { y: 14, h: 34 };
  const spots: PinSpot[] = [];
  let svg = `<rect x="2" y="${body.y}" width="${w - 4}" height="${body.h}" rx="2" fill="#2b2b2b"/>
    <path d="M2 ${body.y + body.h / 2 - 4} a4 4 0 0 1 0 8" fill="#555"/>
    <text x="${w / 2}" y="${body.y + body.h / 2 + 3}" fill="#ddd" font-size="7" text-anchor="middle">${esc(title)}</text>`;
  for (let i = 0; i < pins.length; i++) {
    const bottom = i < half, col = bottom ? i : pins.length - 1 - i;
    const x = 4 + PITCH / 2 + col * PITCH, y = bottom ? h - 2 : 2;
    spots.push({ name: pins[i], x, y, signals: [] });
    svg += `<rect x="${x - 1.5}" y="${bottom ? body.y + body.h : 2}" width="3" height="${bottom ? h - body.y - body.h - 2 : body.y - 2}" fill="#bbb"/>
      <text x="${x}" y="${bottom ? body.y + body.h - 3 : body.y + 6}" fill="#9a9a9a" font-size="3.6" text-anchor="middle">${esc(pins[i])}</text>`;
  }
  define(tag, w, h, svg, spots);
}

/** A breakout board: a coloured board with one row of header pins along the bottom, and some art drawn inside. */
export function breakout(tag: string, opts: { title: string; pins: string[]; color: string; width?: number; height?: number; art?: string; extra?: (el: HTMLElement & Record<string, any>) => void }): void {
  const w = Math.max(opts.width ?? 0, opts.pins.length * PITCH + 10), h = opts.height ?? 70;
  const x0 = (w - (opts.pins.length - 1) * PITCH) / 2;
  const spots: PinSpot[] = [];
  let svg = `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="3" fill="${opts.color}" stroke="#0004"/>
    <text x="${w / 2}" y="11" fill="#fff" font-size="7" text-anchor="middle">${esc(opts.title)}</text>${opts.art ?? ''}`;
  opts.pins.forEach((name, i) => {
    const x = x0 + i * PITCH, y = h - 5;
    spots.push({ name, x, y, signals: [] });
    svg += `<rect x="${x - 3}" y="${y - 3}" width="6" height="6" fill="#222"/><circle cx="${x}" cy="${y}" r="1.4" fill="#d8b04a"/>
      <text x="${x}" y="${y - 6}" fill="#fff" font-size="3.6" transform="rotate(-90 ${x} ${y - 6})" dominant-baseline="middle">${esc(name)}</text>`;
  });
  define(tag, w, h, svg, spots, opts.extra);
}
