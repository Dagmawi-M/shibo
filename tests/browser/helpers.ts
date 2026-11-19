// Starts the standalone server on a throwaway project folder and opens the
// editor in headless Chromium, so a test drives the real page end to end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, type Server } from '../../server/standalone.ts';
import { launch, type Browser, type Page } from './cdp.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
export const fixture = (name: string) => fs.readFileSync(path.join(root, 'engine', 'test', 'fixtures', name), 'utf8');

/** The button-toggles-LED sketch, already compiled: runs need no arduino-cli. */
export const toggleHex = fixture('toggle.hex');

/** An Uno with an LED (through a resistor) on 13 and a button on 2. */
export const starter = {
  version: 1,
  parts: [
    { id: 'uno', type: 'uno', x: 0, y: 0 },
    { id: 'led1', type: 'led', x: 120, y: -90, attrs: { color: 'red' } },
    { id: 'r1', type: 'resistor', x: 160, y: -40, attrs: { value: '220' } },
    { id: 'btn1', type: 'pushbutton', x: 260, y: -100 },
  ],
  wires: [
    { from: 'uno:13', to: 'r1:2', color: 'green' }, { from: 'r1:1', to: 'led1:A' }, { from: 'led1:C', to: 'uno:GND.1', color: 'black' },
    { from: 'btn1:1.l', to: 'uno:2', color: 'blue' }, { from: 'btn1:2.r', to: 'uno:GND.2', color: 'black' },
  ],
  boards: [{ part: 'uno', firmware: '' }],
};

export interface Editor { page: Page; dir: string; server: Server; url: string; close(): Promise<void> }

let shared: Browser | null = null;
/** One browser for the whole test file; each editor gets its own tab. */
async function browser(): Promise<Browser> { return (shared ??= await launch()); }
export async function closeBrowser(): Promise<void> { await shared?.close(); shared = null; }

/**
 * Open the editor on a new folder holding `project` (a shibo.json object, or
 * null for an empty folder) and, optionally, a sketch. Waits until the page
 * has drawn the project.
 */
export async function openEditor(project: object | null, opts: { sketch?: string; hex?: string; size?: { width: number; height: number } } = {}): Promise<Editor> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shibo-browser-'));
  if (project) fs.writeFileSync(path.join(dir, 'shibo.json'), JSON.stringify(project, null, 2));
  if (opts.sketch !== undefined) fs.writeFileSync(path.join(dir, 'sketch.ino'), opts.sketch);
  const hex = opts.hex ?? toggleHex;
  const server = await startServer({ dir, port: 0, build: async () => ({ ok: true, log: '', hex }) });
  const url = `http://127.0.0.1:${server.port}/`;
  const page = await (await browser()).page(url, opts.size);
  // The page has the project once the folder name is in the top bar.
  await page.waitFor(`document.getElementById('where')?.textContent === ${JSON.stringify(path.basename(dir))}`, { what: 'the project to arrive' });
  return {
    page, dir, server, url,
    async close() {
      await page.send('Page.close').catch(() => {});
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Number of elements matching a selector. */
export const count = (page: Page, selector: string) => page.eval<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
/** Text of an element, trimmed. */
export const text = (page: Page, selector: string) => page.eval<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`);
/** The project as saved on disk. */
export const saved = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'shibo.json'), 'utf8'));
