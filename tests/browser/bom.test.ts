// The Parts list panel: open an example, see the right rows, set a price
// (saved to prices.json in the project folder), export CSV.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromePath } from './cdp.ts';
import { openEditor, closeBrowser } from './helpers.ts';

const skip = chromePath ? false : 'no Chromium-family browser found (set CHROME)';
const EX = path.resolve(import.meta.dirname, '..', '..', 'examples', 'traffic-light');
after(closeBrowser);

test('parts list: rows for the traffic light, edit a price, export CSV', { skip }, async () => {
  const project = JSON.parse(fs.readFileSync(path.join(EX, 'shibo.json'), 'utf8'));
  const ed = await openEditor(project, { sketch: fs.readFileSync(path.join(EX, 'sketch.ino'), 'utf8'), size: { width: 1440, height: 900 } });
  try {
    const { page, dir } = ed;
    await page.waitFor(`document.querySelectorAll('#canvas .part').length === ${project.parts.length}`, { what: 'parts drawn' });
    await page.click('#bom');
    await page.waitFor(`!document.getElementById('bom-panel').hidden && /saved in/.test(document.querySelector('#bom-panel .note').textContent)`, { what: 'panel open with prices loaded' });
    const rows: string[] = await page.eval(`[...document.querySelectorAll('#bom-panel tbody tr')].map((r) => r.children[0].textContent + ' ' + r.children[1].firstChild.textContent)`);
    assert.deepEqual(rows, ['1 Arduino Uno R3', '1 LED, green, 5 mm', '1 LED, red, 5 mm', '1 LED, yellow, 5 mm', '3 Resistor 220 Ω', '1 Breadboard, half size (400 points)', `${project.wires.length} Jumper wires`]);
    assert.match(await page.eval(`document.querySelector('#bom-panel .total').textContent`), /Total: 0\.00 ETB · 7 prices not set/);

    await page.eval(`(() => { const i = document.querySelector('#bom-panel tr[data-key="resistor:220"] input.price'); i.value = '2.5'; i.dispatchEvent(new Event('change')); })()`);
    await page.waitFor(`/Total: 7\\.50 ETB · 6 prices not set/.test(document.querySelector('#bom-panel .total').textContent)`, { what: 'total updated' });
    const file = path.join(dir, 'prices.json');
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).prices['resistor:220'].price, 2.5);

    await page.click('#bom-csv');
    await page.waitFor(`/parts-list\\.csv/.test(document.querySelector('#bom-panel .note').textContent)`, { what: 'export reported' });
    const csv = fs.readFileSync(path.join(dir, 'parts-list.csv'), 'utf8');
    assert.match(csv, /^Qty,Part,Spec/);
    assert.match(csv, /3,Resistor 220 Ω,"1\/4 W through-hole, 5%",2\.50,7\.50/);
    assert.match(csv, /6 prices not set/);
    if (process.env.SHIBO_SHOTS) await page.screenshot(path.join(process.env.SHIBO_SHOTS, 'parts-list.png'));
    assert.deepEqual(page.errors, []);
  } finally { await ed.close(); }
});
