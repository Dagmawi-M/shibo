// Loads the built extension against a stand-in for the VS Code API and checks
// the shell: command, panel, message relay, ticking, and clean-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProject } from '../src/templates.ts';
import { makeRig, theirs, type Rig } from './helpers/setup-rig.ts';

const require = createRequire(import.meta.url);
const built = new URL('../../extension/dist/extension.js', import.meta.url).pathname;

function harness(dir: string, opts: { toolchain?: object; settings?: Record<string, unknown> } = {}) {
  const commands: Record<string, (...args: any[]) => Promise<void>> = {};
  const posted: any[] = []; let receive: (m: any) => void = () => {}; let dispose: () => void = () => {};
  const panel = {
    visible: true, html: '', title: '', reveal() { panel.revealed++; }, revealed: 0,
    webview: { cspSource: 'vscode-resource:', html: '', asWebviewUri: (u: any) => ({ toString: () => 'vscode-resource:' + u.fsPath }),
      postMessage: async (m: any) => { posted.push(m); return true; }, onDidReceiveMessage: (cb: any) => { receive = cb; } },
    onDidDispose: (cb: any) => { dispose = cb; }, dispose() { dispose(); },
  };
  let created = 0; const warnings: string[] = []; const errors: string[] = []; const executed: any[][] = []; const views: string[] = [];
  const answers: { name?: string; template?: string; parent?: string; info?: string; pick?: (items: any[]) => any; error?: (text: string, choices: string[]) => string | undefined; warn?: string } = {}; const asked: string[] = [];
  const picks: any[][] = []; const errorChoices: string[][] = []; const progress: any[] = []; const cancels: (() => void)[] = []; const terminals: any[] = [];
  const statusBar: any = { show() { statusBar.shown = true; }, hide() { statusBar.shown = false; }, dispose() {} };
  const state = new Map<string, unknown>();
  const vscode = {
    Uri: { joinPath: (base: any, ...p: string[]) => ({ fsPath: path.join(base.fsPath, ...p) }), file: (f: string) => ({ fsPath: f }), parse: (u: string) => ({ url: u }) },
    ViewColumn: { Beside: 2, One: 1 },
    workspace: { workspaceFolders: [{ uri: { fsPath: dir } }], getConfiguration: () => ({ get: (k: string) => opts.settings?.[k] }) },
    ProgressLocation: { Notification: 15 },
    window: { createWebviewPanel: () => { created++; return panel; }, showOpenDialog: async () => (answers.parent ? [{ fsPath: answers.parent }] : undefined),
      showInputBox: async () => answers.name,
      showQuickPick: async (items: any[]) => { if (answers.pick) { picks.push(items); return answers.pick(items); } return items.find((i) => i.id === answers.template); },
      withProgress: async (_o: any, task: any) => task({ report: (r: any) => progress.push(r) }, { isCancellationRequested: false, onCancellationRequested: (cb: () => void) => { cancels.push(cb); return { dispose() {} }; } }),
      createTerminal: (o: any) => { const t = { name: o?.name, shown: false, sent: [] as any[], show() { t.shown = true; }, sendText(text: string, run?: boolean) { t.sent.push([text, run]); } }; terminals.push(t); return t; },
      showErrorMessage: async (text: string, ...choices: string[]) => { errors.push(text); errorChoices.push(choices); return answers.error?.(text, choices); }, showInformationMessage: async (text: string) => { asked.push(text); return answers.info; },
      registerTreeDataProvider: (id: string) => { views.push(id); return { dispose() {} }; },
      createStatusBarItem: () => statusBar,
      showWarningMessage: async (text: string, ...choices: any[]) => { warnings.push(text); return choices.includes('Save') ? 'Save' : choices.find((c) => c === answers.warn); } },
    commands: { registerCommand: (id: string, fn: any) => { commands[id] = fn; return { dispose() {} }; }, executeCommand: async (id: string, ...args: any[]) => { executed.push([id, ...args]); if (commands[id]) await (commands[id] as any)(...args); } },
    StatusBarAlignment: { Left: 1 }, env: { openExternal: async () => true },
  };
  const load = (Module as any)._load;
  (Module as any)._load = (req: string, ...rest: any[]) => (req === 'vscode' ? vscode : load(req, ...rest));
  delete require.cache[built];
  const ext = require(built);
  (Module as any)._load = load;
  const storage = mkdtempSync(path.join(tmpdir(), 'shibo-x-'));
  const context = { subscriptions: [], extensionUri: { fsPath: path.dirname(path.dirname(built)) }, globalStorageUri: { fsPath: storage }, globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } } };
  if (opts.toolchain) ext.testing.toolchain = opts.toolchain;
  ext.activate(context);
  const wait = async (pred: () => boolean, what: string, ms = 60000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timed out: ' + what + '; got ' + posted.map((m) => m.t).join(',')); await new Promise((r) => setTimeout(r, 50)); } };
  return { picks, errorChoices, progress, cancels, terminals, storage, asked, commands, posted, panel, send: (m: any) => receive(m), wait, created: () => created, ext, warnings, errors, executed, views, answers, statusBar, state, context, activateAgain: () => ext.activate(context) };
}

