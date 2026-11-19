// Loads the built extension against a stand-in for the VS Code API and checks
// the shell: command, panel, message relay, ticking, and clean-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtempSync, writeFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const built = new URL('../../extension/dist/extension.js', import.meta.url).pathname;

function harness(dir: string) {
  const commands: Record<string, () => Promise<void>> = {};
  const posted: any[] = []; let receive: (m: any) => void = () => {}; let dispose: () => void = () => {};
  const panel = {
    visible: true, html: '', title: '', reveal() { panel.revealed++; }, revealed: 0,
    webview: { cspSource: 'vscode-resource:', html: '', asWebviewUri: (u: any) => ({ toString: () => 'vscode-resource:' + u.fsPath }),
      postMessage: async (m: any) => { posted.push(m); return true; }, onDidReceiveMessage: (cb: any) => { receive = cb; } },
    onDidDispose: (cb: any) => { dispose = cb; }, dispose() { dispose(); },
  };
  let created = 0; const warnings: string[] = []; const errors: string[] = []; const executed: any[][] = []; const views: string[] = [];
  const answers: { name?: string; template?: string; parent?: string } = {};
  const statusBar: any = { show() { statusBar.shown = true; }, hide() { statusBar.shown = false; }, dispose() {} };
  const state = new Map<string, unknown>();
  const vscode = {
    Uri: { joinPath: (base: any, ...p: string[]) => ({ fsPath: path.join(base.fsPath, ...p) }), file: (f: string) => ({ fsPath: f }), parse: (u: string) => ({ url: u }) },
    ViewColumn: { Beside: 2, One: 1 },
    workspace: { workspaceFolders: [{ uri: { fsPath: dir } }] },
    window: { createWebviewPanel: () => { created++; return panel; }, showOpenDialog: async () => (answers.parent ? [{ fsPath: answers.parent }] : undefined),
      showInputBox: async () => answers.name, showQuickPick: async (items: any[]) => items.find((i) => i.id === answers.template),
      showErrorMessage: async (text: string) => { errors.push(text); }, showInformationMessage: async () => undefined,
      registerTreeDataProvider: (id: string) => { views.push(id); return { dispose() {} }; },
      createStatusBarItem: () => statusBar,
      showWarningMessage: async (text: string, ...choices: string[]) => { warnings.push(text); return choices.includes('Save') ? 'Save' : undefined; } },
    commands: { registerCommand: (id: string, fn: any) => { commands[id] = fn; return { dispose() {} }; }, executeCommand: async (id: string, ...args: any[]) => { executed.push([id, ...args]); } },
    StatusBarAlignment: { Left: 1 }, env: { openExternal: async () => true },
  };
  const load = (Module as any)._load;
  (Module as any)._load = (req: string, ...rest: any[]) => (req === 'vscode' ? vscode : load(req, ...rest));
  delete require.cache[built];
  const ext = require(built);
  (Module as any)._load = load;
  const storage = mkdtempSync(path.join(tmpdir(), 'shibo-x-'));
  const context = { subscriptions: [], extensionUri: { fsPath: path.dirname(path.dirname(built)) }, globalStorageUri: { fsPath: storage }, globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } } };
  ext.activate(context);
  const wait = async (pred: () => boolean, what: string, ms = 60000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timed out: ' + what + '; got ' + posted.map((m) => m.t).join(',')); await new Promise((r) => setTimeout(r, 50)); } };
  return { commands, posted, panel, send: (m: any) => receive(m), wait, created: () => created, ext, warnings, errors, executed, views, answers, statusBar, state, context, activateAgain: () => ext.activate(context) };
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
