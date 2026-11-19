// Drawings for the lights (engine/src/parts/lights.ts). LED variants and the
// strip extend the MIT @wokwi/elements drawings; the modules are drawn here.
// Each has a pinInfo list in pixels from its top-left corner, as the Wokwi
// elements do, and properties named as the part's `ui.show` says.
import { css, html, svg, LitElement, type PropertyValues } from 'lit';
import { LEDElement, NeopixelMatrixElement, RGBLedElement } from '@wokwi/elements';

type Pin = { name: string; x: number; y: number; signals: unknown[]; description?: string };
const pin = (name: string, x: number, y: number, description?: string): Pin => ({ name, x, y, signals: [], ...(description ? { description } : {}) });
const define = (tag: string, cls: CustomElementConstructor) => { if (!customElements.get(tag)) customElements.define(tag, cls); };

// ---------- single LEDs: a colour, and a size of 3, 5 or 10 mm ----------
const SCALE: Record<string, number> = { '3': 0.8, '5': 1, '10': 1.5 };
function sizedLed(defaults: { color?: string; size?: string; lightColor?: string; label?: string }) {
  return class extends (LEDElement as unknown as typeof LitElement) {
    static properties = { size: { type: String } };
    static styles = [(LEDElement as unknown as typeof LitElement).styles ?? [], css`.led-container { width: auto !important; }`].flat();
    declare size: string; declare color: string; declare lightColor: string | null; declare label: string;
    constructor() {
      super();
      this.size = defaults.size ?? '5';
      if (defaults.color) this.color = defaults.color;
      if (defaults.lightColor) this.lightColor = defaults.lightColor;
      if (defaults.label) this.label = defaults.label;
    }
    get k(): number { return SCALE[String(this.size).replace(/mm$/, '')] ?? 1; }
    get pinInfo(): Pin[] {
      const base = Object.getOwnPropertyDescriptor(LEDElement.prototype, 'pinInfo')!.get!.call(this) as Pin[];
      return base.map((p) => ({ ...p, x: p.x * this.k, y: p.y * this.k }));
    }
    updated(changed: PropertyValues): void {
      super.updated?.(changed);
      const s = this.shadowRoot?.querySelector('svg');
      if (s) { s.setAttribute('width', String(40 * this.k)); s.setAttribute('height', String(50 * this.k)); }
      if (changed.has('size')) this.dispatchEvent(new CustomEvent('pininfo-change'));
    }
  };
}
for (const c of ['green', 'blue', 'yellow', 'white', 'orange', 'pink', 'purple']) define(`shibo-led-${c}`, sizedLed({ color: c, ...(c === 'pink' ? { lightColor: '#ffb0d0' } : {}) }));
define('shibo-led-3mm', sizedLed({ size: '3' }));
define('shibo-led-10mm', sizedLed({ size: '10' }));
// An IR LED's light cannot be seen; a phone camera shows a faint violet, so that is what lights.
define('shibo-ir-led', sizedLed({ color: '#b9b4d6', lightColor: '#c9a0ff', label: 'IR' }));
define('shibo-led-resistor', sizedLed({ label: '+R' }));

// ---------- RGB LED, common anode: the same picture ----------
define('shibo-rgb-led-anode', class extends (RGBLedElement as unknown as typeof LitElement) {});

// ---------- WS2812 strip: one row of the matrix drawing ----------
define('shibo-led-strip', class extends (NeopixelMatrixElement as unknown as typeof LitElement) {
  static properties = { pixels: { type: String } };
  declare pixels: string; declare rows: number; declare cols: number;
  constructor() { super(); this.rows = 1; this.cols = 8; this.pixels = '8'; }
  willUpdate(changed: PropertyValues): void {
    if (changed.has('pixels')) { this.cols = Math.min(1024, Math.max(1, Number(this.pixels) || 8)); (this as any).pixelElements = null; }
  }
  updated(changed: PropertyValues): void { super.updated?.(changed); if (changed.has('pixels')) this.dispatchEvent(new CustomEvent('pininfo-change')); }
  /** The page calls setPixel(index, rgb) for a strip; the matrix wants (row, col, rgb). */
  setPixel(a: number, b: number | { r: number; g: number; b: number }, c?: { r: number; g: number; b: number }): void {
    const set = (NeopixelMatrixElement.prototype as any).setPixel;
    if (typeof b === 'object') set.call(this, 0, a, b); else set.call(this, a, b, c);
  }
});

// ---------- shared bits ----------
const BOARD = css`:host { display: inline-block; line-height: 0; } svg { overflow: visible; }`;
const header = (pins: Pin[], label = true) => pins.map((p) => svg`
  <rect x=${p.x - 3} y=${p.y - 3} width="6" height="6" fill="#222" />
  <circle cx=${p.x} cy=${p.y} r="1.6" fill="#c8b273" />
  ${label ? svg`<text x=${p.x} y=${p.y - 6} font-size="5.5" fill="#f0f0f0" text-anchor="middle" font-family="monospace">${p.name}</text>` : ''}`);
