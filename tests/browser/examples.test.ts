// Every example opens cleanly in the editor: all parts drawn where they do
// not cover each other, every wire drawn, nothing listed under Problems.
// SHIBO_SHOTS=<folder> also saves a screenshot of each.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromePath } from './cdp.ts';
import { openEditor, closeBrowser, count } from './helpers.ts';

const skip = chromePath ? false : 'no Chromium-family browser found (set CHROME)';
const ROOT = path.resolve(import.meta.dirname, '..', '..', 'examples');
const names = fs.readdirSync(ROOT).filter((n) => fs.existsSync(path.join(ROOT, n, 'shibo.json'))).sort();
after(closeBrowser);

for (const name of names) {
  test(`example ${name} opens cleanly`, { skip }, async () => {
    const project = JSON.parse(fs.readFileSync(path.join(ROOT, name, 'shibo.json'), 'utf8'));
    const ed = await openEditor(project, { sketch: fs.readFileSync(path.join(ROOT, name, 'sketch.ino'), 'utf8'), size: { width: 1440, height: 900 } });
    try {
      const { page } = ed;
      await page.waitFor(`document.querySelectorAll('#canvas .part').length === ${project.parts.length}`, { what: `${project.parts.length} parts drawn` });
      await page.waitFor(`document.querySelectorAll('#wires path.wire').length === ${project.wires.length}`, { what: `${project.wires.length} wires drawn` });
      assert.match(await page.eval(`document.getElementById('problems').textContent`), /No problems found/);
      assert.equal(await count(page, '#canvas .part.box'), 0, 'every part has a drawing');
      // No part sits on top of another (a little touching is allowed).
      const overlaps: string[] = await page.eval(`(() => {
        const boxes = [...document.querySelectorAll('#canvas .part')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.id, r }; });
        const out = [];
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].r, b = boxes[j].r;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 4 && h > 4) out.push(boxes[i].id + ' covers ' + boxes[j].id);
        }
        return out; })()`);
      assert.deepEqual(overlaps, [], 'parts do not cover each other');
      if (process.env.SHIBO_SHOTS) {
        await page.click('#fit');
        await new Promise((r) => setTimeout(r, 200));
        await page.screenshot(path.join(process.env.SHIBO_SHOTS, `${name}.png`));
      }
      assert.deepEqual(page.errors, []);
    } finally { await ed.close(); }
  });
}
