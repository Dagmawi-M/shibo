// Drawings for the driver boards and relay modules.
import { define, header, label, terminal } from './base.ts';

const screw = (x: number, y: number, w: number, h: number, n: number, vertical: boolean) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" fill="#2f73c9" stroke="#1d4f8f"/>` +
  Array.from({ length: n }, (_, i) => { const cx = vertical ? x + w / 2 : x + (w / n) * (i + 0.5), cy = vertical ? y + (h / n) * (i + 0.5) : y + h / 2; return `<circle cx="${cx}" cy="${cy}" r="3" fill="#ccc" stroke="#888"/><path d="M${cx - 2} ${cy} h4" stroke="#666"/>`; }).join('');
const led = (x: number, y: number, on: unknown, color = '#ff3b30', off = '#5a1a16') => `<circle cx="${x}" cy="${y}" r="3" fill="${on ? color : off}"/>`;

const L298_BOTTOM: [string, number][] = [['12V', 16], ['GND', 30], ['5V', 44], ['ENA', 70], ['IN1', 80], ['IN2', 90], ['IN3', 100], ['IN4', 110], ['ENB', 120]];
define({
  tag: 'shibo-l298n', props: { powered: false },
  pins: [['OUT1', 6, 52], ['OUT2', 6, 72], ['OUT3', 144, 72], ['OUT4', 144, 52], ...L298_BOTTOM.map(([n, x]): [string, number, number] => [n, x, 146])],
  svg: (el) => `<svg width="150" height="150" viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="148" height="148" rx="4" fill="#c4262e" stroke="#8e1a20"/>
      <rect x="44" y="4" width="62" height="40" fill="#1b1b1b"/>${Array.from({ length: 9 }, (_, i) => `<rect x="${47 + i * 6.6}" y="4" width="3" height="40" fill="#333"/>`).join('')}
      <rect x="54" y="46" width="42" height="16" fill="#111"/>${label(75, 57, 'L298N', 7, '#ddd')}
      ${screw(0, 42, 12, 40, 2, true)}${screw(138, 42, 12, 40, 2, true)}
      ${label(16, 54, 'OUT1', 5, '#fff', 'start')}${label(16, 74, 'OUT2', 5, '#fff', 'start')}${label(134, 54, 'OUT4', 5, '#fff', 'end')}${label(134, 74, 'OUT3', 5, '#fff', 'end')}
      ${screw(6, 140, 46, 12, 3, false)}
      ${L298_BOTTOM.slice(3).map(([, x]) => header(x, 146)).join('')}
      ${L298_BOTTOM.map(([n, x]) => label(x + 2, 132, n, 5.5, '#fff', 'start', -90)).join('')}
      <rect x="66" y="80" width="8" height="6" fill="#111"/>${label(70, 96, 'jumper', 4.5, '#fbb')}
      ${led(120, 94, el.get('powered'))}${label(120, 104, 'PWR', 5)}
      <circle cx="28" cy="100" r="10" fill="#1a1a1a"/><circle cx="28" cy="100" r="7" fill="#2b2b2b"/>
    </svg>`,
});

const L9110_HEADER = ['B-IA', 'B-IB', 'GND', 'VCC', 'A-IA', 'A-IB'];
define({
  tag: 'shibo-l9110', props: { powered: false },
  pins: [['MOTOR-B1', 6, 10], ['MOTOR-B2', 6, 22], ['MOTOR-A1', 6, 44], ['MOTOR-A2', 6, 56], ...L9110_HEADER.map((n, i): [string, number, number] => [n, 108, 8 + i * 10])],
  svg: (el) => `<svg width="112" height="66" viewBox="0 0 112 66" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="110" height="64" rx="3" fill="#1d5fae" stroke="#123f75"/>
      ${screw(0, 4, 12, 24, 2, true)}${screw(0, 38, 12, 24, 2, true)}
      ${label(16, 18, 'MOTOR B', 5, '#fff', 'start')}${label(16, 52, 'MOTOR A', 5, '#fff', 'start')}
      <rect x="44" y="12" width="14" height="10" fill="#111"/><rect x="44" y="42" width="14" height="10" fill="#111"/>${label(51, 34, 'L9110', 6, '#ddd')}
      ${L9110_HEADER.map((n, i) => header(108, 8 + i * 10) + label(100, 10 + i * 10, n, 5, '#fff', 'end')).join('')}
      ${led(70, 56, el.get('powered'))}
    </svg>`,
});

const relay = (tag: string, trigger: string) => define({
  tag, props: { on: false },
  pins: [['VCC', 6, 22], ['GND', 6, 35], ['IN', 6, 48], ['NO', 114, 16], ['COM', 114, 35], ['NC', 114, 54]],
  svg: (el) => `<svg width="120" height="70" viewBox="0 0 120 70" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="118" height="68" rx="3" fill="#1f5fa8" stroke="#143f70"/>
      ${['VCC', 'GND', 'IN'].map((n, i) => header(6, 22 + i * 13) + label(13, 24 + i * 13, n, 5.5, '#fff', 'start')).join('')}
      <rect x="40" y="8" width="52" height="40" rx="2" fill="#2a7de1" stroke="#1a5aa8"/>
      ${label(66, 22, 'SRD-05VDC', 5.5, '#e8f1ff')}${label(66, 32, el.get('on') ? 'NO closed' : 'NC closed', 6, '#fff')}
      <rect x="40" y="52" width="14" height="9" fill="#ddd"/>${label(47, 59, 'opto', 4.5, '#333')}
      ${led(64, 57, el.get('on'))}${label(84, 60, trigger, 4.5, '#cde')}
      <rect x="104" y="4" width="16" height="62" rx="1.5" fill="#2f73c9" stroke="#1d4f8f"/>
      ${[['NO', 16], ['COM', 35], ['NC', 54]].map(([n, y]) => terminal(114, Number(y)) + label(102, Number(y) + 2, String(n), 5, '#fff', 'end')).join('')}
    </svg>`,
});
relay('shibo-relay-module', 'LOW trigger');
relay('shibo-relay-module-high', 'HIGH trigger');