const glow = (id: string) => svg`<filter id=${id} x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="2.5" /></filter>`;

// ---------- bi-colour LED: one milky body, red and green inside ----------
define('shibo-led-bicolor', class extends LitElement {
  static properties = { red: { type: Number }, green: { type: Number } };
  static styles = BOARD;
  declare red: number; declare green: number;
  constructor() { super(); this.red = 0; this.green = 0; }
  get pinInfo(): Pin[] { return [pin('R', 10, 48, 'Red anode'), pin('C', 20, 48, 'Common cathode'), pin('G', 30, 48, 'Green anode')]; }
  render() {
    const r = Number(this.red) || 0, g = Number(this.green) || 0, on = Math.max(r, g);
    const col = `rgb(${Math.round(255 * Math.min(1, r * 1.2))}, ${Math.round(255 * Math.min(1, g * 1.2))}, ${r && g ? 40 : 30})`;
    return html`<svg width="40" height="52" viewBox="0 0 40 52" xmlns="http://www.w3.org/2000/svg">
      <defs>${glow('bc')}</defs>
      <g stroke="#9d9999" stroke-width="1.6" fill="none"><path d="M10 26 V48" /><path d="M20 28 V48" /><path d="M30 26 V48" /></g>
      <path d="M8 26 V12 a12 12 0 0 1 24 0 V26 Z" fill="#eee8e8" opacity=".85" />
      <rect x="6" y="24" width="28" height="4" rx="1" fill="#ddd6d6" />
      <rect x="12" y="15" width="3" height="5" fill="#a33" /><rect x="25" y="15" width="3" height="5" fill="#3a3" />
      ${on > 0.01 ? svg`<circle cx="20" cy="13" r="12" fill=${col} opacity=${0.35 + on * 0.6} filter="url(#bc)" />
        <path d="M8 26 V12 a12 12 0 0 1 24 0 V26 Z" fill=${col} opacity=${0.3 + on * 0.5} />` : ''}
    </svg>`;
  }
});

// ---------- traffic-light module ----------
define('shibo-traffic-light', class extends LitElement {
  static properties = { red: { type: Number }, yellow: { type: Number }, green: { type: Number } };
  static styles = BOARD;
  declare red: number; declare yellow: number; declare green: number;
  constructor() { super(); this.red = 0; this.yellow = 0; this.green = 0; }
  get pinInfo(): Pin[] { return [pin('GND', 7, 104, 'Ground'), pin('R', 17, 104, 'Red'), pin('Y', 27, 104, 'Yellow'), pin('G', 37, 104, 'Green')]; }
  render() {
    const lamp = (cy: number, v: number, on: string, off: string, id: string) => {
      const b = Number(v) || 0;
      return svg`<circle cx="22" cy=${cy} r="11" fill="#111" />
        <circle cx="22" cy=${cy} r="9" fill=${off} />
        ${b > 0.01 ? svg`<circle cx="22" cy=${cy} r="13" fill=${on} opacity=${0.3 + b * 0.5} filter="url(#${id})" /><circle cx="22" cy=${cy} r="9" fill=${on} opacity=${0.4 + b * 0.6} />` : ''}
        <circle cx="19" cy=${cy - 3} r="2" fill="#fff" opacity=".35" />`;
    };
    return html`<svg width="44" height="110" viewBox="0 0 44 110" xmlns="http://www.w3.org/2000/svg">
      <defs>${glow('tr')}${glow('ty')}${glow('tg')}</defs>
      <rect x="2" y="2" width="40" height="94" rx="4" fill="#1f2a1f" stroke="#0c120c" />
      ${lamp(20, this.red, '#ff3b30', '#4a1512', 'tr')}${lamp(48, this.yellow, '#ffcc00', '#4a3c0a', 'ty')}${lamp(76, this.green, '#34e05a', '#0f3a1a', 'tg')}
      ${header(this.pinInfo)}
    </svg>`;
  }
});

// ---------- KY-008 laser module ----------
define('shibo-laser-module', class extends LitElement {
  static properties = { on: { type: Boolean } };
  static styles = BOARD;
  declare on: boolean;
  constructor() { super(); this.on = false; }
  get pinInfo(): Pin[] { return [pin('S', 30, 58, 'Signal: high turns the laser on'), pin('NC', 40, 58, 'Not connected'), pin('GND', 50, 58, 'Ground (-)')]; }
  render() {
    return html`<svg width="80" height="62" viewBox="0 0 80 62" xmlns="http://www.w3.org/2000/svg">
      <defs>${glow('lz')}<linearGradient id="brass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8cf8a" /><stop offset=".5" stop-color="#b8923f" /><stop offset="1" stop-color="#7d5f22" /></linearGradient></defs>
      <rect x="18" y="12" width="46" height="40" rx="3" fill="#1d3c78" stroke="#0e2148" />
      <text x="48" y="30" font-size="6" fill="#cfd8ec" text-anchor="middle" font-family="monospace">KY-008</text>
      <rect x="4" y="20" width="26" height="14" rx="2" fill="url(#brass)" />
      <rect x="2" y="22" width="4" height="10" rx="1" fill="#6b5120" />
      ${this.on ? svg`<circle cx="3" cy="27" r="7" fill="#ff1a1a" opacity=".55" filter="url(#lz)" /><circle cx="3" cy="27" r="2.4" fill="#ff5555" /><circle cx="3" cy="27" r="1" fill="#fff" />` : ''}
      ${header(this.pinInfo)}
    </svg>`;
  }
});

