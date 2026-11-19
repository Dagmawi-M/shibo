// A plain drawing for every sensor module that has no Wokwi drawing: a small
// board with its name on it and its pins in a row along the bottom edge.
import { sensorsMore } from '../../../../engine/src/parts/sensors-more.ts';

const PITCH = 9.6;            // 0.1 inch header pitch, in CSS pixels (as the Wokwi drawings use)
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

for (const def of sensorsMore) {
  const tag = def.ui?.tag;
  if (!tag || customElements.get(tag)) continue;
  const pins = def.pins;
  const name = (def.ui!.label.match(/\(([^)]+)\)/)?.[1] ?? def.ui!.label).slice(0, 14);
  const w = Math.max(48, pins.length * PITCH + 12), h = 44, x0 = (w - (pins.length - 1) * PITCH) / 2;
  const pinInfo = pins.map((p, i) => ({ name: p, x: x0 + i * PITCH, y: h, signals: [] as unknown[] }));
  class SensorModule extends HTMLElement {
    readonly pinInfo = pinInfo;
    readonly updateComplete = Promise.resolve();
    constructor() {
      super();
      const legs = pinInfo.map((p) => `<rect x="${p.x - 1}" y="${h - 9}" width="2" height="9" fill="#bbb"/>` +
        `<text x="${p.x}" y="${h - 11}" font-size="4" font-family="sans-serif" text-anchor="middle" fill="#fff" transform="rotate(-90 ${p.x} ${h - 11})" dominant-baseline="middle">${esc(p.name)}</text>`).join('');
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>:host{display:inline-block;line-height:0}</style>` +
        `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 9}" rx="2" fill="#1b5e9a" stroke="#0d3b66"/>` +
        `<text x="${w / 2}" y="9" font-size="6" font-family="sans-serif" text-anchor="middle" fill="#fff">${esc(name)}</text>` +
        legs + `</svg>`;
    }
  }
  customElements.define(tag, SensorModule);
}
