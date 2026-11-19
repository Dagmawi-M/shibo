// Modules on a serial line: HC-05 Bluetooth and a NEO-6M GPS.
// Both speak at the pin level, so a sketch reaches them with SoftwareSerial
// (the board's own pins 0 and 1 go to the serial monitor, not into the circuit).
import type { PartDef } from '../../part.ts';
import { keep, powered } from '../util.ts';
import { uart, uartState } from './uart.ts';

const MAX_LOG = 2000;
const clip = (t: string) => (t.length > MAX_LOG ? t.slice(-MAX_LOG) : t);

// ---------- HC-05 Bluetooth ----------
// With EN (KEY) high at power-up it starts in command mode at 38400 baud and answers
// AT commands; otherwise it starts in data mode at its set rate (9600 from the factory)
// and passes bytes between the board and the paired phone (the chat box on the page).
const hc05: PartDef = {
  type: 'hc05', pins: ['STATE', 'RXD', 'TXD', 'GND', 'VCC', 'EN'],
  ui: { label: 'Bluetooth (HC-05)', tag: 'shibo-hc05', group: 'Modules', chat: true },
  controls: { connected: { kind: 'toggle', initial: 1, label: 'Phone connected' } },
  links: () => [],
  device(ctx) {
    const s = {
      on: false, at: false, line: '', heard: '', name: 'HC-05', pin: '1234', role: 0, dataBaud: 9600,
      u: uartState(9600),
    };
    const port = uart(ctx, s.u, 'RXD', (b) => {
      if (!s.at) { if (ctx.control('connected')) { s.heard = clip(s.heard + String.fromCharCode(b)); ctx.changed(); } return; }
      if (b === 10) { const cmd = s.line.replace(/\r$/, ''); s.line = ''; port.send(answer(cmd)); } else s.line += String.fromCharCode(b);
    }, () => s.on);
    const answer = (cmd: string): string => {
      const c = cmd.trim(), u = c.toUpperCase();
      const ok = 'OK\r\n', reply = (t: string) => `${t}\r\n${ok}`;
      if (u === 'AT') return ok;
      if (u === 'AT+VERSION?' || u === 'AT+VERSION') return reply('+VERSION:2.0-20100601');
      if (u === 'AT+NAME?' || u === 'AT+NAME') return reply(`+NAME:${s.name}`);
      if (u.startsWith('AT+NAME=')) { s.name = c.slice(8); return ok; }
      if (u === 'AT+PSWD?' || u === 'AT+PIN?') return reply(`+PSWD:${s.pin}`);
      if (u.startsWith('AT+PSWD=') || u.startsWith('AT+PIN=')) { s.pin = c.slice(c.indexOf('=') + 1).replace(/"/g, ''); return ok; }
      if (u === 'AT+ROLE?') return reply(`+ROLE:${s.role}`);
      if (u.startsWith('AT+ROLE=')) { const r = Number(c.slice(8)); if (r >= 0 && r <= 2) { s.role = r; return ok; } return 'ERROR:(1D)\r\n'; }
      if (u === 'AT+UART?') return reply(`+UART:${s.dataBaud},0,0`);
      if (u.startsWith('AT+UART=')) {
        const b = Number(c.slice(8).split(',')[0]);
        if ([4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1382400].includes(b)) { s.dataBaud = b; return ok; }
        return 'ERROR:(1D)\r\n';
      }
      if (u === 'AT+ADDR?') return reply('+ADDR:98d3:31:fd5a2e');
      if (u === 'AT+STATE?') return reply(ctx.control('connected') ? '+STATE:CONNECTED' : '+STATE:INITIALIZED');
      if (u === 'AT+ORGL') { s.name = 'HC-05'; s.pin = '1234'; s.role = 0; s.dataBaud = 9600; return ok; }
      if (u === 'AT+RESET') { s.at = false; s.u.baud = s.dataBaud; return ok; }
      return 'ERROR:(0)\r\n';
    };
    return {
      onChange() {
        const on = powered(ctx);
        if (on && !s.on) { s.at = ctx.level('EN') === 1; s.u.baud = s.at ? 38400 : s.dataBaud; s.line = ''; }
        s.on = on;
        port.onChange();
      },
      drives() {
        if (!s.on) return [];
        // The STATE pin is high while a phone is connected (in data mode).
        return [{ pin: 'TXD', level: port.txLevel() }, { pin: 'STATE', level: !s.at && ctx.control('connected') ? 1 : 0 }];
      },
      /** Text the phone sends: it reaches the board only in data mode, while connected. */
      text(t: string) { if (s.on && !s.at && ctx.control('connected')) port.send(t); },
      outputs: () => ({ powered: s.on, mode: s.on ? (s.at ? 'AT' : 'data') : 'off', received: s.heard, name: s.name }),
      ...keep(s),
    };
  },
};

// ---------- NEO-6M GPS ----------
// Sends a burst of NMEA sentences once a second at 9600 baud: GGA, GSA, RMC and VTG.
// The position, height, speed and number of satellites come from the panel.
const START = Date.UTC(2026, 0, 1, 0, 0, 0);
const sum = (body: string) => { let x = 0; for (const ch of body) x ^= ch.charCodeAt(0); return x.toString(16).toUpperCase().padStart(2, '0'); };
const nmea = (body: string) => `$${body}*${sum(body)}\r\n`;
const two = (n: number) => String(Math.floor(n)).padStart(2, '0');
function coord(v: number, degDigits: number, pos: string, neg: string): [string, string] {
  const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
  return [String(d).padStart(degDigits, '0') + m.toFixed(5).padStart(8, '0'), v < 0 ? neg : pos];
}
/** The sentences for one second, given the time in milliseconds since 1970. */
export function gpsBurst(ms: number, c: { lat: number; lon: number; alt: number; speed: number; course: number; sats: number }): string {
  const d = new Date(ms), fix = c.sats >= 3;
  const hms = `${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}.00`;
  const date = `${two(d.getUTCDate())}${two(d.getUTCMonth() + 1)}${two(d.getUTCFullYear() % 100)}`;
  const [la, ns] = coord(c.lat, 2, 'N', 'S'), [lo, ew] = coord(c.lon, 3, 'E', 'W');
  const knots = (c.speed / 1.852).toFixed(3), course = c.course.toFixed(2);
  const pos = fix ? [la, ns, lo, ew] : ['', '', '', ''];
  return nmea(`GPGGA,${hms},${pos.join(',')},${fix ? 1 : 0},${two(c.sats)},${fix ? '1.01' : '99.99'},${fix ? c.alt.toFixed(1) : ''},M,${fix ? '-34.0' : ''},M,,`)
    + nmea(`GPGSA,A,${fix ? 3 : 1},,,,,,,,,,,,,${fix ? '1.72,1.01,1.39' : '99.99,99.99,99.99'}`)
    + nmea(`GPRMC,${hms},${fix ? 'A' : 'V'},${pos.join(',')},${fix ? knots : ''},${fix ? course : ''},${date},,,${fix ? 'A' : 'N'}`)
    + nmea(`GPVTG,${fix ? course : ''},T,,M,${fix ? knots : ''},N,${fix ? c.speed.toFixed(3) : ''},K,${fix ? 'A' : 'N'}`);
}
const gps: PartDef = {
  type: 'gps-neo6m', pins: ['VCC', 'RX', 'TX', 'GND'],
  ui: { label: 'GPS (NEO-6M)', tag: 'shibo-gps-neo6m', group: 'Modules' },
  controls: {
    lat: { kind: 'range', min: -90, max: 90, initial: 9.0054, step: 0.0001, label: 'Latitude', unit: '°' },
    lon: { kind: 'range', min: -180, max: 180, initial: 38.7636, step: 0.0001, label: 'Longitude', unit: '°' },
    alt: { kind: 'range', min: -100, max: 9000, initial: 2355, step: 1, label: 'Height', unit: 'm' },
    speed: { kind: 'range', min: 0, max: 300, initial: 0, step: 0.1, label: 'Speed', unit: 'km/h' },
    course: { kind: 'range', min: 0, max: 359, initial: 0, step: 1, label: 'Heading', unit: '°' },
    sats: { kind: 'range', min: 0, max: 12, initial: 8, step: 1, label: 'Satellites in view' },
  },
  links: () => [],
  device(ctx) {
    const s = { on: false, u: uartState(9600), sent: 0 };
    // The module ignores what it is sent (UBX and PMTK configuration is not modelled).
    const port = uart(ctx, s.u, 'RX', () => {});
    const c = (k: string) => ctx.control(k);
    const tick = (): void => {
      if (s.on) {
        port.send(gpsBurst(START + Math.floor(ctx.now() / 1e9) * 1000, { lat: c('lat'), lon: c('lon'), alt: c('alt'), speed: c('speed'), course: c('course'), sats: c('sats') }));
        s.sent++;
      }
      ctx.after(1e9 - (ctx.now() % 1e9), tick);
    };
    // The first burst comes a little after power-up, as the module boots.
    ctx.after(1e8, tick);
    return {
      onChange() { s.on = powered(ctx); port.onChange(); },
      drives: () => (s.on ? [{ pin: 'TX', level: port.txLevel() }] : []),
      outputs: () => ({ powered: s.on, fix: s.on && c('sats') >= 3 }),
      ...keep(s),
    };
  },
};

export const serialModules: PartDef[] = [hc05, gps];
