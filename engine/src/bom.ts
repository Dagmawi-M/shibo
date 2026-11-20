// Bill of materials: from a project, the real parts you would buy, grouped,
// with prices taken only from a price book the owner fills in.
// Prices are never invented: an entry without a price stays "price not set".
import { library } from './parts/index.ts';
import { boardPins, type Project } from './project.ts';
import { catalogInfo } from './catalog-info.ts';
import { ohms } from './electrical/ratings.ts';

export interface BomLine {
  /** What identifies this line in the price book, e.g. "led:red:5mm", "resistor:220". */
  key: string;
  /** Price book key to fall back to when the exact key has no price, e.g. "led". */
  base: string;
  name: string;
  spec: string;
  qty: number;
  /** Part ids in the circuit this line covers (empty for wires and the breadboard). */
  parts: string[];
}

export interface PriceEntry { name?: string; price: number | null; shop?: string; date?: string }
export interface PriceBook { currency: string; prices: Record<string, PriceEntry> }

export interface PricedLine extends BomLine { unit: number | null; total: number | null; shop?: string; date?: string }
export interface Bom { lines: PricedLine[]; currency: string; total: number; missing: number }

export const BOARD_NAMES: Record<string, [string, string]> = {
  uno: ['Arduino Uno R3', 'ATmega328P, USB cable needed'],
  nano: ['Arduino Nano', 'ATmega328P, mini-USB'],
  mega: ['Arduino Mega 2560', 'ATmega2560, USB cable needed'],
  attiny85: ['ATtiny85 microcontroller', 'DIP-8; needs a programmer'],
};
export const WIRE_KEY = 'jumper-wire';
export const BREADBOARD_KEYS = { half: 'breadboard-400', full: 'breadboard-830' };
/** More loose parts than this and a full-size breadboard is listed instead of a half one. */
const FULL_BREADBOARD_AFTER = 10;

const LED_COLORS: Record<string, string> = { 'led-green': 'green', 'led-blue': 'blue', 'led-yellow': 'yellow', 'led-white': 'white', 'led-orange': 'orange', 'led-pink': 'pink', 'led-purple': 'purple' };
const PLAIN_LEDS = new Set(['led', 'led-3mm', 'led-10mm', ...Object.keys(LED_COLORS)]);

/** "220" -> "220 Ω", 4700 -> "4.7 kΩ". */
export function formatOhms(n: number): string {
  const [v, u] = n >= 1e6 ? [n / 1e6, 'MΩ'] : n >= 1e3 ? [n / 1e3, 'kΩ'] : [n, 'Ω'];
  return `${Number(v.toFixed(2))} ${u}`;
}

