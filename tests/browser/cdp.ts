// A small headless-Chromium driver over the DevTools protocol, with no
// dependencies: Node's own WebSocket talks to a Chromium found on this machine.
//   const b = await launch(); const page = await b.page(url); ... await b.close();
// Set CHROME=/path/to/chrome to choose the browser.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Chromium-family browsers, in the order they are tried. */
function findChrome(): string | null {
  const home = os.homedir();
  const playwright = path.join(home, '.cache', 'ms-playwright');
  const fromPlaywright = fs.existsSync(playwright)
    ? fs.readdirSync(playwright).filter((d) => /^chromium/.test(d)).sort().reverse()
      .flatMap((d) => [path.join(playwright, d, 'chrome-linux', 'chrome'), path.join(playwright, d, 'chrome-linux64', 'chrome'), path.join(playwright, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell')])
    : [];
  const candidates = [
    process.env.CHROME ?? '',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...fromPlaywright,
  ];
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}

export const chromePath = findChrome();

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };

class Connection {
  private ws: WebSocket;
  private next = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, ((params: any) => void)[]>();
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
      } else {
        for (const h of this.handlers.get(`${m.sessionId ?? ''}|${m.method}`) ?? []) h(m.params);
      }
    });
    ws.addEventListener('close', () => { for (const p of this.pending.values()) p.reject(new Error(`${p.method}: browser connection closed`)); this.pending.clear(); });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method: string, sessionId: string, cb: (params: any) => void): void {
    const k = `${sessionId}|${method}`;
    this.handlers.set(k, [...(this.handlers.get(k) ?? []), cb]);
  }
  close(): void { this.ws.close(); }
}

export interface Box { x: number; y: number; width: number; height: number }

export class Page {
  /** Console errors and uncaught exceptions seen on this page, in order. */
  readonly errors: string[] = [];
  /** Every console message, as "type: text". */
  readonly console: string[] = [];
  private conn: Connection;
  readonly session: string;
  constructor(conn: Connection, session: string) {
    this.conn = conn; this.session = session;
    conn.on('Runtime.consoleAPICalled', session, (p) => {
      const text = p.args.map((a: any) => a.value ?? a.description ?? '').join(' ');
      this.console.push(`${p.type}: ${text}`);
      if (p.type === 'error' || p.type === 'assert') this.errors.push(text);
    });
    conn.on('Runtime.exceptionThrown', session, (p) => this.errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
    // A browser asks every site for /favicon.ico on its own; that miss is not the page's error.
    conn.on('Log.entryAdded', session, (p) => { if (p.entry.level === 'error' && !/\/favicon\.ico$/.test(p.entry.url ?? '')) this.errors.push(`${p.entry.source}: ${p.entry.text}${p.entry.url ? ' ' + p.entry.url : ''}`); });
  }
  send(method: string, params: object = {}): Promise<any> { return this.conn.send(method, params, this.session); }

  async goto(url: string): Promise<void> {
    const loaded = new Promise<void>((r) => this.conn.on('Page.loadEventFired', this.session, () => r()));
    const res = await this.send('Page.navigate', { url });
    if (res.errorText) throw new Error(`could not open ${url}: ${res.errorText}`);
    await loaded;
  }

  /** Run an expression in the page and return its value (promises are awaited). */
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  while running: ${expression}`);
    return r.result.value as T;
  }

  /** Wait until an expression is truthy in the page; returns its value. */
  async waitFor<T = any>(expression: string, { timeout = 5000, what = expression } = {}): Promise<T> {
    const deadline = Date.now() + timeout;
    let last: unknown;
    for (;;) {
      try { last = await this.eval(expression); if (last) return last as T; } catch (err) { last = (err as Error).message; }
      if (Date.now() > deadline) throw new Error(`timed out after ${timeout} ms waiting for ${what} (last value: ${JSON.stringify(last)})`);
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  /** Where an element is on screen, or null if there is none or it has no size. */
  async box(selector: string): Promise<Box | null> {
    return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
      e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect();
      return r.width || r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`);
  }

  private async mouse(type: string, x: number, y: number, button: 'left' | 'right' | 'none' = 'left', clickCount = 1): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' || button === 'none' ? 0 : button === 'left' ? 1 : 2, clickCount });
  }

  /** A real mouse click (press and release) at the centre of an element, as a person would. */
  async click(selector: string, { button = 'left' as 'left' | 'right' } = {}): Promise<void> {
    const b = await this.waitFor<Box>(`(${this.boxFn})(${JSON.stringify(selector)})`, { what: `an element ${selector} to click` });
    await this.clickAt(b.x + b.width / 2, b.y + b.height / 2, button);
  }
  async clickAt(x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
    await this.mouse('mouseMoved', x, y, 'none');
    await this.mouse('mousePressed', x, y, button);
    await this.mouse('mouseReleased', x, y, button);
  }
  /** Press at one point, move in steps, release at another. */
  async drag(from: [number, number], to: [number, number], steps = 8): Promise<void> {
    await this.mouse('mouseMoved', from[0], from[1], 'none');
    await this.mouse('mousePressed', from[0], from[1]);
    for (let i = 1; i <= steps; i++) await this.mouse('mouseMoved', from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    await this.mouse('mouseReleased', to[0], to[1]);
  }
  private boxFn = `(s) => { const e = document.querySelector(s); if (!e || e.closest('[hidden]') || e.disabled) return null;
    e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return r.width && r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; }`;

  /** Type text into whatever has focus. */
  async type(text: string): Promise<void> { await this.send('Input.insertText', { text }); }
  /** Press one key, such as "Enter", "Escape" or "z" with modifiers. */
  async key(key: string, { ctrl = false, shift = false } = {}): Promise<void> {
    const codes: Record<string, [string, number, string?]> = { Enter: ['Enter', 13, '\r'], Escape: ['Escape', 27], Delete: ['Delete', 46], Backspace: ['Backspace', 8] };
    const [code, keyCode, text] = codes[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), ctrl ? undefined : key];
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  }

  async screenshot(file: string): Promise<void> {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }

  /** Make the page think the system is in light or dark mode. */
  async colorScheme(value: 'light' | 'dark'): Promise<void> {
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  }
}

export interface Browser { page(url?: string, size?: { width: number; height: number }): Promise<Page>; close(): Promise<void> }

/** Start a fresh headless browser with its own throwaway profile. */
export async function launch(): Promise<Browser> {
  if (!chromePath) throw new Error('no Chromium-family browser found; set CHROME to one');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shibo-chrome-'));
  const proc: ChildProcess = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--mute-audio', '--hide-scrollbars', '--no-sandbox', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`the browser did not start:\n${err}`)), 15000);
    proc.stderr!.on('data', (d) => {
      err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the browser exited (${code}) before it was ready:\n${err}`)); });
  });
  proc.stderr!.resume();
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('could not reach the browser'))); });
  const conn = new Connection(ws);
  let closed = false;
  return {
    async page(url = 'about:blank', size = { width: 1280, height: 800 }) {
      const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
      const page = new Page(conn, sessionId);
      await Promise.all([page.send('Page.enable'), page.send('Runtime.enable'), page.send('Log.enable')]);
      await page.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
      if (url !== 'about:blank') await page.goto(url);
      return page;
    },
    async close() {
      if (closed) return; closed = true;
      try { await Promise.race([conn.send('Browser.close'), new Promise((r) => setTimeout(r, 2000))]); } catch { /* already gone */ }
      conn.close();
      if (proc.exitCode === null) { proc.kill('SIGKILL'); await new Promise((r) => proc.once('exit', r)); }
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}