test('the extension opens a panel, relays messages, runs, and cleans up', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shibo-xp-'));
  cpSync(new URL('./fixtures/src/toggle/toggle.ino', import.meta.url).pathname, path.join(dir, 'sketch.ino'));
  writeFileSync(path.join(dir, 'diagram.json'), JSON.stringify({ version: 1, parts: [{ type: 'wokwi-arduino-uno', id: 'uno', top: 0, left: 0 }], connections: [] }));
  const h = harness(dir);
  assert.ok(h.commands['shibo.open'], 'command is registered');
  await h.commands['shibo.open']();
  assert.equal(h.created(), 1);
  assert.match(h.panel.webview.html, /Content-Security-Policy/);
  assert.match(h.panel.webview.html, /script nonce="[0-9a-f]{32}" src="vscode-resource:.*dist\/app\/app\.js"/);
  assert.doesNotMatch(h.panel.webview.html, /unsafe-eval/);

  h.send({ t: 'hello' });
  await h.wait(() => h.posted.some((m) => m.t === 'project'), 'project after hello');
  assert.equal(h.posted.find((m) => m.t === 'project').project.parts.length, 1);

  const before = h.posted.filter((m) => m.t === 'project').length;
  h.send({ t: 'open', dir: '/etc' });
  h.send({ t: 'edit', op: 'addPart', args: ['led', 10, 10] });
  await h.wait(() => h.posted.filter((m) => m.t === 'project').length > before, 'project after edit');
  const p = h.posted.filter((m) => m.t === 'project').at(-1);
  assert.equal(p.dir, dir, 'the page cannot point the session at another folder');
  assert.equal(p.project.parts.length, 2);

  await h.commands['shibo.open']();
  assert.equal(h.created(), 1, 'opening the same folder again reuses the panel');
  assert.equal(h.panel.revealed, 1);

  h.send({ t: 'start' });
  await h.wait(() => h.posted.some((m) => m.t === 'serial' && /Ready/.test(m.text)), 'serial from the running sketch');

  assert.match((h.panel as any).title, /●/, 'the tab shows there are unsaved changes');
  h.panel.dispose();
  await h.wait(() => existsSync(path.join(dir, 'shibo.json')), 'unsaved changes offered and saved on close', 5000);
  assert.equal(h.warnings.length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'shibo.json'), 'utf8')).parts.length, 2);
  const n = h.posted.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.posted.length, n, 'nothing is sent after the panel closes');
});