const safe = (s: string) => s.toLowerCase().replace(/[^\w.#-]+/g, '');
const labelOf = (type: string) => library[type]?.ui?.label ?? type;
const firstSpec = (type: string) => {
  const i = catalogInfo[type];
  return i ? [i.volts, i.specs?.[0]].filter(Boolean).join(', ') : '';
};

/** What you would buy for one part: identical answers mean one line. */
export function itemFor(type: string, a: Record<string, string> = {}): Omit<BomLine, 'qty' | 'parts'> {
  if (Object.hasOwn(BOARD_NAMES, type)) { const [name, spec] = BOARD_NAMES[type]; return { key: type, base: type, name, spec }; }
  if (type.startsWith('unknown:')) return { key: type, base: type, name: type.slice(8), spec: 'Not a part Shibo knows: check what to buy' };
  if (PLAIN_LEDS.has(type)) {
    const color = safe(a.color || LED_COLORS[type] || 'red');
    const size = safe(a.size || (type === 'led-3mm' ? '3mm' : type === 'led-10mm' ? '10mm' : '5mm')).replace(/mm$/, '') + 'mm';
    return { key: `led:${color}:${size}`, base: 'led', name: `LED, ${color}, ${size.replace('mm', ' mm')}`, spec: 'Through-hole, diffused' };
  }
  switch (type) {
    case 'resistor': {
      const r = ohms(a.value, 1000);
      const v = Number.isFinite(r) ? formatOhms(r) : (a.value ?? '?');
      return { key: `resistor:${Number.isFinite(r) ? r : safe(a.value ?? '')}`, base: 'resistor', name: `Resistor ${v}`, spec: '1/4 W through-hole, 5%' };
    }
    case 'potentiometer': {
      const r = ohms(a.value, 10_000);
      const v = Number.isFinite(r) ? formatOhms(r) : (a.value ?? '?');
      return { key: `potentiometer:${Number.isFinite(r) ? r : safe(a.value ?? '')}`, base: 'potentiometer', name: `Potentiometer ${v}`, spec: 'Rotary, linear, 3 pins' };
    }
    case 'rgb-led': case 'led-bicolor': {
      const common = safe(a.common || 'cathode');
      return { key: `${type}:${common}`, base: type, name: `${labelOf(type).replace(/\s*\(.*\)$/, '')} (common ${common})`, spec: 'Through-hole, 5 mm' };
    }
    case '7segment': {
      const digits = safe(a.digits || '1'), common = safe(a.common || 'anode'), color = safe(a.color || 'red');
      return { key: `7segment:${digits}:${common}:${color}`, base: '7segment', name: `7-segment display, ${digits} digit${digits === '1' ? '' : 's'}, ${color}`, spec: `Common ${common}` };
    }
    case 'led-ring': case 'led-strip': {
      const px = safe(a.pixels || (type === 'led-ring' ? '16' : '8'));
      return { key: `${type}:${px}`, base: type, name: `${labelOf(type)}, ${px} LEDs`, spec: 'WS2812B, 5 V' };
    }
    case 'neopixel-matrix': {
      const r = safe(a.rows || '8'), c = safe(a.cols || '8');
      return { key: `neopixel-matrix:${r}x${c}`, base: type, name: `NeoPixel matrix ${r}x${c}`, spec: 'WS2812B, 5 V' };
    }
    case 'lcd1602': case 'lcd2004': {
      const i2c = a.pins === 'i2c';
      return { key: `${type}:${i2c ? 'i2c' : 'parallel'}`, base: type, name: `${labelOf(type)}${i2c ? ' with I2C backpack' : ''}`, spec: i2c ? 'HD44780 + PCF8574 backpack, 5 V' : 'HD44780, 16-pin header, 5 V' };
    }
    case 'membrane-keypad': {
      const cols = a.columns === '3' ? '3' : '4';
      return { key: `membrane-keypad:4x${cols}`, base: type, name: `Membrane keypad 4x${cols}`, spec: `${4 + Number(cols)}-pin ribbon` };
    }
    case 'fuse': {
      const rating = safe(a.rating || '');
      return { key: rating ? `fuse:${rating}` : 'fuse', base: 'fuse', name: rating ? `Fuse ${rating}${/\d$/.test(rating) ? ' A' : ''}` : 'Fuse', spec: firstSpec(type) };
    }
    case 'pushbutton': case 'pushbutton-6mm': {
      const color = safe(a.color || '');
      return { key: color ? `${type}:${color}` : type, base: type, name: `${labelOf(type)}${color ? `, ${color}` : ''}`, spec: type === 'pushbutton' ? 'Tactile, 12 mm' : 'Tactile, 6 mm' };
    }
  }
  return { key: type, base: type, name: labelOf(type), spec: firstSpec(type) };
}

/** Group a project's parts into lines of things to buy, plus jumper wires and a breadboard. */
export function billOfMaterials(p: Project): BomLine[] {
  const lines = new Map<string, BomLine>();
  let loose = 0;
  for (const part of p.parts) {
    const it = itemFor(part.type, part.attrs);
    const line = lines.get(it.key) ?? { ...it, qty: 0, parts: [] };
    line.qty++; line.parts.push(part.id);
    lines.set(it.key, line);
    if (!Object.hasOwn(boardPins, part.type)) loose++;
  }
  const out = [...lines.values()].sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
  if (loose > 0) {
    const full = loose > FULL_BREADBOARD_AFTER;
    out.push({ key: full ? BREADBOARD_KEYS.full : BREADBOARD_KEYS.half, base: full ? BREADBOARD_KEYS.full : BREADBOARD_KEYS.half,
      name: full ? 'Breadboard, full size (830 points)' : 'Breadboard, half size (400 points)', spec: 'Solderless', qty: 1, parts: [] });
  }
  if (p.wires.length) out.push({ key: WIRE_KEY, base: WIRE_KEY, name: 'Jumper wires', spec: 'Male-to-male, 20 cm', qty: p.wires.length, parts: [] });
  return out;
}
const rank = (l: BomLine) => (Object.hasOwn(BOARD_NAMES, l.key) ? 0 : 1);

/** Every buyable thing with no price: what ships as prices.json. */
export function defaultPriceBook(): PriceBook {
  const prices: Record<string, PriceEntry> = {};
  const add = (key: string, name: string) => { prices[key] = { name, price: null, shop: '', date: '' }; };
  for (const [t, [name]] of Object.entries(BOARD_NAMES)) add(t, name);
  for (const t of Object.keys(library)) {
    if (PLAIN_LEDS.has(t) && t !== 'led') continue;
    add(t, t === 'led' ? 'LED' : labelOf(t));
  }
  add(BREADBOARD_KEYS.half, 'Breadboard, half size (400 points)');
  add(BREADBOARD_KEYS.full, 'Breadboard, full size (830 points)');
  add(WIRE_KEY, 'Jumper wire (each)');
  return { currency: 'ETB', prices };
}

/** Read anything claiming to be a price book; bad entries are dropped, never guessed at. */
export function parsePriceBook(raw: unknown): PriceBook {
  const r = raw as any;
  const book: PriceBook = { currency: typeof r?.currency === 'string' && /^[A-Za-z]{1,8}$/.test(r.currency) ? r.currency : 'ETB', prices: {} };
  if (r?.prices && typeof r.prices === 'object') {
    for (const [k, v] of Object.entries(r.prices as Record<string, any>)) {
      if (!v || typeof v !== 'object' || k.length > 120) continue;
      const price = typeof v.price === 'number' && Number.isFinite(v.price) && v.price >= 0 ? v.price : null;
      book.prices[k] = { ...(typeof v.name === 'string' ? { name: v.name.slice(0, 120) } : {}), price,
        shop: typeof v.shop === 'string' ? v.shop.slice(0, 120) : '', date: typeof v.date === 'string' ? v.date.slice(0, 32) : '' };
    }
  }
  return book;
}

/** Put prices on the lines: the exact key first, then the plain part type. */
export function priceBom(lines: BomLine[], book: PriceBook): Bom {
  let total = 0, missing = 0;
  const priced = lines.map((l) => {
    const e = [book.prices[l.key], book.prices[l.base]].find((x) => x && x.price !== null);
    const unit = e ? e.price : null;
    if (unit === null) missing++; else total += unit * l.qty;
    return { ...l, unit, total: unit === null ? null : unit * l.qty, ...(e?.shop ? { shop: e.shop } : {}), ...(e?.date ? { date: e.date } : {}) };
  });
  return { lines: priced, currency: book.currency, total: Math.round(total * 100) / 100, missing };
}

const money = (n: number | null) => (n === null ? '' : n.toFixed(2));
const csvCell = (s: string | number) => {
  const t = String(s);
  // A leading = + - @ would run as a formula in a spreadsheet.
  const v = /^[=+\-@]/.test(t) ? `'${t}` : t;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export function bomCsv(b: Bom): string {
  const rows = [['Qty', 'Part', 'Spec', `Unit price (${b.currency})`, `Total (${b.currency})`, 'Shop', 'Date']];
  for (const l of b.lines) rows.push([String(l.qty), l.name, l.spec, l.unit === null ? 'price not set' : money(l.unit), money(l.total), l.shop ?? '', l.date ?? '']);
  rows.push(['', 'Total', b.missing ? `${b.missing} price${b.missing === 1 ? '' : 's'} not set` : '', '', money(b.total), '', '']);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function bomMarkdown(b: Bom, title = 'Parts list'): string {
  const esc = (s: string) => s.replace(/[|\\`*_[\]<>]/g, (c) => '\\' + c);
  const out = [`# ${esc(title)}`, '', `| Qty | Part | Spec | Unit (${b.currency}) | Total (${b.currency}) |`, '|---:|---|---|---:|---:|'];
  for (const l of b.lines) out.push(`| ${l.qty} | ${esc(l.name)} | ${esc(l.spec)} | ${l.unit === null ? 'price not set' : money(l.unit)} | ${money(l.total)} |`);
  out.push('', `**Total: ${money(b.total)} ${b.currency}**${b.missing ? ` (${b.missing} price${b.missing === 1 ? '' : 's'} not set)` : ''}`);
  return out.join('\n') + '\n';
}
