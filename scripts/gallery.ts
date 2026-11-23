// Draws every board and part in the catalog and writes the parts gallery:
// gallery/<group>/<type>.png and gallery/README.md.
//
//   npm run build && node scripts/gallery.ts
//   SHIBO_GALLERY_ONLY=uno,led node scripts/gallery.ts   (just these, no README)
//
// Each part is opened alone in the real editor page (headless Chromium), so
// the picture is exactly what the editor draws. Run it again after adding parts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { catalog } from '../engine/src/edit.ts';
import { startServer } from '../server/standalone.ts';
import { launch, chromePath } from '../tests/browser/cdp.ts';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'gallery');
const TILE = { w: 480, h: 360, pad: 28 };          // the saved picture, in pixels
const SHOWN = 160;                                   // width of a picture on the page
const COLUMNS = 5;
const MAX_SCALE = 5;                                 // small parts are enlarged, but not without limit
const BACKGROUND = '#121519';                        // the editor's dark canvas
const GROUPS = ['Boards', 'Lights and sound', 'Basics', 'Switches and knobs', 'Motors and switching', 'Power', 'Sensors', 'Modules', 'Displays'];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

if (!chromePath) { console.error('no Chromium-family browser found (set CHROME)'); process.exit(2); }
if (!fs.existsSync(path.join(root, 'dist', 'app', 'app.js'))) { console.error('the page is not built yet: run "npm run build" first'); process.exit(2); }

const only = process.env.SHIBO_GALLERY_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
const entries = catalog.filter((e) => !only || only.includes(e.type));

// Everything but the part is hidden, so the picture is the part on a plain
// background. The page is pushed away from the window's corner to leave room
// for the margin round a part.
const CSS = `
  html { background: ${BACKGROUND} !important; }
  #app { transform: translate(600px, 400px); }
  body * { visibility: hidden !important; }
  #canvas .part { visibility: visible !important; }
`;
// The drawing inside a part is what counts; some hosts size themselves oddly.
const MEASURE = `(() => {
  const host = document.querySelector('#canvas .part');
  if (!host) return null;
  const inner = host.shadowRoot ? [...host.shadowRoot.querySelectorAll('svg, canvas, img')] : [];
  const rects = (inner.length ? inner : [host]).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 1 && r.height > 1);
  if (!rects.length) return null;
  const x1 = Math.min(...rects.map((r) => r.left)), y1 = Math.min(...rects.map((r) => r.top));
  const x2 = Math.max(...rects.map((r) => r.right)), y2 = Math.max(...rects.map((r) => r.bottom));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1, box: host.classList.contains('box') };
})()`;

const browser = await launch();
const failed: string[] = [];
let done = 0;
try {
  for (const entry of entries) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shibo-gallery-'));
    fs.writeFileSync(path.join(dir, 'shibo.json'), JSON.stringify({
      version: 1, parts: [{ id: 'p', type: entry.type, x: 0, y: 0 }], wires: [],
      boards: entry.board ? [{ part: 'p', firmware: '' }] : [],
    }));
    const server = await startServer({ dir, port: 0, build: async () => ({ ok: true, log: '', hex: '' }) });
    const page = await browser.page();
    try {
      const view = { width: 2400, height: 1600, mobile: false };
      await page.send('Emulation.setDeviceMetricsOverride', { ...view, deviceScaleFactor: 1 });
      await page.colorScheme('dark');
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.waitFor(`document.querySelectorAll('#canvas .part').length === 1`, { what: `${entry.type} to be drawn`, timeout: 15000 });
      await page.eval(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(CSS)}; document.head.append(s); })()`);
      // Wait until the drawing has a size and has stopped changing.
      let box: { x: number; y: number; width: number; height: number; box: boolean } | null = null;
      for (let i = 0, same = 0; i < 40 && same < 3; i++) {
        await sleep(100);
        const now = await page.eval<typeof box>(MEASURE);
        same = now && box && Math.abs(now.width - box.width) < 0.5 && Math.abs(now.height - box.height) < 0.5 ? same + 1 : 0;
        box = now;
      }
      if (!box) throw new Error('nothing was drawn');
      if (box.box) throw new Error('the part has no drawing (a plain box was shown)');
      const scale = Math.min((TILE.w - 2 * TILE.pad) / box.width, (TILE.h - 2 * TILE.pad) / box.height, MAX_SCALE);
      await page.send('Emulation.setDeviceMetricsOverride', { ...view, deviceScaleFactor: scale });
      await sleep(250);
      box = (await page.eval<typeof box>(MEASURE))!;
      const w = TILE.w / scale, h = TILE.h / scale;
      const clip = { x: box.x + box.width / 2 - w / 2, y: box.y + box.height / 2 - h / 2, width: w, height: h, scale: 1 };
      const shot = await page.send('Page.captureScreenshot', { format: 'png', clip });
      // The browser rounds a picture's size by a pixel or two; set it on a tile of exactly the right size.
      const data = await page.eval<string>(`(async () => {
        const img = new Image(); img.src = 'data:image/png;base64,${shot.data}'; await img.decode();
        const c = document.createElement('canvas'); c.width = ${TILE.w}; c.height = ${TILE.h};
        const g = c.getContext('2d'); g.fillStyle = '${BACKGROUND}'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, Math.round((c.width - img.width) / 2), Math.round((c.height - img.height) / 2));
        return c.toDataURL('image/png').split(',')[1];
      })()`);
      const file = path.join(out, slug(entry.group), `${entry.type}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      done++;
      if (done % 10 === 0) console.log(`${done} of ${entries.length}`);
    } catch (e) {
      failed.push(`${entry.type}: ${(e as Error).message}`);
    } finally {
      await page.send('Page.close').catch(() => {});
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); }

if (!only) {
  const groups = [...GROUPS, ...new Set(catalog.map((e) => e.group).filter((g) => !GROUPS.includes(g)))].filter((g) => catalog.some((e) => e.group === g));
  const has = (e: { group: string; type: string }) => fs.existsSync(path.join(out, slug(e.group), `${e.type}.png`));
  const shown = catalog.filter(has);
  const lines = [
    '# Parts gallery', '',
    `Every board and part in Shibo's catalog, drawn as the editor draws it: ${shown.length} in all.`, '',
    groups.map((g) => `[${g}](#${slug(g)}) (${shown.filter((e) => e.group === g).length})`).join(' · '), '',
  ];
  for (const g of groups) {
    const parts = shown.filter((e) => e.group === g);
    if (!parts.length) continue;
    lines.push(`## ${g}`, '', '<table>');
    for (let i = 0; i < parts.length; i += COLUMNS) {
      lines.push('<tr>');
      for (const e of parts.slice(i, i + COLUMNS)) {
        lines.push(`<td align="center" valign="top" width="${100 / COLUMNS}%"><img src="${slug(g)}/${e.type}.png" width="${SHOWN}" alt="${esc(e.label)}"><br><sub>${esc(e.label)}</sub></td>`);
      }
      lines.push('</tr>');
    }
    lines.push('</table>', '');
  }
  lines.push('The pictures are made by `node scripts/gallery.ts`, which opens each part in the editor and photographs it. Run it again after adding parts.', '');
  fs.writeFileSync(path.join(out, 'README.md'), lines.join('\n'));
}

console.log(`${done} pictures written to ${path.relative(root, out)}/`);
if (failed.length) { console.error(`${failed.length} failed:\n  ${failed.join('\n  ')}`); process.exit(1); }
