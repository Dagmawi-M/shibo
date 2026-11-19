// A Digispark-style ATtiny85 board: USB tab on the left, chip in the middle,
// a header of P0-P5 along the bottom and 5V/GND/VIN on the right. Our own drawing.
const PINS = ['0', '1', '2', '3', '4', '5'];
const W = 150, H = 96;

class ShiboAttiny85 extends HTMLElement {
  readonly pinInfo = [
    ...PINS.map((name, i) => ({ name, x: 40 + i * 15, y: H - 6 })),
    { name: '5V', x: W - 8, y: 24 }, { name: 'GND', x: W - 8, y: 46 }, { name: 'VIN', x: W - 8, y: 68 },
  ];
  connectedCallback(): void {
    if (this.shadowRoot) return;
    const pad = (x: number, y: number, t: string, tx: number, ty: number, anchor = 'middle') =>
      `<circle cx="${x}" cy="${y}" r="4" fill="#d9b44a" stroke="#7a5b12"/><text x="${tx}" y="${ty}" font-size="7" text-anchor="${anchor}" fill="#fff">${t}</text>`;
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>:host{display:inline-block;line-height:0}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">
  <rect x="0" y="22" width="26" height="52" rx="2" fill="#c8c8c8" stroke="#777"/>
  <rect x="4" y="30" width="18" height="36" fill="#9a9a9a"/>
  <rect x="24" y="4" width="${W - 26}" height="${H - 8}" rx="6" fill="#1d4e89" stroke="#0f2c50"/>
  <rect x="60" y="28" width="34" height="30" rx="2" fill="#222"/>
  <circle cx="65" cy="33" r="2" fill="#555"/>
  <text x="77" y="46" font-size="6" text-anchor="middle" fill="#bbb">ATTINY85</text>
  ${PINS.map((n, i) => pad(40 + i * 15, H - 6, 'P' + n, 40 + i * 15, H - 13)).join('')}
  ${[['5V', 24], ['GND', 46], ['VIN', 68]].map(([t, y]) => pad(W - 8, +y, String(t), W - 14, +y + 3, 'end')).join('')}
</svg>`;
  }
}
if (!customElements.get('shibo-attiny85')) customElements.define('shibo-attiny85', ShiboAttiny85);
