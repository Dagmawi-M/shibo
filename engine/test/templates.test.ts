import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { templates, createProject, sharedFolder, folderKind } from '../src/templates.ts';
import { parseProject, validate } from '../src/project.ts';
import { Session, type OutMsg } from '../src/session.ts';
import { buildUno } from '../src/build.ts';

test('every template is a valid, fully wired project with a sketch', () => {
  assert.ok(templates.length >= 4);
  for (const t of templates) {
    assert.ok(t.id && t.label && t.detail, t.id);
    const p = parseProject(t.project, t.id);
    assert.deepEqual(validate(p), [], t.id);
    assert.equal(p.boards.length, 1, t.id);
    assert.match(t.sketch, /void setup\(\)/); assert.match(t.sketch, /void loop\(\)/);
  }
});

test('createProject writes a folder with the sketch and the circuit, and refuses to overwrite', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'shibo-t-'));
  const dir = createProject(parent, 'My First', 'blink');
  assert.equal(path.basename(dir), 'my-first');
  assert.deepEqual(readdirSync(dir).sort(), ['my-first.ino', 'shibo.json']);
  assert.equal(parseProject(JSON.parse(readFileSync(path.join(dir, 'shibo.json'), 'utf8')), 'x').parts.length, 3);
  assert.throws(() => createProject(parent, 'My First', 'blink'), /already/);
  for (const bad of ['', '   ', '../x', 'a/b', '.hidden']) assert.throws(() => createProject(parent, bad, 'blink'), /name/, bad);
  assert.throws(() => createProject(parent, 'ok', 'nope'), /template/);
  assert.equal(existsSync(path.join(parent, 'ok')), false);
});

test('the templates do what they say when run', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'shibo-t-'));
  const run = async (id: string) => {
    const s = new Session({ build: (d) => buildUno(d) }); const out: OutMsg[] = [];
    s.onMessage((m) => out.push(m));
    await s.handle({ t: 'open', dir: createProject(parent, id, id) });
    await s.handle({ t: 'start' });
    const errors = out.filter((m) => m.t === 'error').map((m: any) => m.message);
    assert.deepEqual(errors, [], id);
    const lit = () => out.filter((m) => m.t === 'outputs').map((m: any) => m.outputs.led1?.lit);
    return { s, out, lit, ticks: (n: number) => { for (let i = 0; i < n; i++) s.tick(50); }, problems: () => (out.filter((m) => m.t === 'problems').at(-1) as any).items };
  };
  const blink = await run('blink'); blink.ticks(50);
  assert.ok(blink.lit().includes(true) && blink.lit().includes(false), 'blink: the LED goes on and off');
  assert.deepEqual(blink.problems(), []); blink.s.dispose();

  const button = await run('button'); button.ticks(4);
  await button.s.handle({ t: 'control', part: 'pushbutton1', name: 'pressed', value: 1 }); button.ticks(3);
  assert.equal(button.lit().at(-1), true, 'button: pressing lights the LED'); button.s.dispose();

  const light = await run('light'); light.ticks(6);
  assert.equal(light.lit().at(-1), false, 'light: bright by default, LED off');
  await light.s.handle({ t: 'control', part: 'photoresistor-sensor1', name: 'lux', value: 1 }); light.ticks(8);
  assert.equal(light.lit().at(-1), true, 'light: dark turns the LED on');
  assert.deepEqual(light.problems(), []); light.s.dispose();

  const empty = await run('empty'); empty.ticks(4);
  assert.match(empty.out.filter((m) => m.t === 'serial').map((m: any) => m.text).join(''), /Hello from Shibo/); empty.s.dispose();
});

test('a sketch is never written straight into the home folder or another shared folder', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'shibo-home-'));
  for (const d of [home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), path.parse(home).root]) assert.equal(sharedFolder(d, home), true, d);
  for (const d of [path.join(home, 'blink'), path.join(home, 'Documents', 'blink'), path.dirname(home)]) assert.equal(sharedFolder(d, home), false, d);

  const open = async (dir: string) => {
    const s = new Session({ build: (d) => buildUno(d), home }); const out: OutMsg[] = [];
    s.onMessage((m) => out.push(m)); await s.handle({ t: 'open', dir });
    return { s, errors: () => out.filter((m) => m.t === 'error').map((m: any) => m.message) };
  };
  const inos = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.ino'));

  // In the home folder: starting from a template and making a sketch are both refused, and nothing is written.
  const a = await open(home);
  await a.s.handle({ t: 'template', id: 'blink' } as any);
  await a.s.handle({ t: 'createSketch' } as any);
  assert.equal(a.errors().length, 2); for (const e of a.errors()) assert.match(e, /folder of its own/);
  assert.deepEqual(inos(home), []); a.s.dispose();

  // In a folder of its own inside home: the same template works.
  const own = path.join(home, 'blink'); mkdirSync(own);
  const b = await open(own);
  await b.s.handle({ t: 'template', id: 'blink' } as any);
  assert.deepEqual(b.errors(), []); assert.deepEqual(inos(own), ['blink.ino']); b.s.dispose();

  // A sketch that is already in the home folder is still used, not refused.
  writeFileSync(path.join(home, 'old.ino'), 'void setup() {}\nvoid loop() {}\n');
  const c = await open(home);
  await c.s.handle({ t: 'template', id: 'blink' } as any);
  assert.deepEqual(c.errors(), []); assert.deepEqual(inos(home), ['old.ino']); c.s.dispose();
});

