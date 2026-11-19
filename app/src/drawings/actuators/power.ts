// Drawings for the power parts: batteries, regulators, power switch, fuse, breadboard power module.
import { define, header, label } from './base.ts';

const lead = (x1: number, y1: number, x2: number, y2: number, c: string) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${c}" stroke-width="2.4"/><rect x="${x2 - 2}" y="${y2 - 2}" width="4" height="4" fill="#bbb"/>`;

define({
  tag: 'shibo-battery-9v', pins: [['+', 20, 5], ['-', 38, 5]],
  svg: () => `<svg width="58" height="98" viewBox="0 0 58 98" xmlns="http://www.w3.org/2000/svg">
      <circle cx="20" cy="7" r="5" fill="#c9c9c9" stroke="#777"/><path d="M33 3 h10 l2.5 4 -2.5 4 h-10 l-2.5 -4z" fill="#c9c9c9" stroke="#777"/>
      <rect x="4" y="12" width="50" height="84" rx="4" fill="#2c2f36"/><rect x="4" y="12" width="50" height="22" rx="4" fill="#d8a028"/>
      ${label(29, 66, '9V', 18, '#fff')}${label(29, 82, 'BATTERY', 6.5, '#bbb')}${label(20, 28, '+', 10, '#222')}${label(38, 28, '−', 10, '#222')}
    </svg>`,
});

define({
  tag: 'shibo-battery-aa4', pins: [['+', 124, 18], ['-', 124, 54]],
  svg: () => `<svg width="128" height="72" viewBox="0 0 128 72" xmlns="http://www.w3.org/2000/svg">
      ${lead(104, 22, 124, 18, '#d33')}${lead(104, 50, 124, 54, '#222')}
      <rect x="2" y="2" width="104" height="68" rx="4" fill="#1b1b1b"/>
      ${[0, 1, 2, 3].map((i) => `<rect x="8" y="${6 + i * 16}" width="90" height="13" rx="6" fill="${i % 2 ? '#c8ccd0' : '#2f8f3a'}"/><rect x="${i % 2 ? 6 : 96}" y="${9 + i * 16}" width="3" height="7" fill="#999"/>`).join('')}
      ${label(53, 40, '4 × AA  6V', 7, '#fff')}
    </svg>`,
});

define({
  tag: 'shibo-lipo', pins: [['+', 104, 16], ['-', 104, 32]],
  svg: () => `<svg width="108" height="50" viewBox="0 0 108 50" xmlns="http://www.w3.org/2000/svg">
      ${lead(84, 20, 104, 16, '#d33')}${lead(84, 28, 104, 32, '#222')}
      <rect x="2" y="4" width="82" height="42" rx="4" fill="#b8bec6" stroke="#8a9098"/><rect x="8" y="10" width="70" height="30" rx="2" fill="#3b4fa0"/>
      ${label(43, 24, 'LiPo 3.7V', 8)}${label(43, 34, '1S cell', 6, '#cdd5ff')}
    </svg>`,
});

const to220 = (tag: string, text: string, sub: string, legs: [string, number][]) => define({
  tag, pins: legs.map(([n, x]): [string, number, number] => [n, x, 86]),
  svg: () => `<svg width="44" height="88" viewBox="0 0 44 88" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="2" width="36" height="22" fill="#b7bcc2" stroke="#8a9096"/><circle cx="22" cy="12" r="5" fill="#fff" stroke="#8a9096"/>
      <rect x="4" y="24" width="36" height="32" fill="#1d1d1d"/>${label(22, 38, text, 7.5)}${label(22, 48, sub, 5.5, '#bbb')}
      ${legs.map(([n, x]) => `<rect x="${x - 1.5}" y="56" width="3" height="30" fill="#c9c9c9"/>${label(x, 66, n, 4.5, '#333', 'start', -90)}`).join('')}
    </svg>`,
});
to220('shibo-lm7805', 'LM7805', '5V', [['IN', 12], ['GND', 22], ['OUT', 32]]);
to220('shibo-ams1117', 'AMS1117', '3.3V', [['GND', 12], ['OUT', 22], ['IN', 32]]);

