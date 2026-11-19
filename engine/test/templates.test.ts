import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { templates, createProject } from '../src/templates.ts';
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
