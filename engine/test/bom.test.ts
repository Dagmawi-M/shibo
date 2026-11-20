import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProject } from '../src/project.ts';
import { billOfMaterials, priceBom, bomCsv, bomMarkdown, defaultPriceBook, parsePriceBook, itemFor, formatOhms } from '../src/bom.ts';
import { loadPrices, savePrice } from '../src/prices.ts';
import { Session, type OutMsg } from '../src/session.ts';

const root = path.resolve(import.meta.dirname, '../..');
const example = (n: string) => parseProject(JSON.parse(fs.readFileSync(path.join(root, 'examples', n, 'shibo.json'), 'utf8')), n);
const rows = (n: string) => Object.fromEntries(billOfMaterials(example(n)).map((l) => [l.key, l.qty]));

test('traffic light: board, three LEDs by colour, three 220 Ω resistors as one line, breadboard, wires', () => {
  const p = example('traffic-light');
  assert.deepEqual(rows('traffic-light'), { uno: 1, 'led:green:5mm': 1, 'led:red:5mm': 1, 'led:yellow:5mm': 1, 'resistor:220': 3, 'breadboard-400': 1, 'jumper-wire': p.wires.length });
  assert.equal(billOfMaterials(p)[0].name, 'Arduino Uno R3');
});

test('keypad lock, lcd thermometer, rgb mood light, dice', () => {
  assert.equal(rows('keypad-lock')['membrane-keypad:4x4'], 1);
  assert.equal(rows('keypad-lock')['resistor:220'], 2);
  assert.equal(rows('lcd-thermometer')['lcd1602:parallel'], 1);
  assert.equal(rows('rgb-mood-light')['rgb-led:cathode'], 1);
  assert.equal(rows('electronic-dice')['7segment:1:cathode:red'], 1);
});

test('every example gives a list with its board and counts every part once', () => {
  for (const n of fs.readdirSync(path.join(root, 'examples')).filter((d) => fs.existsSync(path.join(root, 'examples', d, 'shibo.json')))) {
    const p = example(n), lines = billOfMaterials(p);
    assert.equal(lines.reduce((s, l) => s + l.parts.length, 0), p.parts.length, n);
    assert.ok(lines.some((l) => ['uno', 'nano', 'mega', 'attiny85'].includes(l.key)), n);
  }
});

test('same part written differently is one line; a different value is another', () => {
  const p = parseProject({ version: 1, wires: [], boards: [], parts: [
    { id: 'a', type: 'resistor', x: 0, y: 0, attrs: { value: '4.7k' } }, { id: 'b', type: 'resistor', x: 0, y: 0, attrs: { value: '4k7' } },
    { id: 'c', type: 'resistor', x: 0, y: 0, attrs: { value: '10k' } }, { id: 'd', type: 'led-green', x: 0, y: 0 }, { id: 'e', type: 'led', x: 0, y: 0, attrs: { color: 'green' } },
  ] }, 't');
  const r = Object.fromEntries(billOfMaterials(p).map((l) => [l.key, l]));
  assert.equal(r['resistor:4700'].qty, 2); assert.equal(r['resistor:4700'].name, 'Resistor 4.7 kΩ');
  assert.equal(r['resistor:10000'].qty, 1); assert.equal(r['led:green:5mm'].qty, 2);
  assert.ok(!r['jumper-wire']);
  assert.equal(r['breadboard-400'].qty, 1);
  assert.equal(formatOhms(1_000_000), '1 MΩ');
  assert.equal(itemFor('lcd1602', { pins: 'i2c' }).key, 'lcd1602:i2c');
});

test('a board alone needs no breadboard; many parts need a full one', () => {
  assert.deepEqual(billOfMaterials(parseProject({ version: 1, parts: [{ id: 'u', type: 'uno', x: 0, y: 0 }], wires: [], boards: [] }, 't')).map((l) => l.key), ['uno']);
  const many = Array.from({ length: 11 }, (_, i) => ({ id: 'l' + i, type: 'led', x: 0, y: 0 }));
  assert.ok(billOfMaterials(parseProject({ version: 1, parts: many, wires: [], boards: [] }, 't')).some((l) => l.key === 'breadboard-830'));
});