define({
  tag: 'shibo-power-switch', props: { value: 0 }, toggles: true,
  pins: [['1', 16, 62], ['2', 32, 62]],
  svg: (el) => {
    const on = Boolean(Number(el.get('value')));
    return `<svg width="48" height="64" viewBox="0 0 48 64" xmlns="http://www.w3.org/2000/svg" style="cursor:pointer">
      <rect x="14" y="44" width="4" height="18" fill="#c9c9c9"/><rect x="30" y="44" width="4" height="18" fill="#c9c9c9"/>
      <rect x="4" y="4" width="40" height="42" rx="4" fill="#202020"/>
      <path d="${on ? 'M9 10 L39 6 L39 42 L9 40 Z' : 'M9 6 L39 10 L39 40 L9 42 Z'}" fill="${on ? '#d62f2f' : '#8a1d1d'}"/>
      ${label(16, 28, 'I', 9, '#fff')}${label(32, 28, 'O', 9, '#fff')}
      <rect x="${on ? 10 : 26}" y="35" width="12" height="3" fill="#ffd54a"/>
    </svg>`;
  },
});

define({
  tag: 'shibo-fuse', props: { blown: false }, attrs: ['rating'],
  pins: [['1', 3, 13], ['2', 85, 13]],
  svg: (el) => `<svg width="88" height="30" viewBox="0 0 88 30" xmlns="http://www.w3.org/2000/svg">
      <path d="M0 13 H14 M74 13 H88" stroke="#c9c9c9" stroke-width="2.4"/>
      <rect x="12" y="4" width="12" height="18" fill="#c9c9c9" stroke="#888"/><rect x="64" y="4" width="12" height="18" fill="#c9c9c9" stroke="#888"/>
      <rect x="24" y="6" width="40" height="14" fill="#e9f3fb" fill-opacity=".7" stroke="#9ab"/>
      ${el.get('blown') ? '<path d="M24 13 H40 M48 13 H64" stroke="#444" stroke-width="1"/><path d="M40 13 l3 -3 M48 13 l-3 3" stroke="#333" stroke-width="1"/><ellipse cx="44" cy="13" rx="5" ry="4" fill="#555" opacity=".35"/>' : '<path d="M24 13 H64" stroke="#666" stroke-width="1"/>'}
      ${label(44, 29, el.getAttribute('rating') || 'fuse', 6, '#333')}
    </svg>`,
});

define({
  tag: 'shibo-power-module', props: { value: 1 }, attrs: ['left', 'right'], toggles: true,
  pins: [['VCC1', 10, 66], ['GND1', 22, 66], ['VCC2', 110, 66], ['GND2', 122, 66]],
  svg: (el) => {
    const on = Boolean(Number(el.get('value')));
    const rail = (a: string | null) => (/^3/.test(a ?? '') ? '3.3V' : '5V');
    return `<svg width="132" height="70" viewBox="0 0 132 70" xmlns="http://www.w3.org/2000/svg" style="cursor:pointer">
      <rect x="1" y="1" width="130" height="60" rx="3" fill="#1a6e3a" stroke="#0f4d27"/>
      <rect x="50" y="6" width="32" height="26" rx="2" fill="#151515"/><circle cx="66" cy="19" r="7" fill="#333"/>${label(66, 40, 'DC in', 5.5)}
      <rect x="88" y="8" width="16" height="12" rx="2" fill="#ddd"/><rect x="${on ? 92 : 96}" y="10" width="8" height="8" fill="#555"/>
      <circle cx="40" cy="14" r="3" fill="${on ? '#38e05a' : '#163a1f'}"/>
      ${label(16, 30, rail(el.getAttribute('left')), 7)}${label(116, 30, rail(el.getAttribute('right')), 7)}
      ${[10, 22, 110, 122].map((x, i) => header(x, 66) + label(x, 52, i % 2 ? '−' : '+', 8)).join('')}
      ${label(66, 54, 'MB102', 6, '#bfe8c9')}
    </svg>`;
  },
});
