import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogInfo, infoFor, pinMeaning, searchCatalog, type SearchEntry } from '../src/catalog-info.ts';
import { catalog } from '../src/edit.ts';
import { boardPins, pinsOf } from '../src/project.ts';

const entries: SearchEntry[] = catalog.map((c) => ({ type: c.type, label: c.label, group: c.group }));
const top = (q: string, n = 3) => searchCatalog(entries, q).slice(0, n).map((e) => e.type);

test('every part in the catalog has a written description, tags and specs', () => {
  for (const c of catalog) {
    const i = catalogInfo[c.type];
    assert.ok(i, `${c.type} has no catalog info`);
    assert.ok(i.summary.length > 10 && i.summary.length <= 90, `${c.type}: summary should be one short line`);
    assert.ok(!/https?:|www\./.test(JSON.stringify(i)), `${c.type}: no links`);
    assert.ok(i.tags.length >= 2, `${c.type}: needs tags`);
    assert.ok(i.specs.length >= 2, `${c.type}: needs spec lines`);
  }
});

test('catalog info only names real parts and real pins', () => {
  for (const [type, i] of Object.entries(catalogInfo)) {
    const pins = pinsOf(type);
    if (!pins) continue;                                // info written ahead for a part another branch adds
    for (const p of Object.keys(i.pins ?? {})) assert.ok(pins.includes(p), `${type}: no pin ${p}`);
    for (const w of i.wiring ?? []) {
      assert.ok(pins.includes(w.pin), `${type}: wiring names pin ${w.pin}, which the part does not have`);
      assert.ok(boardPins.uno.includes(w.to) || /^[a-z][\w-]*:/.test(w.to), `${type}: wiring goes to ${w.to}, not an Uno pin`);
    }
  }
});

test('a part with no written info still gets a usable one', () => {
  const i = infoFor({ type: 'flux-capacitor', label: 'Flux capacitor', group: 'Time travel' });
  assert.ok(i.summary.length > 0);
  assert.ok(i.tags.includes('flux'));
  assert.deepEqual(infoFor({ type: 'led', label: 'LED', group: 'Lights and sound' }), catalogInfo.led);
});

test('pins are explained, with common names understood for any part', () => {
  assert.match(pinMeaning('led', 'A'), /anode|\+/i);
  assert.match(pinMeaning('whatever', 'GND'), /ground/i);
  assert.match(pinMeaning('whatever', 'SDA'), /I2C/);
  assert.match(pinMeaning('whatever', 'VCC'), /power|supply/i);
  assert.equal(pinMeaning('whatever', 'XYZ'), '');
});

test('search finds parts by name, tag and synonym', () => {
  assert.equal(top('servo')[0], 'servo');
  assert.equal(top('pot')[0], 'potentiometer');
  assert.ok(top('distance').includes('hc-sr04'));
  assert.ok(top('sonar').includes('hc-sr04'));
  assert.ok(top('temp', 5).includes('dht22') && top('temp', 5).includes('ntc-temperature-sensor'));
  assert.ok(top('screen', 5).includes('lcd1602') && top('screen', 5).includes('ssd1306'));
  assert.ok(top('knob', 5).includes('potentiometer'));
  assert.ok(top('motor', 5).includes('servo'));
  assert.ok(top('ws2812', 5).includes('neopixel'));
  assert.ok(top('i2c', 10).includes('mpu6050'));
  assert.equal(top('rgb')[0], 'rgb-led');
});

test('search needs every word to match, and forgives a small typo', () => {
  assert.equal(top('sound small')[0], 'small-sound-sensor');
  assert.deepEqual(searchCatalog(entries, 'zzzzqqq'), []);
  assert.equal(top('potentiomter')[0], 'potentiometer');
  assert.equal(top('ultrasonik')[0], 'hc-sr04');
  assert.equal(searchCatalog(entries, '  ').length, entries.length);
});

test('search stays fast with many parts', () => {
  const many: SearchEntry[] = Array.from({ length: 2000 }, (_, i) => ({ ...entries[i % entries.length], type: `${entries[i % entries.length].type}-${i}` }));
  searchCatalog(many, 'warm'); // builds the cached index once, as the palette does on open
  const qs = ['t', 'te', 'tem', 'temp', 'tempe', 'temper', 'motor', 'sensor light', 'xyz'];
  const t = performance.now();
  for (const q of qs) searchCatalog(many, q);
  const per = (performance.now() - t) / qs.length;
  assert.ok(per < 50, `took ${Math.round(per)} ms per keystroke`);
});
