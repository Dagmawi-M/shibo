// Share links and embeds, driven in headless Chromium.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromePath } from './cdp.ts';
import { openEditor, closeBrowser, starter, count, text } from './helpers.ts';

const skip = chromePath ? false : 'no Chromium-family browser found (set CHROME)';
after(closeBrowser);
const SKETCH = 'void setup() { Serial.begin(9600); }\nvoid loop() {}\n';

/** Click Share, pick a menu item, and return the text the share box offers. */
async function fromShareMenu(page: any, item: string): Promise<string> {
  await page.click('#share');
  await page.waitFor(`!document.getElementById('menu').hidden && !!document.getElementById(${JSON.stringify(item)})`, { what: 'the share menu' });
  await page.click('#' + item);
  return page.waitFor(`document.getElementById('share-text')?.value`, { what: 'the share text' });
}

test('a share link opens the same circuit and sketch in another folder', { skip }, async () => {
  const a = await openEditor(starter, { sketch: SKETCH });
  const b = await openEditor(null);
  try {
    await a.page.waitFor(`document.querySelectorAll('#canvas .part').length === 4`);
    const link = await fromShareMenu(a.page, 'share-copy');
    assert.match(link, new RegExp(`^${a.url.replace(/[.?]/g, '\\$&')}#p=v1\\.[A-Za-z0-9_-]+$`));
    // Open the link on the other folder's Shibo.
    await b.page.goto(`${b.url}?from=link${link.slice(link.indexOf('#'))}`);
    await b.page.waitFor(`document.querySelectorAll('#canvas .part').length === 4`, { what: 'the shared parts' });
    await b.page.waitFor(`document.querySelectorAll('#wires path.wire').length === 5`, { what: 'the shared wires' });
    assert.deepEqual(await b.page.eval(`[...document.querySelectorAll('#inventory .pick span')].map((s) => s.textContent)`), ['uno', 'led1', 'r1', 'btn1']);
    assert.match(await text(b.page, '#hint'), /Opened the shared circuit/);
    const ino = fs.readdirSync(b.dir).find((f) => f.endsWith('.ino'))!;
    assert.equal(fs.readFileSync(path.join(b.dir, ino), 'utf8'), SKETCH);
    // The link is used up: the address no longer carries it.
    assert.equal(await b.page.eval('location.hash'), '');
    assert.deepEqual(a.page.errors, []); assert.deepEqual(b.page.errors, []);
  } finally { await a.close(); await b.close(); }
});

test('a bad link shows a clear message and leaves the current circuit alone', { skip }, async () => {
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    await page.goto(`${ed.url}?x=1#p=v1.abc-cut-short`);
    await page.waitFor(`/Could not open that link/.test(document.getElementById('hint').textContent)`, { what: 'the bad-link message' });
    await page.waitFor(`document.querySelectorAll('#canvas .part').length === 4`, { what: 'the circuit still there' });
    // A link from a future Shibo says so.
    await page.goto(`${ed.url}?x=2#p=v7.abc`);
    await page.waitFor(`/newer Shibo/.test(document.getElementById('hint').textContent)`, { what: 'the future-version message' });
    // Open from link with rubbish says so too.
    await page.click('#share'); await page.click('#share-from');
    await page.click('#share-paste'); await page.type('not a link');
    await page.click('#share-open');
    await page.waitFor(`/not a Shibo share link/.test(document.getElementById('hint').textContent)`, { what: 'the paste message' });
    assert.equal(await count(page, '#canvas .part'), 4);
    assert.deepEqual(page.errors, []);
  } finally { await ed.close(); }
});

test('embed mode shows the circuit, Run and the serial monitor, and nothing to edit with', { skip }, async () => {
  const a = await openEditor(starter, { sketch: SKETCH });
  const b = await openEditor(null);
  try {
    await a.page.waitFor(`document.querySelectorAll('#canvas .part').length === 4`);
    const code = await fromShareMenu(a.page, 'share-embed');
    const src = code.match(/src="([^"]+)"/)![1].replace(/&amp;/g, '&');
    assert.match(src, /\?embed=1#p=v1\./);
    const { page } = b;
    await page.goto(b.url + src.slice(a.url.length));
    await page.waitFor(`document.querySelectorAll('#canvas .part').length === 4`, { what: 'the embedded circuit' });
    const shown = (sel: string) => page.eval<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null; })()`);
    assert.equal(await shown('#run'), true);
    assert.equal(await shown('#stop'), true);
    assert.equal(await shown('#serial'), true);
    assert.equal(await shown('#open-full'), true);
    for (const sel of ['.palette', '#save', '#undo', '#share', '#guide', '#props', '#problems', '#canvas .pin']) assert.equal(await shown(sel), false, `${sel} is hidden`);
    assert.doesNotMatch(await page.eval<string>(`document.getElementById('open-full').href`), /embed=1/);
    // Dragging a part does nothing.
    const before = await page.eval(`(e => e.style.left + ',' + e.style.top)(document.querySelector('#canvas wokwi-led'))`);
    const box = (await page.box('#canvas wokwi-led'))!;
    await page.drag([box.x + box.width / 2, box.y + box.height / 2], [box.x + 200, box.y + 150]);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await page.eval(`(e => e.style.left + ',' + e.style.top)(document.querySelector('#canvas wokwi-led'))`), before);
    // Run works.
    await page.click('#run');
    await page.waitFor(`/^Running/.test(document.getElementById('status').textContent)`, { what: 'the embed to run' });
    await page.click('#stop');
    assert.deepEqual(page.errors, []);
  } finally { await a.close(); await b.close(); }
});
