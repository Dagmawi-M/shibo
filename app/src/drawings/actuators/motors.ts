// Drawings for the motors: DC motor, fan, vibration motor, water pump, solenoid, 28BYJ-48 with ULN2003.
import { define, label, turnRate } from './base.ts';

const leads = (pins: [number, number, string][], fromY: number) =>
  pins.map(([x, y, c]) => `<path d="M${x} ${fromY} V${y}" stroke="${c}" stroke-width="2" fill="none"/><rect x="${x - 2}" y="${y - 3}" width="4" height="4" fill="#bbb"/>`).join('');

define({
  tag: 'shibo-dc-motor', props: { rpm: 0 },
  pins: [['1', 28, 98], ['2', 52, 98]],
  spin: (el) => turnRate(el.get('rpm')),
  svg: (el) => {
    const rpm = Number(el.get('rpm')) || 0;
    return `<svg width="80" height="100" viewBox="0 0 80 100" xmlns="http://www.w3.org/2000/svg">
      <defs><radialGradient id="can" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#f4f4f4"/><stop offset="1" stop-color="#8d9196"/></radialGradient></defs>
      <rect x="24" y="62" width="8" height="26" fill="#c08a3e"/><rect x="48" y="62" width="8" height="26" fill="#c08a3e"/>
      ${leads([[28, 98, '#c33'], [52, 98, '#222']], 88)}
      <circle cx="40" cy="36" r="31" fill="url(#can)" stroke="#6c7075"/>
      <circle cx="40" cy="36" r="11" fill="#5b5f63"/>
      <g transform="translate(40 36)"><g id="rot">
        <path d="M-3 -27 L3 -27 L2 -11 L-2 -11 Z" fill="#e8b64a"/><circle r="4" fill="#ddd" stroke="#888"/>
        <path d="M0 -4 V-24" stroke="#c33" stroke-width="1.6"/>
      </g></g>
      ${label(40, 80, rpm ? `${rpm} rpm` : 'DC motor', 8, '#333')}
    </svg>`;
  },
});

