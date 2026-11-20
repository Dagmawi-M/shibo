import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { encodeShare, decodeShare, shareUrl, shareFromLink, embedSnippet, ShareError, MAX_SHARE_BYTES } from '../src/share.ts';
import { parseProject } from '../src/project.ts';

const examples = path.resolve(import.meta.dirname, '..', '..', 'examples');
const load = (name: string) => ({
  project: JSON.parse(fs.readFileSync(path.join(examples, name, 'shibo.json'), 'utf8')),
  sketch: fs.readFileSync(path.join(examples, name, 'sketch.ino'), 'utf8'),
});
const names = fs.readdirSync(examples).filter((n) => fs.existsSync(path.join(examples, n, 'shibo.json')));

test('every example survives a round trip exactly: parts, wires, attrs, board and sketch', async () => {
  for (const n of names) {
    const s = load(n);
    const back = await decodeShare(await encodeShare(s));
    assert.deepEqual(back, s, n);
    assert.deepEqual(parseProject(back.project, 'link'), parseProject(s.project, 'file'), n);
  }
});

test('the largest example makes a link short enough to paste and send', async () => {
  const size = (n: string) => fs.statSync(path.join(examples, n, 'shibo.json')).size + fs.statSync(path.join(examples, n, 'sketch.ino')).size;
  const biggest = names.sort((a, b) => size(b) - size(a))[0];
  const url = await shareUrl('http://127.0.0.1:8190/', load(biggest));
  assert.ok(url.length < 4000, `${biggest} makes a ${url.length}-character link`);
  assert.ok(url.length < size(biggest), 'compression made it smaller than the files');
});

test('a link without a sketch round-trips with sketch null', async () => {
  const back = await decodeShare(await encodeShare({ project: { version: 1, parts: [], wires: [], boards: [] }, sketch: null }));
  assert.equal(back.sketch, null);
});

test('links carry a version and only base64url characters', async () => {
  const t = await encodeShare(load(names[0]));
  assert.match(t, /^v1\.[A-Za-z0-9_-]+$/);
});

test('bad, cut and future links fail with a reason, never anything else', async () => {
  const good = await encodeShare(load(names[0]));
  const cases: [string, RegExp][] = [
    ['', /not a Shibo share link/],
    ['hello', /not a Shibo share link/],
    ['v2.abcd', /newer Shibo.*v2/],
    ['v1.', /empty/],
    ['v1.@@@', /characters/],
    [good.slice(0, Math.floor(good.length / 2)), /damaged or cut short/],
    ['v1.' + Buffer.from('not deflate at all').toString('base64url'), /damaged/],
  ];
  for (const [text, why] of cases) await assert.rejects(decodeShare(text), (e: unknown) => e instanceof ShareError && why.test((e as Error).message), text);
});

test('a link that is not a project, or whose sketch is wrong, is refused', async () => {
  const pack = async (obj: unknown) => {
    // Encode arbitrary JSON the same way a link is made.
    const bytes = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return 'v1.' + Buffer.from(await new Response(bytes).arrayBuffer()).toString('base64url');
  };
  await assert.rejects(decodeShare(await pack([1, 2])), /no project/);
  await assert.rejects(decodeShare(await pack({ project: { version: 1 }, sketch: 5 })), /not text/);
});

