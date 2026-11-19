// The editor page, driven in headless Chromium the way a person uses it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromePath } from './cdp.ts';
import { openEditor, closeBrowser, starter, count, text, saved, fixture } from './helpers.ts';

const skip = chromePath ? false : 'no Chromium-family browser found (set CHROME)';
after(closeBrowser);

test('opens a project: every part is drawn, the palette is filled, nothing errors', { skip }, async () => {
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    await page.waitFor(`document.querySelectorAll('#canvas .part').length === 4`, { what: 'four parts on the canvas' });
    assert.equal(await count(page, '#canvas wokwi-arduino-uno.part'), 1);
    assert.equal(await count(page, '#canvas wokwi-led.part'), 1);
    // Every wire whose ends exist is drawn.
    await page.waitFor(`document.querySelectorAll('#wires path.wire').length === 5`, { what: 'five wires drawn' });
    // The catalog lists something in every group, and each card has a label.
    assert.ok(await count(page, '#palette .cat-card') > 100);
    assert.equal(await page.eval(`[...document.querySelectorAll('#palette .cat-card .cat-name')].filter((n) => !n.textContent.trim()).length`), 0);
    // The inventory lists the parts by id.
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('#inventory .pick span')].map((s) => s.textContent)`), ['uno', 'led1', 'r1', 'btn1']);
    assert.equal(await text(page, '#status'), 'Stopped');
    assert.match(await text(page, '#problems'), /No problems found/);
    // Every pin of every drawn part gets a clickable dot.
    assert.ok(await count(page, '#canvas .pin') > 30);
    assert.deepEqual(page.errors, []);
  } finally { await ed.close(); }
});

test('an empty folder shows the starting points, and one fills the canvas', { skip }, async () => {
  const ed = await openEditor(null);
  try {
    const { page } = ed;
    await page.waitFor(`!document.getElementById('welcome').hidden`, { what: 'the welcome box' });
    assert.ok(await count(page, '#welcome button[data-template]') >= 1);
    await page.click('#welcome button[data-template]');
    await page.waitFor(`document.querySelectorAll('#canvas .part').length > 0`, { what: 'the template parts' });
    await page.waitFor(`document.getElementById('welcome').hidden`, { what: 'the welcome box to go' });
    assert.deepEqual(page.errors, []);
  } finally { await ed.close(); }
});

test('clicking a palette card adds the part; undo and redo take it away and back', { skip }, async () => {
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    await page.waitFor(`document.querySelectorAll('#canvas .part').length === 4`);
    await page.click('#palette .cat-card[data-type="buzzer"] .cat-add');
    await page.waitFor(`document.querySelectorAll('#canvas wokwi-buzzer.part').length === 1`, { what: 'a buzzer on the canvas' });
    assert.match(await text(page, '#save'), /•/, 'the project is marked unsaved');
    await page.click('#undo');
    await page.waitFor(`document.querySelectorAll('#canvas wokwi-buzzer').length === 0`, { what: 'undo to remove the buzzer' });
    await page.click('#redo');
    await page.waitFor(`document.querySelectorAll('#canvas wokwi-buzzer').length === 1`, { what: 'redo to bring it back' });
    // Ctrl+Z from the keyboard does the same.
    await page.key('z', { ctrl: true });
    await page.waitFor(`document.querySelectorAll('#canvas wokwi-buzzer').length === 0`, { what: 'Ctrl+Z to remove the buzzer' });
    assert.deepEqual(page.errors, []);
  } finally { await ed.close(); }
});

test('search narrows the palette and clearing it brings everything back', { skip }, async () => {
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    const visible = `[...document.querySelectorAll('#palette .cat-card')].filter((b) => b.offsetParent !== null).length`;
    const all = await page.eval<number>(visible);
    await page.click('#palette .cat-search input');
    await page.type('servo');
    await page.waitFor(`${visible} < ${all}`, { what: 'the palette to narrow' });
    const names: string[] = await page.eval(`[...document.querySelectorAll('#palette .cat-card')].filter((b) => b.offsetParent !== null).map((b) => b.querySelector('.cat-name').textContent)`);
    assert.ok(names.length >= 1 && names.every((n) => /servo/i.test(n)), `only servos are left: ${names.join(', ')}`);
    await page.eval(`(() => { const f = document.querySelector('#palette .cat-search input'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);
    // The catalogue redraws on the next frame, so wait for it.
    await page.waitFor(`${visible} === ${all}`, { what: 'every part back after clearing the search' });
  } finally { await ed.close(); }
});