define({
  tag: 'shibo-fan', props: { rpm: 0 },
  pins: [['+', 32, 94], ['-', 48, 94]],
  spin: (el) => turnRate(el.get('rpm')),
  svg: (el) => {
    const blades = Array.from({ length: 7 }, (_, i) => `<path d="M0 -6 C10 -10 18 -22 6 -30 C2 -24 -2 -14 0 -6Z" fill="#3a3d42" transform="rotate(${i * (360 / 7)})"/>`).join('');
    return `<svg width="80" height="96" viewBox="0 0 80 96" xmlns="http://www.w3.org/2000/svg">
      ${leads([[32, 94, '#c33'], [48, 94, '#222']], 76)}
      <rect x="2" y="2" width="76" height="76" rx="6" fill="#1e2024"/>
      ${[[9, 9], [71, 9], [9, 71], [71, 71]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="#555"/>`).join('')}
      <circle cx="40" cy="40" r="34" fill="#111"/>
      <g transform="translate(40 40)"><g id="rot">${blades}</g></g>
      <circle cx="40" cy="40" r="9" fill="#2b2e33" stroke="#444"/>${label(40, 42.5, Number(el.get('rpm')) ? `${el.get('rpm')}` : '5V', 6, '#aaa')}
    </svg>`;
  },
});

define({
  tag: 'shibo-vibration-motor', props: { on: false },
  pins: [['1', 16, 54], ['2', 32, 54]],
  svg: (el) => `<svg width="48" height="56" viewBox="0 0 48 56" xmlns="http://www.w3.org/2000/svg">
      ${leads([[16, 54, '#c33'], [32, 54, '#36c']], 34)}
      <g class="${el.get('on') ? 'buzz' : ''}"><circle cx="24" cy="20" r="17" fill="#b9bdc2" stroke="#777"/><circle cx="24" cy="20" r="12" fill="#cfd3d8"/>
      ${label(24, 22, el.get('on') ? '))) (((' : 'VIB', 5.5, '#555')}</g>
    </svg>`,
});

define({
  tag: 'shibo-water-pump', props: { on: false },
  pins: [['+', 28, 86], ['-', 44, 86]],
  svg: (el) => `<svg width="72" height="88" viewBox="0 0 72 88" xmlns="http://www.w3.org/2000/svg">
      ${leads([[28, 86, '#c33'], [44, 86, '#222']], 66)}
      <rect x="40" y="6" width="9" height="20" fill="#d9e4ea" stroke="#9ab"/>
      ${el.get('on') ? `<g class="drip"><circle cx="44.5" cy="4" r="2.4" fill="#3b9be0"/></g>` : ''}
      <rect x="14" y="22" width="44" height="46" rx="8" fill="#2e3440"/>
      <rect x="18" y="56" width="36" height="8" fill="#3d4553"/>
      ${[0, 1, 2, 3, 4].map((i) => `<rect x="${20 + i * 7}" y="58" width="3" height="5" fill="#1b1f26"/>`).join('')}
      ${label(36, 42, 'PUMP', 8)}${label(36, 51, el.get('on') ? 'pumping' : '3-6 V', 5.5, el.get('on') ? '#7fd1ff' : '#aab')}
    </svg>`,
});

define({
  tag: 'shibo-solenoid', props: { on: false },
  pins: [['1', 40, 56], ['2', 56, 56]],
  svg: (el) => {
    const out = el.get('on') ? 0 : 12;          // pulled in while energised; the spring pushes it out again
    return `<svg width="104" height="58" viewBox="0 0 104 58" xmlns="http://www.w3.org/2000/svg">
      ${leads([[40, 56, '#c33'], [56, 56, '#222']], 40)}
      <rect x="${66 + out}" y="15" width="30" height="10" rx="2" fill="#c7cbd0" stroke="#888"/>
      <rect x="20" y="6" width="56" height="34" rx="2" fill="#8e9398" stroke="#666"/>
      <rect x="26" y="10" width="44" height="26" fill="#c7782d"/>
      ${Array.from({ length: 10 }, (_, i) => `<path d="M${28 + i * 4.3} 10 V36" stroke="#9a5a1e" stroke-width="1"/>`).join('')}
      <rect x="2" y="17" width="18" height="6" fill="#c7cbd0" stroke="#888"/>
      ${label(48, 52, el.get('on') ? 'pulled in' : '', 6, '#333')}
    </svg>`;
  },
});

define({
  tag: 'shibo-28byj48', props: { angle: 0, coils: [0, 0, 0, 0] },
  pins: [['IN1', 168, 30], ['IN2', 168, 40], ['IN3', 168, 50], ['IN4', 168, 60], ['VCC', 168, 84], ['GND', 168, 94]],
  svg: (el) => {
    const c = el.get('coils'), coils = Array.isArray(c) ? c : [0, 0, 0, 0];
    const deg = Number(el.get('angle')) || 0;
    return `<svg width="172" height="112" viewBox="0 0 172 112" xmlns="http://www.w3.org/2000/svg">
      <path d="M78 52 C92 52 92 100 104 100" stroke="#e33" stroke-width="5" fill="none" opacity=".75"/>
      <rect x="6" y="8" width="88" height="14" rx="3" fill="#a9b0b8"/>
      <circle cx="16" cy="15" r="3" fill="#777"/><circle cx="84" cy="15" r="3" fill="#777"/>
      <circle cx="50" cy="56" r="40" fill="#2d63b3" stroke="#1d4a8a" stroke-width="2"/>
      <circle cx="50" cy="44" r="14" fill="#c9ced4" stroke="#8a9096"/>
      <g transform="translate(50 44) rotate(${deg.toFixed(2)})"><rect x="-2.4" y="-12" width="4.8" height="12" rx="1" fill="#f3f3f3" stroke="#777" stroke-width=".6"/><rect x="-2.4" y="-12" width="4.8" height="3" fill="#e33"/></g>
      ${label(50, 78, '28BYJ-48', 7)}${label(50, 88, `${deg.toFixed(1)}°`, 7, '#cfe0ff')}
      <rect x="100" y="14" width="64" height="94" rx="3" fill="#1f7a3c" stroke="#145c2c"/>
      <rect x="108" y="56" width="28" height="44" fill="#222"/>${label(122, 80, 'ULN2003', 5, '#bbb', 'middle', -90)}
      ${['A', 'B', 'C', 'D'].map((n, i) => `<circle cx="${110 + i * 14}" cy="26" r="4" fill="${coils[i] ? '#ff3b30' : '#5a1a16'}"/>${label(110 + i * 14, 38, n, 6)}`).join('')}
      ${[['IN1', 30], ['IN2', 40], ['IN3', 50], ['IN4', 60], ['+', 84], ['-', 94]].map(([n, y]) => label(160, Number(y) + 2, String(n), 6, '#fff', 'end')).join('')}
      ${[30, 40, 50, 60, 84, 94].map((y) => `<rect x="165" y="${y - 3}" width="6" height="6" fill="#222"/><rect x="166.8" y="${y - 1.2}" width="2.4" height="2.4" fill="#d8b04a"/>`).join('')}
    </svg>`;
  },
});