test('a tiny link that inflates to something huge is stopped', async () => {
  const bomb = new Blob([' '.repeat(MAX_SHARE_BYTES * 2)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const text = 'v1.' + Buffer.from(await new Response(bomb).arrayBuffer()).toString('base64url');
  assert.ok(text.length < 10000);
  await assert.rejects(decodeShare(text), /more than a project/);
});

test('share text is found in a full link, a fragment, or bare', async () => {
  const url = await shareUrl('http://127.0.0.1:8190/?x=1#old', load(names[0]));
  assert.match(url, /^http:\/\/127\.0\.0\.1:8190\/\?x=1#p=v1\./);
  const t = shareFromLink(url)!;
  assert.equal(shareFromLink('#p=' + t), t);
  assert.equal(shareFromLink(t), t);
  assert.equal(shareFromLink('http://example.com/'), null);
  const embed = await shareUrl('http://127.0.0.1:8190/', load(names[0]), { embed: true });
  assert.match(embed, /\?embed=1#p=v1\./);
  assert.match(embedSnippet(embed), /^<iframe src="http:\/\/127\.0\.0\.1:8190\/\?embed=1#p=v1\.[^"]+"/);
});

// ---------- the session side: what opening a link does to the folder ----------
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Session, type OutMsg } from '../src/session.ts';

function opened(files: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-share-'));
  for (const [f, t] of Object.entries(files)) writeFileSync(path.join(dir, f), t);
  const s = new Session({ build: async () => ({ ok: false, log: 'no' }) }); const out: OutMsg[] = [];
  s.onMessage((m) => out.push(m));
  const last = <T extends OutMsg['t']>(t: T) => out.filter((m) => m.t === t).at(-1) as Extract<OutMsg, { t: T }> | undefined;
  return { s, dir, out, last };
}
const mine = { version: 1, parts: [{ id: 'nano', type: 'nano', x: 0, y: 0 }], wires: [], boards: [{ part: 'nano', firmware: '' }] };

test('shareInfo gives the project and the sketch text', async () => {
  const { s, dir, last } = opened({ 'shibo.json': JSON.stringify(mine), 'a.ino': 'void setup(){}' });
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'shareInfo' });
  assert.equal(last('shareInfo')!.sketch, 'void setup(){}');
  assert.equal(last('shareInfo')!.project.parts[0].id, 'nano');
});

test('opening a link replaces the circuit as an undoable edit and keeps the old sketch in a backup', async () => {
  const { s, dir, last } = opened({ 'shibo.json': JSON.stringify(mine), 'a.ino': 'old sketch' });
  await s.handle({ t: 'open', dir });
  const shared = load(names[0]);
  await s.handle({ t: 'openShared', project: shared.project, sketch: shared.sketch });
  assert.equal(last('shared')!.ok, true);
  assert.deepEqual(last('project')!.project, parseProject(shared.project, 'x'));
  assert.equal(last('project')!.dirty, true);
  assert.equal(readFileSync(path.join(dir, 'a.ino'), 'utf8'), shared.sketch);
  const kept = readdirSync(path.join(dir, '.shibo-backup'));
  assert.equal(readFileSync(path.join(dir, '.shibo-backup', kept[0]), 'utf8'), 'old sketch');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'shibo.json'), 'utf8')), mine, 'nothing saved over shibo.json');
  await s.handle({ t: 'undo' });
  assert.equal(last('project')!.project.parts[0].id, 'nano');
});

test('a folder with no sketch gets the shared one', async () => {
  const { s, dir } = opened();
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'openShared', project: mine, sketch: 'void loop(){}' });
  assert.equal(readFileSync(path.join(dir, `${path.basename(dir)}.ino`), 'utf8'), 'void loop(){}');
});

test('a bad project in a link is refused and the current work is untouched', async () => {
  const { s, dir, last } = opened({ 'shibo.json': JSON.stringify(mine) });
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'openShared', project: { version: 9 }, sketch: null });
  assert.equal(last('shared')!.ok, false);
  assert.match(last('shared')!.message, /version/);
  assert.equal(last('project')!.project.parts[0].id, 'nano');
});

test('an embed never replaces unsaved work or a different sketch', async () => {
  const { s, dir, last } = opened({ 'shibo.json': JSON.stringify(mine), 'a.ino': 'mine' });
  await s.handle({ t: 'open', dir });
  await s.handle({ t: 'openShared', project: mine, sketch: 'theirs', embed: true });
  assert.equal(last('shared')!.ok, false);
  assert.equal(readFileSync(path.join(dir, 'a.ino'), 'utf8'), 'mine');
  await s.handle({ t: 'openShared', project: mine, sketch: 'mine', embed: true });
  assert.equal(last('shared')!.ok, true);
});