test('New Project creates the folder from a template and opens it, then the simulator opens there', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'shibo-np-'));
  const h = harness(parent);
  assert.ok(h.views.includes('shibo.home'), 'the sidebar view is registered');
  assert.equal(h.statusBar.command, 'shibo.open');
  h.answers.name = 'Night Light'; h.answers.template = 'light'; h.answers.parent = parent;
  await h.commands['shibo.newProject']();
  const dir = path.join(parent, 'night-light');
  assert.ok(existsSync(path.join(dir, 'night-light.ino')) && existsSync(path.join(dir, 'shibo.json')));
  assert.deepEqual(h.executed.at(-1)!.slice(0, 1), ['vscode.openFolder']);
  assert.equal(h.executed.at(-1)![1].fsPath, dir);
  assert.equal(h.state.get('shibo.openAfterReload'), dir, 'remembered so the simulator opens after the window reloads');

  h.answers.name = 'Night Light';
  await h.commands['shibo.newProject']();
  assert.match(h.errors.at(-1)!, /already exists/);

  h.answers.name = undefined;
  const n = h.executed.length;
  await h.commands['shibo.newProject']();
  assert.equal(h.executed.length, n, 'cancelling the name prompt does nothing');
});

test('Open on a folder full of other things offers a new project inside it instead of writing there', async () => {
  const before = process.env.HOME; const home = mkdtempSync(path.join(tmpdir(), 'shibo-xh-'));
  process.env.HOME = home;
  try {
    // A folder of other work, on no list.
    const code = path.join(home, 'code'); mkdirSync(path.join(code, 'repo-a'), { recursive: true });
    let h = harness(code);
    await h.commands['shibo.open']();
    assert.equal(h.created(), 0, 'no simulator is opened on the shared folder');
    assert.match(h.asked[0], /folder of its own.*code/);
    assert.deepEqual(h.executed, [], 'saying no does nothing');

    // Saying yes runs New Project inside that folder, with no question about where.
    h = harness(code); h.answers.info = 'New Project'; h.answers.name = 'Blink One'; h.answers.template = 'blink';
    await h.commands['shibo.open']();
    const made = path.join(code, 'blink-one');
    assert.ok(existsSync(path.join(made, 'blink-one.ino')) && existsSync(path.join(made, 'shibo.json')));
    assert.equal(h.executed.at(-1)![0], 'vscode.openFolder'); assert.equal(h.executed.at(-1)![1].fsPath, made);
    assert.deepEqual(readdirSync(code).sort(), ['blink-one', 'repo-a']);

    // The home folder itself is asked about too...
    h = harness(home); await h.commands['shibo.open']();
    assert.equal(h.created(), 0); assert.equal(h.asked.length, 1);

    // ...unless a sketch or a circuit is already there: then it opens as it always did.
    writeFileSync(path.join(home, 'old.ino'), 'void setup() {}\nvoid loop() {}\n');
    h = harness(home); await h.commands['shibo.open']();
    assert.equal(h.created(), 1, 'a folder with a sketch in it opens'); assert.deepEqual(h.asked, []);
    h.panel.dispose();

    // An empty folder opens straight away.
    const empty = path.join(home, 'empty'); mkdirSync(empty);
    h = harness(empty); await h.commands['shibo.open']();
    assert.equal(h.created(), 1); assert.deepEqual(h.asked, []);
    h.panel.dispose();
  } finally { process.env.HOME = before; }
});

// ---------- guided setup ----------
const posix = process.platform !== 'win32';
/** The extension's toolchain, able to see only what the test put there. */
const isolated = (rig: Rig, pathDirs = '') => ({ setup: rig.setup, where: { env: { PATH: pathDirs }, home: path.join(rig.dir, 'no-home'), platform: 'linux' } });
const labels = (items: any[]) => items.map((i) => i.label.replace(/^\$\([a-z-]+\) /, ''));

