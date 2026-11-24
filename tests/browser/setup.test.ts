// A failed build that needs something installed: the Problems panel offers the
// fix, shows how it is getting on, and the sketch runs once it is done.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromePath } from './cdp.ts';
import { openEditor, closeBrowser, starter, text, count } from './helpers.ts';
import { makeRig, chain, theirs } from '../../engine/test/helpers/setup-rig.ts';

const skip = chromePath ? (process.platform === 'win32' ? 'the stand-in compiler is a shell script' : false) : 'no Chromium-family browser found (set CHROME)';
const SKETCH = 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() {}\n';
const COMPILER = 'Download the Arduino compiler (about 80 MB, one time)';
after(closeBrowser);

test('with no compiler, the panel offers the download, shows progress with Cancel, and then runs the sketch', { skip }, async () => {
  const rig = await makeRig();
  const ed = await openEditor(starter, { sketch: SKETCH, toolchain: chain(rig) });
  try {
    const { page } = ed;
    await page.click('#run');
    await page.waitFor(`document.querySelector('#problems .fix button.do')`, { what: 'the fix button' });
    assert.equal(await text(page, '#problems .fix button.do'), COMPILER);
    assert.match(await text(page, '#problems li'), /Shibo needs the Arduino compiler/);
    assert.equal(await count(page, '#problems code'), 0);

    rig.answer = 'half';                                           // the download starts and then hangs
    await page.click('#problems .fix button.do');
    await page.waitFor(`document.querySelector('#problems .setup progress')?.value > 0`, { what: 'progress on the download' });
    assert.match(await text(page, '#problems .setup .what'), /Downloading the Arduino compiler/);
    assert.equal(await page.eval(`document.getElementById('run').disabled`), true, 'no second run while setting up');
    assert.equal(await count(page, '#problems .fix button.do'), 0, 'the button gives way to the progress');
    await page.click('#problems .setup button.cancel');
    await page.waitFor(`!document.querySelector('#problems .setup') && document.querySelector('#problems .fix button.do')`, { what: 'the offer to come back after cancelling' });
    assert.match(await text(page, '#problems li'), /cancelled/);

    rig.answer = 'file';
    await page.click('#problems .fix button.do');
    await page.waitFor(`/running/i.test(document.getElementById('status')?.textContent ?? '')`, { what: 'the sketch to run after setup', timeout: 20000 });
    assert.equal(await count(page, '#problems .fix'), 0); assert.equal(await count(page, '#problems .setup'), 0);
    assert.equal(rig.hits(), 2);
    assert.deepEqual(page.errors, []);
  } finally { await ed.close(); await rig.close(); }
});

test('a fix the person has to run themselves is shown as a command to copy', { skip }, async () => {
  const rig = await makeRig();
  const mine = theirs(rig); mine.installed();
  process.env.FAKE_MODE = 'rosetta';
  const ed = await openEditor(starter, { sketch: SKETCH, toolchain: chain(rig, { path: mine.bin }) });
  try {
    const { page } = ed;
    await page.click('#run');
    await page.waitFor(`document.querySelector('#problems code')`, { what: 'the command' });
    assert.equal(await text(page, '#problems code'), 'softwareupdate --install-rosetta --agree-to-license');
    assert.match(await text(page, '#problems li'), /Rosetta/);
    assert.equal(await count(page, '#problems .fix button.do'), 0);
    assert.equal(await text(page, '#problems .fix button.copy'), 'Copy');
    assert.deepEqual(page.errors, []);
  } finally { await ed.close(); await rig.close(); }
});
