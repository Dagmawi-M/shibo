// The VS Code side of setup: the "Check Setup" list, the progress notification
// for a fix, and the terminal a command is put into for the person to run.
import * as vscode from 'vscode';
import type { Toolchain, SetupStatus } from '../../engine/src/toolchain.ts';
import { needCompiler, needCore, type Fix } from '../../engine/src/builderror.ts';
import type { Step } from '../../engine/src/setup.ts';

/** "312 MB", "840 KB": a size a person reads at a glance. */
export function size(bytes: number): string {
  return bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : bytes >= 1e3 ? `${Math.round(bytes / 1e3)} KB` : `${bytes} bytes`;
}

/** Put a command in a terminal for the person to read and run themselves. It is never run for them. */
export function inTerminal(command: string): void {
  const t = vscode.window.createTerminal({ name: 'Shibo setup' });
  t.show();
  t.sendText(command, false);
}

/** Tell the tour (and anything else that asks) whether a sketch can be compiled now. */
export async function tellReady(toolchain: Toolchain): Promise<SetupStatus> {
  const status = await toolchain.status();
  await vscode.commands.executeCommand('setContext', 'shibo.compilerReady', status.ready);
  return status;
}

/** VS Code's progress notification, fed with the steps of a fix. Returns how to report a step and how to close it. */
export function progressNote(title: string, onCancel: () => void): { report(s: Step): void; close(): void } {
  let report: (s: Step) => void = () => {}, close: () => void = () => {};
  void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
    token.onCancellationRequested(onCancel);
    let shown = 0;
    report = (s) => {
      const now = Math.round((s.fraction ?? 0) * 100);
      progress.report({ message: s.text, increment: s.fraction === undefined ? undefined : now - shown });
      if (s.fraction !== undefined) shown = now;
    };
    return new Promise<void>((done) => { close = done; });
  });
  return { report: (s) => report(s), close: () => close() };
}

/** Carry out a fix with the progress notification, outside any simulator panel. True when it worked. */
export async function runFix(toolchain: Toolchain, fix: Fix): Promise<boolean> {
  const stop = new AbortController();
  const note = progressNote('Shibo setup', () => stop.abort());
  try {
    await toolchain.repair(fix, (s) => note.report(s), stop.signal);
    return true;
  } catch (err) {
    if (!stop.signal.aborted) void vscode.window.showErrorMessage(`Shibo: ${(err as Error).message}`);
    return false;
  } finally { note.close(); await tellReady(toolchain); }
}

/** Ask first, then delete the compiler Shibo downloaded. */
export async function removeDownloaded(toolchain: Toolchain): Promise<void> {
  const status = await toolchain.status();
  if (status.compiler.ownBytes === undefined) { void vscode.window.showInformationMessage('Shibo has not downloaded a compiler, so there is nothing to remove.'); return; }
  const answer = await vscode.window.showWarningMessage(`Remove the compiler Shibo downloaded? This frees about ${size(status.compiler.ownBytes)}. Shibo will offer to download it again the next time a sketch needs it.`, { modal: true }, 'Remove');
  if (answer !== 'Remove') return;
  try { await toolchain.remove(); } catch (err) { void vscode.window.showErrorMessage(`Shibo: ${(err as Error).message}`); }
  await tellReady(toolchain);
}

interface Item extends vscode.QuickPickItem { act?: () => Promise<void> | void }

const ORIGIN = { setting: 'chosen in your settings', path: 'found on this computer', known: 'found on this computer', own: 'downloaded by Shibo' };

/** What is installed and what is not, as a list. Picking a missing item installs it; the list then comes back with the result. */
export async function checkSetup(toolchain: Toolchain, settingPath: () => string | undefined): Promise<void> {
  for (;;) {
    const st = await tellReady(toolchain);
    const c = st.compiler, items: Item[] = [];
    const wrong = c.settingMissing ? `The path in the shibo.arduinoCli setting (${settingPath() ?? ''}) is not there, so it was not used. ` : '';
    if (c.found) {
      items.push({ label: `$(check) Arduino compiler: ${ORIGIN[c.origin!]}`, description: c.ownBytes === undefined ? '' : size(c.ownBytes), detail: `${wrong}${c.path}` });
    } else {
      items.push({ label: '$(error) Arduino compiler: not found', detail: `${wrong}Pick this to download it (about 80 MB, one time). After that Shibo works offline.`, act: async () => { await runFix(toolchain, needCompiler().fix!); } });
    }
    const avr = !c.found ? { label: '$(circle-slash) Arduino board package: comes with the compiler', detail: 'It is installed together with the compiler.' }
      : st.avr === 'present' ? { label: '$(check) Arduino board package: installed', detail: 'Uno, Nano and Mega sketches can be compiled.' }
      : st.avr === 'absent' ? { label: '$(error) Arduino board package: not installed', detail: 'Pick this to install it (about 70 MB).', act: async () => { await runFix(toolchain, { kind: 'core', pkg: 'arduino:avr' }); } }
      : { label: '$(question) Arduino board package: could not be checked', detail: 'This compiler does not say where its packages are. Shibo will find out when you run a sketch.' };
    items.push(avr);
    const tiny = needCore('ATTinyCore:avr', c.path);
    items.push(st.attiny === 'present' ? { label: '$(check) ATtiny85 board package (optional): installed', detail: 'ATtiny85 sketches can be compiled.' }
      : { label: '$(dash) ATtiny85 board package (optional): not installed', detail: c.found ? 'Only the ATtiny85 board needs it. Pick this to put the install command in a terminal for you to run.' : 'Only the ATtiny85 board needs it. It can be installed once there is a compiler.',
        ...(c.found ? { act: () => inTerminal(tiny.command!) } : {}) });
    items.push(st.ngspice.found ? { label: '$(check) Circuit checker, ngspice (optional): found', detail: 'Voltages and currents are checked while a sketch runs.' }
      : { label: '$(dash) Circuit checker, ngspice (optional): not found', detail: `Without it Shibo checks the wiring rules only. ${st.ngspice.how}` });
    if (c.ownBytes !== undefined) items.push({ label: '$(trash) Remove the downloaded compiler', detail: `Frees about ${size(c.ownBytes)}.`, act: () => removeDownloaded(toolchain) });

    const picked = await vscode.window.showQuickPick(items, { title: 'Shibo: your setup', placeHolder: st.ready ? 'Everything a sketch needs is here.' : 'Pick what is missing to install it.' });
    if (!picked?.act) return;
    await picked.act();
  }
}