test('clicking one pin and then another draws a wire, and Save writes it to disk', { skip }, async () => {
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    await page.click('#palette .cat-card[data-type="buzzer"] .cat-add');
    await page.waitFor(`document.querySelector('#canvas .pin[data-ref="buzzer1:1"]')`, { what: 'the new buzzer pins' });
    const before = await count(page, '#wires path.wire');
    await page.click('#canvas .pin[data-ref="buzzer1:1"]');
    await page.waitFor(`/Wire from buzzer1:1/.test(document.getElementById('hint').textContent)`, { what: 'the wiring hint' });
    await page.click('#canvas .pin[data-ref="uno:8"]');
    await page.waitFor(`document.querySelectorAll('#wires path.wire').length === ${before + 1}`, { what: 'the new wire' });
    await page.click('#save');
    await page.waitFor(`document.getElementById('save').textContent === 'Save'`, { what: 'the save to finish' });
    const wires = saved(ed.dir).wires as { from: string; to: string }[];
    assert.ok(wires.some((w) => (w.from === 'buzzer1:1' && w.to === 'uno:8') || (w.to === 'buzzer1:1' && w.from === 'uno:8')), JSON.stringify(wires));
    assert.deepEqual(page.errors, []);
  } finally { await ed.close(); }
});

test('Escape cancels a wire that has been started', { skip }, async () => {
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    await page.click('#canvas .pin[data-ref="uno:7"]');
    await page.waitFor(`document.querySelector('#canvas .pin.from')`, { what: 'the start pin to be marked' });
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('#canvas .pin.from') && !document.querySelector('#wires path.rubber')`, { what: 'the wire to be cancelled' });
    assert.equal(await count(page, '#wires path.wire'), 5);
  } finally { await ed.close(); }
});

test('dragging a part moves it and the move is kept', { skip }, async () => {
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    const box = await page.waitFor<{ x: number; y: number; width: number; height: number }>(
      `(() => { const r = document.querySelector('#canvas wokwi-pushbutton').getBoundingClientRect(); return r.width ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`);
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.drag([cx, cy], [cx + 80, cy + 60]);
    await page.waitFor(`document.getElementById('save').textContent.includes('•')`, { what: 'the move to reach the engine' });
    await page.click('#save');
    await page.waitFor(`document.getElementById('save').textContent === 'Save'`);
    const btn = saved(ed.dir).parts.find((p: { id: string }) => p.id === 'btn1');
    assert.ok(Math.abs(btn.x - 340) <= 2 && Math.abs(btn.y - -40) <= 2, `moved to ${btn.x},${btn.y}`);
  } finally { await ed.close(); }
});

test('Upload & Run runs the sketch: serial shows, a pressed button lights the LED, Stop stops', { skip }, async () => {
  const ed = await openEditor(starter, { sketch: '// compiled ahead of time as toggle.hex\n' });
  try {
    const { page } = ed;
    assert.match(await text(page, '#sketch'), /sketch\.ino/);
    await page.click('#run');
    await page.waitFor(`/^Running/.test(document.getElementById('status').textContent)`, { what: 'the run to start' });
    await page.waitFor(`/Ready/.test(document.getElementById('serial').textContent)`, { what: '"Ready" on the serial monitor' });
    assert.equal(await page.eval(`document.getElementById('run').disabled`), true);
    assert.equal(await page.eval(`document.querySelector('#canvas wokwi-led').value`), false);
    // Press the drawn button with the mouse, as a person would.
    await page.click('#canvas wokwi-pushbutton');
    await page.waitFor(`/LED ON/.test(document.getElementById('serial').textContent)`, { what: '"LED ON" after the press' });
    await page.waitFor(`document.querySelector('#canvas wokwi-led').value === true`, { what: 'the LED drawing to light' });
    await page.click('#stop');
    await page.waitFor(`document.getElementById('status').textContent === 'Stopped'`, { what: 'the run to stop' });
    await page.waitFor(`!document.querySelector('#canvas wokwi-led').value`, { what: 'the LED to go dark' });
    assert.deepEqual(page.errors, []);
  } finally { await ed.close(); }
});

test('text typed into the serial box reaches the board', { skip }, async () => {
  const ed = await openEditor(starter, { sketch: '// echo\n', hex: fixture('echo.hex') });
  try {
    const { page } = ed;
    await page.click('#run');
    await page.waitFor(`/^Running/.test(document.getElementById('status').textContent)`, { what: 'the run to start' });
    await page.click('#serial-in');
    await page.type('hello');
    await page.key('Enter');
    await page.waitFor(`/hello/i.test(document.getElementById('serial').textContent)`, { what: 'the echo of "hello"' });
  } finally { await ed.close(); }
});

test('a wiring mistake shows up under Problems', { skip }, async () => {
  const bad = structuredClone(starter);
  bad.wires = bad.wires.filter((w) => w.from !== 'r1:1');
  bad.wires.push({ from: 'uno:13', to: 'led1:A' });                          // LED straight off a pin, no resistor
  bad.wires.push({ from: 'led1:A', to: 'nothing:1' });                       // a wire to a part that is not there
  const ed = await openEditor(bad);
  try {
    const { page } = ed;
    await page.waitFor(`/there is no part "nothing"/.test(document.getElementById('problems').textContent)`, { what: 'the broken wire problem' });
    assert.match(await text(page, '#panels'), /problem/);
    await page.click('#problems button');                                    // "Remove broken wires"
    await page.waitFor(`!/there is no part "nothing"/.test(document.getElementById('problems').textContent)`, { what: 'the broken wire to go' });
  } finally { await ed.close(); }
});

test('right-click on a part offers Rotate and Remove, and Remove works', { skip }, async () => {
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    await page.click('#canvas wokwi-led', { button: 'right' });
    await page.waitFor(`!document.getElementById('menu').hidden`, { what: 'the menu' });
    const items: string[] = await page.eval(`[...document.querySelectorAll('#menu [role=menuitem]')].map((b) => b.textContent)`);
    assert.deepEqual(items, ['Rotate', 'Duplicate', 'Copy', 'Remove led1']);
    await page.click('#menu [role=menuitem]:last-child');
    await page.waitFor(`!document.querySelector('#canvas wokwi-led')`, { what: 'the LED to be removed' });
    assert.ok(!(await page.eval<string[]>(`[...document.querySelectorAll('#inventory .pick span')].map((s) => s.textContent)`)).includes('led1'));
  } finally { await ed.close(); }
});

test('zoom buttons change the zoom and Fit brings it back into view', { skip }, async () => {
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    await page.click('#zoom-in');
    await page.waitFor(`document.getElementById('zoom-level').textContent === '120%'`, { what: 'zoom to 120%' });
    await page.click('#zoom-level');
    await page.waitFor(`document.getElementById('zoom-level').textContent === '100%'`, { what: 'zoom back to 100%' });
    await page.click('#fit');
    const z = await page.eval<string>(`document.getElementById('zoom-level').textContent`);
    assert.match(z, /^\d+%$/);
  } finally { await ed.close(); }
});

test('the page draws in both light and dark mode with readable text', { skip }, async () => {
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    const colours = `(() => { const s = getComputedStyle(document.body); return [s.backgroundColor, s.color]; })()`;
    await page.colorScheme('light');
    const [lightBg, lightInk] = await page.eval<string[]>(colours);
    await page.colorScheme('dark');
    const [darkBg, darkInk] = await page.eval<string[]>(colours);
    assert.notEqual(lightBg, darkBg, 'the background follows the system theme');
    const lum = (c: string) => { const [r, g, b] = c.match(/\d+/g)!.map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    assert.ok(contrast(lightBg, lightInk) >= 4.5, `light contrast ${contrast(lightBg, lightInk)}`);
    assert.ok(contrast(darkBg, darkInk) >= 4.5, `dark contrast ${contrast(darkBg, darkInk)}`);
  } finally { await ed.close(); }
});

test('a project file that cannot be read says so and is not saved over', { skip }, async () => {
  const ed = await openEditor({ version: 99, parts: [] });
  try {
    const { page } = ed;
    await page.waitFor(`/could not be read/.test(document.getElementById('problems').textContent)`, { what: 'the load error' });
    assert.equal(await page.eval(`document.getElementById('save').disabled`), true);
  } finally { await ed.close(); }
});

test('the page goes idle after loading: no loop keeps the main thread busy', { skip }, async () => {
  // A panel that re-placed itself on every attribute change once locked the page (and VS Code) solid.
  const ed = await openEditor(starter);
  try {
    const { page } = ed;
    await page.waitFor(`document.querySelectorAll('#canvas .part').length === 4`, { what: 'parts drawn' });
    const busy = await page.eval<number>(`new Promise((done) => {
      let frames = 0; const t0 = performance.now();
      const tick = () => { frames++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else done(frames); };
      requestAnimationFrame(tick);
    })`);
    assert.ok(busy >= 20, `only ${busy} frames in a second: the page is busy doing something`);
    // Toggling the side panels (attribute changes all over the page) must settle too.
    await page.eval(`document.getElementById('panels').click()`);
    await page.eval(`document.getElementById('panels').click()`);
    assert.equal(await page.eval(`1 + 1`), 2);
    assert.deepEqual(page.errors, []);
  } finally { await ed.close(); }
});
