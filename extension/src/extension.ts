// The VS Code shell: one panel per folder, each with its own Session. The
// panel shows the same page as the standalone app; messages go over the
// webview channel instead of HTTP.
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { Session, type InMsg } from '../../engine/src/session.ts';
import { Toolchain } from '../../engine/src/toolchain.ts';
import type { Where } from '../../engine/src/compiler.ts';
import type { SetupOptions } from '../../engine/src/setup.ts';
import { checkSetup, inTerminal, progressNote, removeDownloaded, tellReady } from './setup-ui.ts';
import { createProject, folderName, folderKind, templates } from '../../engine/src/templates.ts';

const TICK_MS = 16;
const panels = new Map<string, vscode.WebviewPanel>();

const REOPEN = 'shibo.openAfterReload';

/** For tests only: stand-ins for this computer and for Arduino's download server. */
export const testing: { toolchain?: { where?: Where; setup?: SetupOptions } } = {};

export function activate(context: vscode.ExtensionContext): void {
  const here = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // One toolchain for every simulator panel: the compiler Shibo downloads lives in the extension's own storage.
  const chosen = () => vscode.workspace.getConfiguration('shibo').get<string>('arduinoCli') || undefined;
  const toolchain = new Toolchain({ ownDir: path.join(context.globalStorageUri.fsPath, 'compiler'), cacheDir: path.join(context.globalStorageUri.fsPath, 'build'), setting: chosen, ...testing.toolchain });
  void tellReady(toolchain);
  context.subscriptions.push(vscode.commands.registerCommand('shibo.checkSetup', () => checkSetup(toolchain, chosen)));
  context.subscriptions.push(vscode.commands.registerCommand('shibo.removeCompiler', () => removeDownloaded(toolchain)));

  context.subscriptions.push(vscode.commands.registerCommand('shibo.open', async () => {
    let dir = here();
    if (!dir || (vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Simulate this folder' });
      if (!picked?.[0]) return;
      dir = picked[0].fsPath;
    }
    // A folder that holds other things and no circuit or sketch yet: make the project inside it instead.
    if (folderKind(dir) === 'shared') {
      const go = await vscode.window.showInformationMessage(`Shibo keeps each circuit in a folder of its own, and ${path.basename(dir) || dir} holds other things. Make a new project inside it?`, { modal: true }, 'New Project');
      if (go) await vscode.commands.executeCommand('shibo.newProject', dir);
      return;
    }
    open(context, toolchain, dir);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('shibo.newProject', async (inside?: unknown) => {
    const name = await vscode.window.showInputBox({ title: 'New Shibo project', prompt: 'Project name', placeHolder: 'my-first-circuit',
      validateInput: (v) => { try { folderName(v); return undefined; } catch (err) { return (err as Error).message; } } });
    if (!name) return;
    const pick = await vscode.window.showQuickPick(templates.map((t) => ({ label: t.label, detail: t.detail, id: t.id })), { title: 'Start from', placeHolder: 'Pick a starting circuit' });
    if (!pick) return;
    const parent = typeof inside === 'string' ? inside : (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Create the project here',
      defaultUri: vscode.Uri.file(here() ? path.dirname(here()!) : os.homedir()) }))?.[0]?.fsPath;
    if (!parent) return;
    let dir: string;
    try { dir = createProject(parent, name, pick.id); }
    catch (err) { void vscode.window.showErrorMessage(`Shibo: ${(err as Error).message}`); return; }
    // Opening a folder reloads the window, so note that the simulator should open once it has.
    await context.globalState.update(REOPEN, dir);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('shibo.getArduinoCli', () =>
    vscode.env.openExternal(vscode.Uri.parse('https://arduino.github.io/arduino-cli/latest/installation/'))));

  // The sidebar: an empty list, so VS Code shows the welcome text and buttons declared in package.json.
  context.subscriptions.push(vscode.window.registerTreeDataProvider('shibo.home', { getChildren: () => [], getTreeItem: (x: vscode.TreeItem) => x }));

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  bar.text = '$(circuit-board) Shibo'; bar.tooltip = 'Open the Shibo simulator for this folder'; bar.command = 'shibo.open';
  if (here()) bar.show();
  context.subscriptions.push(bar);

  // A project just created by New Project: open its sketch and the simulator beside it.
  const reopen = context.globalState.get<string>(REOPEN);
  if (reopen && reopen === here()) {
    void context.globalState.update(REOPEN, undefined);
    const sketch = path.join(reopen, `${path.basename(reopen)}.ino`);
    void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sketch)).then(() => open(context, toolchain, reopen));
  }
}

function open(context: vscode.ExtensionContext, toolchain: Toolchain, dir: string): void {
  const existing = panels.get(dir);
  if (existing) { existing.reveal(); return; }

  const appRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'app');
  const panel = vscode.window.createWebviewPanel('shibo', `Shibo: ${path.basename(dir)}`, vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [appRoot], retainContextWhenHidden: true });
  panels.set(dir, panel);

  const session = new Session({ toolchain, watch: true });
  const title = panel.title;
  let dirty = false;
  let note: ReturnType<typeof progressNote> | null = null;
  session.onMessage((m) => {
    if (m.t === 'project' || m.t === 'dirty') { dirty = m.dirty; panel.title = dirty ? `${title} ●` : title; }
    // A sketch Shibo just wrote: show it beside the circuit so it can be edited straight away.
    if (m.t === 'guideCreated') void vscode.env.openExternal(vscode.Uri.file(m.path));
    if (m.t === 'sketchCreated') void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.path), vscode.ViewColumn.One);
    // A run that failed for want of something on the computer: say so where the sketch is being written, too.
    if (m.t === 'error' && m.fix) {
      const choices = m.fixKind === 'compiler' ? [m.fix, 'Install it myself'] : [m.fix];
      void vscode.window.showErrorMessage(m.message, ...choices).then((answer) => {
        if (answer === m.fix) void session.handle({ t: 'fix' });
        else if (answer) void vscode.commands.executeCommand('shibo.getArduinoCli');
      });
    } else if (m.t === 'error' && m.command) {
      const command = m.command;
      void vscode.window.showErrorMessage(m.message, 'Put the command in a terminal').then((answer) => { if (answer) inTerminal(command); });
    }
    // A fix under way shows VS Code's own progress as well as the page's, with Cancel in both.
    if (m.t === 'setup') {
      if (m.state === 'working') { note ??= progressNote('Shibo setup', () => void session.handle({ t: 'cancelFix' })); note.report(m); }
      else { note?.close(); note = null; void tellReady(toolchain); }
    }
    void panel.webview.postMessage(m);
  });
  panel.webview.onDidReceiveMessage((m: InMsg) => {
    if (!m || typeof m.t !== 'string' || m.t === 'open') return;     // the folder is chosen here, not by the page
    void session.handle(m);
  });

  // Simulated time only moves while the panel is on screen.
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    if (panel.visible) session.tick(now - last);
    last = now;
  }, TICK_MS);

  panel.onDidDispose(async () => {
    clearInterval(timer); panels.delete(dir); note?.close();
    // A closed panel cannot be reopened as it was, so offer to keep the work.
    if (dirty) {
      const answer = await vscode.window.showWarningMessage(`Shibo: the circuit in ${path.basename(dir)} has unsaved changes.`, 'Save', 'Discard');
      if (answer === 'Save') await session.handle({ t: 'save' });
    }
    session.dispose();
  });

  const nonce = randomBytes(16).toString('hex');
  const src = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(appRoot, f)).toString();
  const csp = [`default-src 'none'`, `img-src ${panel.webview.cspSource} data:`, `font-src ${panel.webview.cspSource} data:`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join('; ');
  panel.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shibo</title><link rel="stylesheet" href="${src('app.css')}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${src('app.js')}"></script></body></html>`;

  void session.handle({ t: 'open', dir });
}

export function deactivate(): void { for (const p of panels.values()) p.dispose(); }