// ---------- MAX7219 8x8 matrix module ----------
const DOT = 13, M0 = 14;
define('shibo-max7219-matrix', class extends LitElement {
  static properties = { values: { type: Array }, intensity: { type: Number } };
  static styles = BOARD;
  declare values: number[]; declare intensity: number;
  constructor() { super(); this.values = []; this.intensity = 0; }
  get pinInfo(): Pin[] {
    return [...['VCC', 'GND', 'DIN', 'CS', 'CLK'].map((n, i) => pin(n, 5, 34 + i * 10)), pin('DOUT', 135, 54, 'Data out, to the next module\'s DIN')];
  }
  render() {
    const v = Array.isArray(this.values) ? this.values : [], k = 0.45 + 0.55 * ((Number(this.intensity) || 0) / 15);
    const dots = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const on = v[r * 8 + c];
      dots.push(svg`<circle cx=${M0 + 6 + c * DOT} cy=${M0 + r * DOT} r="5" fill=${on ? '#ff2a1a' : '#3b1512'} opacity=${on ? k : 1} />`);
    }
    return html`<svg width="140" height="120" viewBox="0 0 140 120" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="140" height="120" rx="3" fill="#1b5e3a" />
      <rect x="12" y="4" width="114" height="106" rx="2" fill="#141414" />
      ${dots}
      <text x="70" y="117" font-size="5.5" fill="#cde" text-anchor="middle" font-family="monospace">MAX7219</text>
      ${header(this.pinInfo, false)}
      ${this.pinInfo.map((p) => svg`<text x=${p.x + (p.x < 70 ? 5 : -5)} y=${p.y + 2} font-size="5" fill="#eee" text-anchor=${p.x < 70 ? 'start' : 'end'} font-family="monospace">${p.name}</text>`)}
    </svg>`;
  }
});

// ---------- TM1637 4-digit module ----------
// Segments A to G as the chip numbers them: bit 0 is A, bit 6 is G.
const SEG = [[3, 0, 14, 3.4], [17, 2, 3.4, 15], [17, 19, 3.4, 15], [3, 34, 14, 3.4], [0, 19, 3.4, 15], [0, 2, 3.4, 15], [3, 17, 14, 3.4]];
define('shibo-tm1637', class extends LitElement {
  static properties = { values: { type: Array }, colon: { type: Boolean }, brightness: { type: Number } };
  static styles = BOARD;
  declare values: number[]; declare colon: boolean; declare brightness: number;
  constructor() { super(); this.values = []; this.colon = false; this.brightness = 0; }
  get pinInfo(): Pin[] { return ['CLK', 'DIO', 'VCC', 'GND'].map((n, i) => pin(n, 183, 18 + i * 10)); }
  render() {
    const v = Array.isArray(this.values) ? this.values : [], k = 0.4 + 0.6 * ((Number(this.brightness) || 0) / 7);
    const on = '#ff3322', off = '#3a1814';
    const digit = (d: number, x: number) => svg`<g transform="translate(${x} 14) skewX(-6)">
      ${SEG.map(([sx, sy, w, h], i) => svg`<rect x=${sx} y=${sy} width=${w} height=${h} rx="1.2" fill=${v[d * 8 + i] ? on : off} opacity=${v[d * 8 + i] ? k : 1} />`)}</g>`;
    return html`<svg width="190" height="66" viewBox="0 0 190 66" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="190" height="66" rx="3" fill="#1d3f8a" />
      <rect x="8" y="6" width="142" height="54" rx="2" fill="#111" />
      ${digit(0, 16)}${digit(1, 46)}${digit(2, 86)}${digit(3, 116)}
      <circle cx="78" cy="24" r="2" fill=${this.colon ? on : off} opacity=${this.colon ? k : 1} /><circle cx="76" cy="42" r="2" fill=${this.colon ? on : off} opacity=${this.colon ? k : 1} />
      ${header(this.pinInfo, false)}
      ${this.pinInfo.map((p) => svg`<text x=${p.x - 5} y=${p.y + 2} font-size="5" fill="#eee" text-anchor="end" font-family="monospace">${p.name}</text>`)}
    </svg>`;
  }
});
