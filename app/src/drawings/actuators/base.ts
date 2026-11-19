// A tiny base for Shibo's own part drawings: an SVG in a shadow root, pins
// listed in `pinInfo` (CSS pixels from the top left) as the wokwi elements do,
// and properties the page sets from the part's outputs.

export interface PinInfo { name: string; x: number; y: number; signals: never[] }

export interface Spec {
  tag: string;
  pins: [name: string, x: number, y: number][];
  /** Properties the page sets (from `show`) or that the drawing keeps (a switch's `value`). */
  props?: Record<string, unknown>;
  /** Attributes that change the picture. */
  attrs?: string[];
  svg(el: Drawing): string;
  /** Clicking the drawing flips `value` and says so with an `input` event, as wokwi's slide switch does. */
  toggles?: boolean;
  /** Turns the element with id "rot" at this many degrees a second. */
  spin?(el: Drawing): number;
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const terminal = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="2.6" fill="#c9c9c9" stroke="#777" stroke-width=".8"/>`;
export const header = (x: number, y: number) => `<rect x="${x - 3}" y="${y - 3}" width="6" height="6" fill="#222"/><rect x="${x - 1.2}" y="${y - 1.2}" width="2.4" height="2.4" fill="#d8b04a"/>`;
export const label = (x: number, y: number, text: string, size = 6, fill = '#fff', anchor = 'middle', rotate = 0) =>
  `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : ''}>${esc(text)}</text>`;

export class Drawing extends HTMLElement {
  pinInfo: PinInfo[];
  updateComplete: Promise<void> = Promise.resolve();
  readonly spec: Spec;
  protected vals: Record<string, unknown>;
  private deg = 0;
  private frame = 0;
  private last = 0;

  constructor(spec: Spec) {
    super();
    this.spec = spec;
    this.pinInfo = spec.pins.map(([name, x, y]) => ({ name, x, y, signals: [] }));
    this.vals = { ...(spec.props ?? {}) };
    this.attachShadow({ mode: 'open' });
    if (spec.toggles) this.addEventListener('click', () => { this.set('value', this.vals.value ? 0 : 1); this.dispatchEvent(new Event('input')); });
  }

  get(name: string): unknown { return this.vals[name]; }
  set(name: string, v: unknown): void {
    if (JSON.stringify(this.vals[name]) === JSON.stringify(v)) return;
    this.vals[name] = v;
    this.paint();
  }

  connectedCallback(): void { this.paint(); }
  disconnectedCallback(): void { cancelAnimationFrame(this.frame); this.frame = 0; }
  attributeChangedCallback(): void { if (this.shadowRoot!.childElementCount) this.paint(); }

  paint(): void {
    this.shadowRoot!.innerHTML = `<style>:host{display:inline-block;line-height:0;user-select:none}
      @keyframes buzz{0%{transform:translate(0,0)}25%{transform:translate(.8px,-.6px)}50%{transform:translate(-.7px,.7px)}75%{transform:translate(.6px,.5px)}}
      .buzz{animation:buzz .06s linear infinite}
      @keyframes drip{from{transform:translateY(0);opacity:1}to{transform:translateY(10px);opacity:0}}
      .drip{animation:drip .5s linear infinite}</style>${this.spec.svg(this)}`;
    this.turn();
    if (this.spec.spin && !this.frame && this.isConnected) this.frame = requestAnimationFrame((t) => this.animate(t));
  }

  private turn(): void { this.shadowRoot!.getElementById('rot')?.setAttribute('transform', `rotate(${this.deg.toFixed(1)})`); }

  private animate(t: number): void {
    const rate = this.spec.spin?.(this) ?? 0, dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    if (!rate) { this.frame = 0; this.last = 0; return; }
    this.deg = (this.deg + rate * dt) % 360;
    this.turn();
    this.frame = requestAnimationFrame((x) => this.animate(x));
  }
}

/** Define a drawing, with a property for each of its props. */
export function define(spec: Spec): void {
  if (customElements.get(spec.tag)) return;
  class D extends Drawing {
    static observedAttributes = spec.attrs ?? [];
    constructor() { super(spec); }
  }
  for (const name of Object.keys(spec.props ?? {})) {
    Object.defineProperty(D.prototype, name, { get(this: Drawing) { return this.get(name); }, set(this: Drawing, v: unknown) { this.set(name, v); }, configurable: true });
  }
  customElements.define(spec.tag, D);
}

/** How fast to turn a picture for a shaft speed: true to rpm while the eye can follow, then capped. */
export const turnRate = (rpm: unknown) => { const r = Number(rpm) || 0; return Math.sign(r) * Math.min(Math.abs(r) * 6, 900); };
