// The price book on disk: prices.json in the project folder (the workspace in
// VS Code, the served folder in the standalone app). Until the owner saves a
// price there, every buyable part is listed with no price.
import fs from 'node:fs';
import path from 'node:path';
import { writeInFolder } from './safewrite.ts';
import { billOfMaterials, bomCsv, bomMarkdown, defaultPriceBook, parsePriceBook, priceBom, type PriceBook, type PriceEntry } from './bom.ts';
import type { Project } from './project.ts';

export const PRICES_FILE = 'prices.json';

/** The defaults with whatever the folder's prices.json says laid over them. */
export function loadPrices(dir: string): PriceBook {
  const book = defaultPriceBook();
  const file = path.join(dir, PRICES_FILE);
  if (!dir || !fs.existsSync(file)) return book;
  const own = parsePriceBook(JSON.parse(fs.readFileSync(file, 'utf8')));
  return { currency: own.currency, prices: { ...book.prices, ...own.prices } };
}

/** Set one entry (a null price clears it) and write the whole book back. */
export function savePrice(dir: string, key: string, entry: PriceEntry, currency?: string): PriceBook {
  if (!dir) throw new Error('open a project folder before saving prices');
  if (typeof key !== 'string' || !key || key.length > 120) throw new Error('that price has no usable part key');
  const book = loadPrices(dir);
  const clean = parsePriceBook({ prices: { [key]: { ...book.prices[key], ...entry } } }).prices[key];
  if (!clean) throw new Error('that price entry is not usable');
  book.prices[key] = clean;
  if (currency) book.currency = parsePriceBook({ currency }).currency;
  writeInFolder(path.join(dir, PRICES_FILE), JSON.stringify(book, null, 2) + '\n');
  return book;
}

/** Write the priced parts list into the project folder; returns the file written. */
export function exportBom(dir: string, project: Project, format: 'csv' | 'md'): string {
  if (!dir) throw new Error('no project folder is open');
  const b = priceBom(billOfMaterials(project), loadPrices(dir));
  const file = path.join(dir, `parts-list.${format}`);
  writeInFolder(file, format === 'csv' ? bomCsv(b) : bomMarkdown(b, `Parts list: ${path.basename(dir)}`));
  return file;
}
