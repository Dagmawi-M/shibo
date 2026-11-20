// The "Parts list" panel: what to buy for the circuit on the canvas, with the
// owner's own prices. Prices live in prices.json in the project folder (saved
// through the engine, in VS Code and the standalone app alike); if the engine
// cannot be reached, they are kept in this browser instead.
// main.ts mounts this with one call and passes every message in.
import { billOfMaterials, defaultPriceBook, parsePriceBook, priceBom, type PriceBook, type PriceEntry } from '../../engine/src/bom.ts';
import type { Project } from '../../engine/src/project.ts';

export interface BomHost { send(m: unknown): void; project(): Pick<Project, 'parts' | 'wires'> }

const LOCAL_KEY = 'shibo.prices';
const REPLY_MS = 2000;
const STYLE = `
#bom-panel { position: fixed; inset: 56px 16px auto auto; width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 80px); display: flex; flex-direction: column;
  background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: var(--r, 8px); box-shadow: var(--shadow-lg); z-index: 50; font: 13px var(--font); }
#bom-panel[hidden] { display: none; }
#bom-panel header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
#bom-panel header h2 { font-size: 14px; margin: 0; flex: 1; }
#bom-panel .bom-body { overflow: auto; }
#bom-panel table { width: 100%; border-collapse: collapse; }
#bom-panel th, #bom-panel td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
#bom-panel th { font-weight: 600; color: var(--mute); position: sticky; top: 0; background: var(--panel); }
#bom-panel td.num, #bom-panel th.num { text-align: right; font-variant-numeric: tabular-nums; }
#bom-panel .spec { color: var(--mute); font-size: 12px; }
#bom-panel input { width: 84px; font: inherit; color: inherit; background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 4px; padding: 3px 5px; }
#bom-panel input.shop { width: 110px; }
#bom-panel .unset { color: var(--warn); font-size: 12px; }
#bom-panel footer { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); flex-wrap: wrap; }
#bom-panel footer .total { flex: 1; font-weight: 600; }
#bom-panel footer .note { width: 100%; color: var(--mute); font-size: 12px; }
#bom-panel button { font: inherit; color: inherit; background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 4px; padding: 4px 10px; cursor: pointer; }
#bom-panel button:hover { background: var(--hover); }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
}
const today = () => new Date().toISOString().slice(0, 10);

export function mountBom(host: BomHost): { onMessage(m: any): void; open(): void } {
  const style = el('style'); style.textContent = STYLE; document.head.append(style);

  const button = el('button'); button.id = 'bom'; button.title = 'What to buy for this circuit, with your prices';
  button.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 3h2l1.5 7h7L14 5H5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="6" cy="13" r="1.2" fill="currentColor"/><circle cx="12" cy="13" r="1.2" fill="currentColor"/></svg>';
  button.append(el('span', 'label', 'Parts list'));
  const guide = document.getElementById('guide');
  if (guide) guide.after(button); else document.body.append(button);

  const panel = el('section'); panel.id = 'bom-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Parts list');
  const head = el('header'); const title = el('h2', '', 'Parts list');
  const close = el('button', '', '×'); close.title = 'Close'; close.setAttribute('aria-label', 'Close parts list');
  head.append(title, close);
  const body = el('div', 'bom-body'); const table = el('table'); body.append(table);
  const foot = el('footer'); const total = el('span', 'total');
  const csv = el('button', '', 'Export CSV'); csv.id = 'bom-csv';
  const md = el('button', '', 'Export Markdown'); md.id = 'bom-md';
  const note = el('span', 'note');
  foot.append(total, csv, md, note);
  panel.append(head, body, foot);
  document.body.append(panel);

  let book: PriceBook = defaultPriceBook();
  let where = '';                       // where prices are kept, said under the table
  let waiting: ReturnType<typeof setTimeout> | null = null;

  const local = (): PriceBook | null => { try { const t = localStorage.getItem(LOCAL_KEY); return t ? parsePriceBook(JSON.parse(t)) : null; } catch { return null; } };
  const useLocal = () => {
    const l = local(); const d = defaultPriceBook();
    book = l ? { currency: l.currency, prices: { ...d.prices, ...l.prices } } : d;
    where = 'Prices are kept in this browser (the project folder could not be reached).';
    draw();
  };
  const expectReply = () => { if (waiting) clearTimeout(waiting); waiting = setTimeout(() => { waiting = null; useLocal(); }, REPLY_MS); };

  const setPrice = (key: string, entry: PriceEntry) => {
    book.prices[key] = { ...book.prices[key], ...entry };
    try { const l = local() ?? { currency: book.currency, prices: {} }; l.prices[key] = book.prices[key]; localStorage.setItem(LOCAL_KEY, JSON.stringify(l)); } catch { /* not kept here */ }
    host.send({ t: 'setPrice', key, entry }); expectReply();
    draw();
  };

  function draw(): void {
    if (panel.hidden) return;
    const b = priceBom(billOfMaterials(host.project() as Project), book);
    const cur = b.currency;
    table.replaceChildren();
    const hr = el('tr');
    for (const [t, num] of [['Qty', true], ['Part', false], [`Unit (${cur})`, true], ['Shop', false], [`Total (${cur})`, true]] as const) { const th = el('th', num ? 'num' : '', t); hr.append(th); }
    const thead = el('thead'); thead.append(hr); table.append(thead);
    const tbody = el('tbody');
    for (const l of b.lines) {
      const tr = el('tr'); tr.dataset.key = l.key;
      const name = el('td'); name.append(el('div', '', l.name), el('div', 'spec', l.spec));
      const unit = el('td', 'num'); const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.step = 'any'; inp.className = 'price';
      inp.placeholder = 'not set'; inp.setAttribute('aria-label', `Unit price of ${l.name}`);
      if (l.unit !== null) inp.value = String(l.unit);
      inp.onchange = () => {
        const v = inp.value.trim() === '' ? null : Number(inp.value);
        if (v !== null && !(Number.isFinite(v) && v >= 0)) { inp.value = l.unit === null ? '' : String(l.unit); return; }
        setPrice(l.key, { price: v, date: today() });
      };
      unit.append(inp);
      const shopTd = el('td'); const shop = el('input'); shop.className = 'shop'; shop.placeholder = 'shop'; shop.value = l.shop ?? ''; shop.maxLength = 120;
      shop.setAttribute('aria-label', `Shop for ${l.name}`);
      shop.onchange = () => setPrice(l.key, { price: l.unit, shop: shop.value.trim() });
      if (l.date) shop.title = `Price from ${l.date}`;
      shopTd.append(shop);
      const tot = el('td', 'num'); if (l.total === null) tot.append(el('span', 'unset', 'price not set')); else tot.textContent = l.total.toFixed(2);
      tr.append(el('td', 'num', String(l.qty)), name, unit, shopTd, tot);
      tbody.append(tr);
    }
    if (!b.lines.length) { const tr = el('tr'); const td = el('td', 'spec', 'Add parts to the circuit to see what to buy.'); td.colSpan = 5; tr.append(td); tbody.append(tr); }
    table.append(tbody);
    total.textContent = `Total: ${b.total.toFixed(2)} ${cur}${b.missing ? ` · ${b.missing} price${b.missing === 1 ? '' : 's'} not set` : ''}`;
    total.dataset.missing = String(b.missing);
    if (!note.dataset.flash) note.textContent = where;
  }

  const flash = (text: string) => { note.textContent = text; note.dataset.flash = '1'; setTimeout(() => { delete note.dataset.flash; draw(); }, 6000); };
  const open = () => { panel.hidden = false; draw(); host.send({ t: 'prices' }); expectReply(); };
  button.onclick = () => (panel.hidden ? open() : (panel.hidden = true));
  close.onclick = () => { panel.hidden = true; };
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.hidden = true; });
  csv.onclick = () => host.send({ t: 'exportBom', format: 'csv' });
  md.onclick = () => host.send({ t: 'exportBom', format: 'md' });

  return {
    open,
    onMessage(m: any): void {
      switch (m?.t) {
        case 'prices':
          if (waiting) { clearTimeout(waiting); waiting = null; }
          book = parsePriceBook(m.book);
          where = `Prices are saved in ${String(m.file).split(/[\\/]/).slice(-2).join('/')}.`;
          draw(); break;
        case 'bomExported': flash(`Wrote ${String(m.path).split(/[\\/]/).pop()} in the project folder.`); break;
        case 'project': draw(); break;
      }
    },
  };
}
