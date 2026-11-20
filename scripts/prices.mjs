// Writes prices.json: every buyable part with no price. Run: node scripts/prices.mjs
import fs from 'node:fs';
import path from 'node:path';
const { defaultPriceBook } = await import('../engine/src/bom.ts');
fs.writeFileSync(path.resolve(import.meta.dirname, '..', 'prices.json'), JSON.stringify(defaultPriceBook(), null, 2) + '\n');