test('a new sketch or circuit only goes into a folder that is empty or already a project', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'shibo-home-'));
  const open = async (dir: string) => {
    const s = new Session({ build: (d) => buildUno(d), home }); const out: OutMsg[] = [];
    s.onMessage((m) => out.push(m)); await s.handle({ t: 'open', dir });
    return { s, errors: () => out.filter((m) => m.t === 'error').map((m: any) => m.message) };
  };

  // A folder full of other work that is on no list: nothing is written into it, by any route.
  const code = path.join(home, 'code'); mkdirSync(code);
  for (const n of ['repo-a', 'repo-b']) mkdirSync(path.join(code, n));
  writeFileSync(path.join(code, 'notes.txt'), 'x');
  assert.equal(folderKind(code, home), 'shared');
  const a = await open(code);
  await a.s.handle({ t: 'template', id: 'blink' } as any);
  await a.s.handle({ t: 'createSketch' } as any);
  await a.s.handle({ t: 'save' } as any);
  assert.equal(a.errors().length, 3); for (const e of a.errors()) assert.match(e, /folder of its own/);
  assert.deepEqual(readdirSync(code).sort(), ['notes.txt', 'repo-a', 'repo-b']); a.s.dispose();

  // An empty folder, or one with only hidden files and a README or licence (a fresh repository), is fine.
  const fresh = path.join(home, 'fresh'); mkdirSync(fresh); mkdirSync(path.join(fresh, '.git'));
  for (const n of ['README.md', 'LICENSE', '.gitignore']) writeFileSync(path.join(fresh, n), 'x');
  assert.equal(folderKind(fresh, home), 'empty');
  const b = await open(fresh);
  await b.s.handle({ t: 'template', id: 'blink' } as any);
  await b.s.handle({ t: 'save' } as any);
  assert.deepEqual(b.errors(), []); assert.ok(existsSync(path.join(fresh, 'fresh.ino')) && existsSync(path.join(fresh, 'shibo.json'))); b.s.dispose();

  // What Shibo wrote itself does not make a folder "full": it can be opened and saved again later.
  const used = path.join(home, 'used'); mkdirSync(used);
  for (const n of ['wiring-guide.html', 'prices.json', 'parts-list.csv', 'parts-list.md']) writeFileSync(path.join(used, n), 'x');
  assert.equal(folderKind(used, home), 'empty');

  // A folder that already holds a circuit or a sketch is a project, whatever else is in it.
  for (const f of ['shibo.json', 'diagram.json', 'old.ino']) {
    const d = mkdtempSync(path.join(home, 'p-')); mkdirSync(path.join(d, 'src')); writeFileSync(path.join(d, 'other.txt'), 'x'); writeFileSync(path.join(d, f), '{}');
    assert.equal(folderKind(d, home), 'project', f);
  }
  assert.equal(folderKind(home, home), 'shared');
  assert.equal(folderKind(path.join(home, 'not-made-yet'), home), 'empty');
});

test('the home folder is recognised through a link, under other names, and when it already holds a circuit', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'shibo-link-'));
  const home = path.join(base, 'var-home', 'u'); mkdirSync(home, { recursive: true });
  symlinkSync(path.join(base, 'var-home'), path.join(base, 'home'));
  assert.equal(sharedFolder(path.join(base, 'home', 'u'), home), true, 'home through a link');
  assert.equal(sharedFolder(home, path.join(base, 'home', 'u')), true, 'the home setting itself is the link');
  assert.equal(sharedFolder(path.join(base, 'home', 'u', 'Desktop'), home), true);

  // The desktop's real name and place come from the system's own list where there is one.
  mkdirSync(path.join(home, '.config'));
  writeFileSync(path.join(home, '.config', 'user-dirs.dirs'), '# comment\nXDG_DESKTOP_DIR="$HOME/Bureau"\nXDG_PICTURES_DIR="/mnt/pics"\nXDG_TEMPLATES_DIR="$HOME/"\n');
  for (const d of [path.join(home, 'Bureau'), '/mnt/pics', path.join(home, 'Pictures'), path.join(home, 'Music'), path.join(home, 'Videos')]) assert.equal(sharedFolder(d, home), true, d);
  assert.equal(sharedFolder(path.join(home, 'Bureau', 'blink'), home), false);
  const cloud = path.join(base, 'OneDrive');
  for (const d of [cloud, path.join(cloud, 'Desktop'), path.join(cloud, 'Documents')]) assert.equal(sharedFolder(d, home, { OneDrive: cloud }), true, d);
  assert.equal(sharedFolder(path.join(cloud, 'Desktop', 'blink'), home, { OneDrive: cloud }), false);

  // A circuit saved in the home folder by an older Shibo still opens and saves, but gets no new sketch there.
  writeFileSync(path.join(home, 'shibo.json'), JSON.stringify(templates[0].project));
  const s = new Session({ build: (d) => buildUno(d), home }); const out: OutMsg[] = [];
  s.onMessage((m) => out.push(m)); await s.handle({ t: 'open', dir: path.join(base, 'home', 'u') });
  await s.handle({ t: 'save' } as any);
  assert.deepEqual(out.filter((m) => m.t === 'error'), []);
  await s.handle({ t: 'createSketch' } as any);
  assert.match((out.find((m) => m.t === 'error') as any).message, /folder of its own/);
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith('.ino')), []); s.dispose();
});