test('a run with no compiler offers the download in VS Code too, and the sketch runs once it is in', { skip: !posix }, async () => {
  const rig = await makeRig();
  try {
    const h = harness(createProject(rig.dir, 'blink', 'blink'), { toolchain: isolated(rig) });
    await h.wait(() => h.executed.some((e) => e[0] === 'setContext' && e[1] === 'shibo.compilerReady' && e[2] === false), 'the tour to be told there is no compiler yet');
    await h.commands['shibo.open']();
    h.answers.error = (_text, choices) => choices[0];                          // press the first button: the fix
    h.send({ t: 'start' });
    await h.wait(() => h.posted.some((m) => m.t === 'status' && m.state === 'running'), 'the sketch to run after setup', 15000);
    assert.match(h.errors[0], /Shibo needs the Arduino compiler/);
    assert.deepEqual(h.errorChoices[0], ['Download the Arduino compiler (about 80 MB, one time)', 'Install it myself']);
    assert.ok(existsSync(path.join(h.storage, 'compiler', 'ready')), 'the compiler went into the extension\'s own storage');
    assert.ok(h.progress.some((r) => /Downloading the Arduino compiler/.test(r.message)), 'VS Code showed the progress');
    assert.equal(h.cancels.length, 1, 'with a Cancel');
    assert.ok(h.posted.some((m) => m.t === 'setup' && m.state === 'done'), 'the page was told too');
    await h.wait(() => h.executed.some((e) => e[0] === 'setContext' && e[1] === 'shibo.compilerReady' && e[2] === true), 'the tour step to be marked done');
    h.panel.dispose();

    // Setup that fails is not a dead end: the reason is shown with "Install it myself".
    const rig3 = await makeRig();
    try {
      process.env.FAKE_MODE = 'core-fails';
      const f = harness(createProject(rig3.dir, 'blink', 'blink'), { toolchain: isolated(rig3) });
      await f.commands['shibo.open']();
      f.answers.error = (text, choices) => (/did not finish/.test(text) ? 'Install it myself' : choices[0]);
      f.send({ t: 'start' });
      await f.wait(() => f.errors.some((e) => /Setup did not finish.*something broke/.test(e)), 'the failure to be shown in VS Code');
      assert.deepEqual(f.errorChoices[f.errors.findIndex((e) => /did not finish/.test(e))], ['Install it myself']);
      await f.wait(() => f.executed.some((e) => e[0] === 'shibo.getArduinoCli'), 'the instructions to open');
      f.panel.dispose();
    } finally { delete process.env.FAKE_MODE; await rig3.close(); }

    // "Install it myself" opens the instructions and installs nothing.
    const rig2 = await makeRig();
    try {
      const g = harness(createProject(rig2.dir, 'blink', 'blink'), { toolchain: isolated(rig2) });
      await g.commands['shibo.open']();
      g.answers.error = () => 'Install it myself';
      g.send({ t: 'start' });
      await g.wait(() => g.executed.some((e) => e[0] === 'shibo.getArduinoCli'), 'the instructions to open');
      assert.equal(existsSync(path.join(g.storage, 'compiler')), false);
      g.panel.dispose();
    } finally { await rig2.close(); }
  } finally { await rig.close(); }
});

test('a fix the person runs themselves can be put in a terminal, not run', { skip: !posix }, async () => {
  const rig = await makeRig();
  try {
    const mine = theirs(rig); mine.installed(); process.env.FAKE_MODE = 'rosetta';
    const h = harness(createProject(rig.dir, 'blink', 'blink'), { toolchain: isolated(rig, mine.bin) });
    await h.commands['shibo.open']();
    h.answers.error = (_text, choices) => choices[0];
    h.send({ t: 'start' });
    await h.wait(() => h.terminals.length === 1, 'a terminal with the command');
    assert.deepEqual(h.errorChoices[0], ['Put the command in a terminal']);
    assert.deepEqual(h.terminals[0].sent, [['softwareupdate --install-rosetta --agree-to-license', false]]);
    assert.equal(h.terminals[0].shown, true);
    h.panel.dispose();
  } finally { await rig.close(); }
});