test('prices are never invented: missing ones are counted, and the type price is a fallback', () => {
  const lines = billOfMaterials(example('traffic-light'));
  const empty = priceBom(lines, defaultPriceBook());
  assert.equal(empty.total, 0); assert.equal(empty.missing, lines.length);
  assert.ok(empty.lines.every((l) => l.unit === null));
  const book = defaultPriceBook();
  book.prices.resistor.price = 2; book.prices['led:red:5mm'] = { price: 5, shop: 'Merkato', date: '2026-11-01' };
  const b = priceBom(lines, book);
  assert.equal(b.lines.find((l) => l.key === 'resistor:220')!.total, 6);
  assert.equal(b.total, 11); assert.equal(b.missing, lines.length - 2);
  const csv = bomCsv(b);
  assert.match(csv, /^Qty,Part,Spec,Unit price \(ETB\)/);
  assert.match(csv, /3,Resistor 220 Ω,"1\/4 W through-hole, 5%",2\.00,6\.00/);
  assert.match(csv, /price not set/);
  assert.match(csv, new RegExp(`${lines.length - 2} prices not set`));
  assert.match(bomMarkdown(b), /\*\*Total: 11\.00 ETB\*\* \(\d+ prices not set\)/);
});

test('CSV cells cannot run as spreadsheet formulas', () => {
  const b = priceBom([{ key: 'x', base: 'x', name: '=HYPERLINK("x")', spec: '', qty: 1, parts: [] }], defaultPriceBook());
  assert.match(bomCsv(b), /"'=HYPERLINK\(""x""\)"/);
});

test('shipped prices.json lists every buyable part with no price', () => {
  const shipped = parsePriceBook(JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8')));
  assert.equal(shipped.currency, 'ETB');
  assert.deepEqual(Object.keys(shipped.prices).sort(), Object.keys(defaultPriceBook().prices).sort());
  assert.ok(Object.values(shipped.prices).every((e) => e.price === null));
});

test('bad price entries are dropped, not guessed', () => {
  const b = parsePriceBook({ currency: '<script>', prices: { a: { price: -1 }, b: { price: '5' }, c: 'x', d: { price: 3, shop: 'S' } } });
  assert.equal(b.currency, 'ETB');
  assert.equal(b.prices.a.price, null); assert.equal(b.prices.b.price, null); assert.ok(!b.prices.c); assert.equal(b.prices.d.price, 3);
});

test('prices are saved to prices.json in the project folder and read back through the session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-'));
  assert.equal(loadPrices(dir).prices.uno.price, null);
  savePrice(dir, 'resistor:220', { price: 1.5, shop: 'Shop A', date: '2026-11-20' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'prices.json'), 'utf8'));
  assert.equal(onDisk.prices['resistor:220'].price, 1.5); assert.equal(onDisk.currency, 'ETB');
  const s = new Session(); const got: OutMsg[] = []; s.onMessage((m) => got.push(m));
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'setPrice', key: 'uno', entry: { price: 1200, shop: 'B', date: '2026-11-20' } });
  await s.handle({ t: 'prices' });
  const last = got.filter((m) => m.t === 'prices').at(-1) as Extract<OutMsg, { t: 'prices' }>;
  assert.equal(last.book.prices.uno.price, 1200); assert.equal(last.book.prices['resistor:220'].price, 1.5);
  await s.handle({ t: 'setPrice', key: 'uno', entry: { price: null } });
  assert.equal(loadPrices(dir).prices.uno.price, null);
  s.dispose(); fs.rmSync(dir, { recursive: true });
});

test('the session writes the parts list as CSV and Markdown into the project folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-'));
  fs.copyFileSync(path.join(root, 'examples/traffic-light/shibo.json'), path.join(dir, 'shibo.json'));
  const s = new Session(); const got: OutMsg[] = []; s.onMessage((m) => got.push(m));
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'exportBom', format: 'csv' });
  await s.handle({ t: 'exportBom', format: 'md' });
  assert.deepEqual(got.filter((m) => m.t === 'bomExported').map((m) => path.basename((m as any).path)), ['parts-list.csv', 'parts-list.md']);
  assert.match(fs.readFileSync(path.join(dir, 'parts-list.csv'), 'utf8'), /3,Resistor 220 Ω/);
  assert.match(fs.readFileSync(path.join(dir, 'parts-list.md'), 'utf8'), /# Parts list: bom-/);
  s.dispose(); fs.rmSync(dir, { recursive: true });
});
