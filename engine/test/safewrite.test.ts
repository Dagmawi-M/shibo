// Nothing Shibo writes in a project folder may land somewhere else: a file in
// the folder that is really a link to another place is not written through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session, type OutMsg } from '../src/session.ts';
import { templates } from '../src/templates.ts';

const skip = process.platform === 'win32' ? 'links need special rights on Windows' : false;

test('a file in the folder that is a link to somewhere else is never written through', { skip }, async () => {
  const t = mkdtempSync(path.join(tmpdir(), 'shibo-link-'));
  const dir = path.join(t, 'project'), outside = path.join(t, 'outside'); mkdirSync(dir); mkdirSync(outside);
  writeFileSync(path.join(dir, 'project.ino'), 'void setup() {}\nvoid loop() {}\n');
  const precious: Record<string, string> = {};
  for (const name of ['shibo.json', 'wiring-guide.html', 'parts-list.csv', 'prices.json']) {
    precious[name] = path.join(outside, name + '.precious');
    writeFileSync(precious[name], name === 'shibo.json' ? JSON.stringify(templates[0].project) : name === 'prices.json' ? '{"prices":{}}' : 'precious');
    symlinkSync(precious[name], path.join(dir, name));
  }
  const before = Object.fromEntries(Object.entries(precious).map(([k, f]) => [k, readFileSync(f, 'utf8')]));
  const s = new Session(); const out: OutMsg[] = []; s.onMessage((m) => out.push(m));
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'edit', op: 'addPart', args: ['led', 10, 10] });
  await s.handle({ t: 'save' });
  await s.handle({ t: 'guide' });
  await s.handle({ t: 'exportBom', format: 'csv' });
  await s.handle({ t: 'setPrice', key: 'led:red', entry: { price: 1 } } as any);
  const errors = out.filter((m) => m.t === 'error').map((m: any) => m.message);
  assert.equal(errors.length, 4, JSON.stringify(errors));
  for (const e of errors) assert.match(e, /is a link to somewhere else/);
  for (const [k, f] of Object.entries(precious)) assert.equal(readFileSync(f, 'utf8'), before[k], `${k} was written through the link`);
  s.dispose();

  // An ordinary folder is written as always.
  const plain = path.join(t, 'plain'); mkdirSync(plain); writeFileSync(path.join(plain, 'plain.ino'), 'void setup() {}\nvoid loop() {}\n');
  const p = new Session(); const o2: OutMsg[] = []; p.onMessage((m) => o2.push(m));
  await p.handle({ t: 'open', dir: plain }); await p.handle({ t: 'edit', op: 'addPart', args: ['uno', 0, 0] });
  await p.handle({ t: 'save' }); await p.handle({ t: 'guide' });
  assert.deepEqual(o2.filter((m) => m.t === 'error'), []);
  assert.ok(existsSync(path.join(plain, 'shibo.json')) && existsSync(path.join(plain, 'wiring-guide.html')));
  p.dispose();
});