test('Check Setup lists what is there and what is not, installs at a pick, and can remove the download', { skip: !posix }, async () => {
  const rig = await makeRig();
  try {
    const h = harness(rig.dir, { toolchain: isolated(rig) });
    let turn = 0;
    h.answers.pick = (items) => (++turn === 1 ? items[0] : turn === 3 ? items.find((i) => /Remove/.test(i.label)) : undefined);
    await h.commands['shibo.checkSetup']();                                    // 1: pick the compiler; 2: just look
    assert.deepEqual(labels(h.picks[0]), ['Arduino compiler: not found', 'Arduino board package: comes with the compiler', 'ATtiny85 board package (optional): not installed', h.picks[0][3].label.replace(/^\$\([a-z-]+\) /, '')]);
    assert.match(h.picks[0][3].label, /Circuit checker, ngspice \(optional\)/);
    assert.match(h.picks[0][0].detail, /about 80 MB, one time/);
    assert.ok(h.progress.some((r) => /board package/.test(r.message)), 'the download ran with VS Code\'s progress');
    assert.equal(labels(h.picks[1])[0], 'Arduino compiler: downloaded by Shibo');
    assert.match(h.picks[1][0].description, /MB|KB|bytes/); assert.match(h.picks[1][0].detail, /compiler/);
    assert.equal(labels(h.picks[1])[1], 'Arduino board package: installed');
    assert.ok(labels(h.picks[1]).includes('Remove the downloaded compiler'));
    assert.ok(!labels(h.picks[0]).includes('Remove the downloaded compiler'));

    h.answers.warn = 'Remove';
    await h.commands['shibo.checkSetup']();                                    // 3: pick Remove; 4: just look
    assert.match(h.warnings.at(-1)!, /Remove the compiler Shibo downloaded/);
    assert.equal(existsSync(path.join(h.storage, 'compiler')), false);
    assert.equal(labels(h.picks[3])[0], 'Arduino compiler: not found');

    // Removing by its own command asks first, and "no" keeps it.
    turn = 0; await h.commands['shibo.checkSetup']();
    h.answers.warn = undefined;
    await h.commands['shibo.removeCompiler']();
    assert.ok(existsSync(path.join(h.storage, 'compiler', 'ready')), 'kept when the question is not answered with Remove');
  } finally { await rig.close(); }
});

test('Check Setup says when the chosen compiler path is wrong, and offers the ATtiny85 command for a found compiler', { skip: !posix }, async () => {
  const rig = await makeRig();
  try {
    const mine = theirs(rig); mine.installed();
    const h = harness(rig.dir, { toolchain: isolated(rig, mine.bin), settings: { arduinoCli: path.join(rig.dir, 'not-here') } });
    h.answers.pick = (items) => (h.picks.length === 1 ? items[2] : undefined);
    await h.commands['shibo.checkSetup']();
    assert.equal(labels(h.picks[0])[0], 'Arduino compiler: found on this computer');
    assert.match(h.picks[0][0].detail, /shibo\.arduinoCli setting.*not-here.*not there/);
    assert.equal(labels(h.picks[0])[1], 'Arduino board package: installed');
    assert.equal(h.terminals.length, 1);
    assert.match(h.terminals[0].sent[0][0], /core install ATTinyCore:avr --additional-urls https:/); assert.equal(h.terminals[0].sent[0][1], false);
  } finally { await rig.close(); }
});

test('the listing declares the setup commands, the machine-only setting, the tour step and untrusted folders', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../extension/package.json', import.meta.url), 'utf8'));
  const c = pkg.contributes;
  const titles = Object.fromEntries(c.commands.map((x: any) => [x.command, x.title]));
  assert.equal(titles['shibo.checkSetup'], 'Check Setup'); assert.equal(titles['shibo.removeCompiler'], 'Remove Downloaded Compiler');
  const setting = c.configuration.properties['shibo.arduinoCli'];
  assert.deepEqual([setting.type, setting.default, setting.scope], ['string', '', 'machine']);
  assert.deepEqual(pkg.capabilities.untrustedWorkspaces, { supported: true });
  const steps = c.walkthroughs[0].steps.map((s: any) => s.id);
  assert.deepEqual(steps, ['new', 'compiler', 'run', 'build']);
  const step = c.walkthroughs[0].steps[1];
  assert.equal(step.title, 'Get the compiler'); assert.match(step.description, /command:shibo\.checkSetup/);
  assert.deepEqual(step.completionEvents, ['onContext:shibo.compilerReady']);
  assert.ok(existsSync(new URL('../../extension/' + step.media.markdown, import.meta.url)));
  assert.match(c.viewsWelcome[0].contents, /\[Check your setup\]\(command:shibo\.checkSetup\)/);
});
