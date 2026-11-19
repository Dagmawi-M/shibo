// The parts catalogue in the side bar: search, categories, favourites, recently
// used, and a details view for each part. main.ts mounts it once and hands it
// the catalogue every time the engine sends one; adding a part goes back
// through main.ts, which knows where on the canvas there is room.
import { infoFor, pinMeaning, searchCatalog, type PartInfo, type Wiring } from '../../engine/src/catalog-info.ts';

export interface PaletteEntry { type: string; label: string; tag: string; group: string }
interface Options {
  /** Where the catalogue goes. */
  box: HTMLElement;
  /** The drag-and-drop type the canvas accepts; the data is the part type. */
  mime: string;
  /** Put a part in the circuit (clicked rather than dragged). */
  add(type: string): void;
}
type Pic = HTMLElement & { pinInfo?: { name: string; x: number; y: number }[]; updateComplete?: Promise<unknown> };

const FAVS = 'shibo.catalog.favs', RECENT = 'shibo.catalog.recent', RECENT_MAX = 8;
const load = (key: string): string[] => {
  try { const v = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 200) : []; } catch { return []; }
};
const store = (key: string, v: string[]) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* not remembered */ } };

// ---------- icons ----------
const svg = (body: string, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON: Record<string, string> = {
  all: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z"/>',
  recent: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  Boards: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  'Lights and sound': '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  Lights: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  Basics: '<path d="M2 12h4l1.5-4 3 8 3-8 3 8 1.5-4h4"/>',
  'Switches and knobs': '<circle cx="12" cy="12" r="7"/><path d="M12 12V5.5"/><path d="M12 2v1M22 12h-1M2 12h1"/>',
  'Motors and switching': '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  Motors: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  Sensors: '<circle cx="12" cy="12" r="1.6"/><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.4 18.6a9.3 9.3 0 0 1 0-13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2"/>',
  Modules: '<path d="M4 8l8-4.5L20 8v8l-8 4.5L4 16z"/><path d="M4 8l8 4.5L20 8M12 12.5v8"/>',
  Displays: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M7 8h5M7 11h8"/>',
  Power: '<path d="M13 2L5 13.5h6L10 22l8-11.5h-6z"/>',
  other: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="12" cy="12" r="2.5"/>',
};
const iconFor = (group: string) => svg(ICON[group] ?? ICON[group.split(/\s/)[0]] ?? ICON.other);

/** A drawing scaled to fit a box, never enlarged past `grow`. */
function fit(pic: Pic, holder: HTMLElement, w: number, h: number, grow = 1): Promise<number> {
  return (pic.updateComplete ?? Promise.resolve()).then(() => {
    // Some drawings size their host oddly; the picture inside is what counts.
    const r = (pic.shadowRoot?.querySelector('svg') ?? pic).getBoundingClientRect();
    const pw = Math.max(r.width, pic.offsetWidth, 1), ph = Math.max(r.height, pic.offsetHeight, 1), k = Math.min(w / pw, h / ph, grow);
    pic.style.width = `${pw}px`; pic.style.height = `${ph}px`; pic.style.transform = `scale(${k})`;
    holder.style.width = `${Math.ceil(pw * k)}px`; holder.style.height = `${Math.ceil(ph * k)}px`;
    return k;
  });
}
const drawing = (tag: string): Pic | null => (customElements.get(tag) ? document.createElement(tag) as Pic : null);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e;
};

export function mountCatalog(o: Options): { update(entries: PaletteEntry[]): void } {
  injectStyle();
  let entries: PaletteEntry[] = [];
  let byType = new Map<string, PaletteEntry>();
  let key = '';
  let chip = 'all';
  let favs = load(FAVS), recent = load(RECENT);
  const cards = new Map<string, HTMLElement>();

  const root = el('div', 'cat');
  const search = el('label', 'cat-search');
  search.innerHTML = svg(ICON.search, 15);
  const find = el('input'); find.type = 'search'; find.placeholder = 'Search parts'; find.setAttribute('aria-label', 'Search parts'); find.spellcheck = false;
  const kbd = el('kbd', '', '/'); kbd.title = 'Press / to search';
  search.append(find, kbd);
  const chips = el('div', 'cat-chips'); chips.setAttribute('role', 'toolbar'); chips.setAttribute('aria-label', 'Categories');
  const list = el('div', 'cat-list');
  root.append(search, chips, list);
  o.box.replaceChildren(root);
  const detail = el('div', 'cat-detail'); detail.hidden = true; detail.setAttribute('role', 'dialog'); detail.setAttribute('aria-modal', 'false');
  document.body.append(detail);

  // Pictures are made only when their card scrolls into view, a few per frame,
  // so typing in the search box never waits for a hundred live drawings.
  const queue: HTMLElement[] = [];
  let pumping = false;
  const pump = () => {
    const start = performance.now(), made: [Pic, HTMLElement][] = [];
    while (queue.length && (made.length === 0 || performance.now() - start < 6)) {
      const thumb = queue.shift()!;
      if (!thumb.isConnected) { seen.observe(thumb); continue; }   // scrolled away or filtered out: make it when it shows again
      const pic = drawing(thumb.dataset.tag ?? '');
      if (!pic) { thumb.classList.add('none'); thumb.innerHTML = iconFor(thumb.dataset.group ?? ''); continue; }
      thumb.append(pic); made.push([pic, thumb]);
    }
    // Measure every new picture first, then size them all, so the page lays out once.
    void Promise.all(made.map(([pic]) => pic.updateComplete ?? Promise.resolve())).then(() => requestAnimationFrame(() => {
      const sizes = made.map(([pic]) => { const r = (pic.shadowRoot?.querySelector('svg') ?? pic).getBoundingClientRect(); return [Math.max(r.width, pic.offsetWidth, 1), Math.max(r.height, pic.offsetHeight, 1)]; });
      made.forEach(([pic, thumb], i) => {
        const [pw, ph] = sizes[i], k = Math.min(Number(thumb.dataset.w) / pw, Number(thumb.dataset.h) / ph, 1);
        pic.style.width = `${pw}px`; pic.style.height = `${ph}px`; pic.style.transform = `scale(${k})`;
        thumb.style.width = `${Math.ceil(pw * k)}px`; thumb.style.height = `${Math.ceil(ph * k)}px`; thumb.classList.add('ready');
      });
    }));
    if (queue.length) requestAnimationFrame(pump); else pumping = false;
  };
  const seen = new IntersectionObserver((xs) => {
    for (const x of xs) if (x.isIntersecting) { seen.unobserve(x.target); queue.push(x.target as HTMLElement); }
    if (queue.length && !pumping) { pumping = true; requestAnimationFrame(pump); }
  }, { root: list, rootMargin: '160px 0px' });
  const thumbFor = (c: PaletteEntry, w: number, h: number) => {
    const t = el('span', 'cat-thumb'); t.dataset.tag = c.tag; t.dataset.group = c.group; t.dataset.w = String(w); t.dataset.h = String(h);
    seen.observe(t); return t;
  };

  const used = (type: string) => { recent = [type, ...recent.filter((t) => t !== type)].slice(0, RECENT_MAX); store(RECENT, recent); if (!find.value) draw(); };
  const addNow = (type: string) => { o.add(type); used(type); };
  const toggleFav = (type: string) => {
    favs = favs.includes(type) ? favs.filter((t) => t !== type) : [...favs, type]; store(FAVS, favs);
    for (const b of document.querySelectorAll<HTMLElement>(`.cat-star[data-type="${CSS.escape(type)}"]`)) setStar(b, type);
    draw();
  };
  const setStar = (b: HTMLElement, type: string) => {
    const on = favs.includes(type), name = byType.get(type)?.label ?? type;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    b.title = on ? `Remove ${name} from starred` : `Star ${name}`; b.setAttribute('aria-label', b.title);
  };
  const draggable = (b: HTMLElement, type: string) => {
    b.draggable = true;
    b.addEventListener('dragstart', (e) => { e.dataTransfer!.setData(o.mime, type); e.dataTransfer!.effectAllowed = 'copy'; });
    b.addEventListener('dragend', (e) => { if (e.dataTransfer && e.dataTransfer.dropEffect !== 'none') used(type); });
  };

  function card(c: PaletteEntry): HTMLElement {
    const have = cards.get(c.type);
    if (have) return have;
    const info = infoFor(c);
    const box = el('div', 'cat-card'); box.dataset.type = c.type;
    const add = el('button', 'cat-add'); add.title = `Add ${c.label}: click, or drag it onto the canvas`;
    const text = el('span', 'cat-text');
    text.append(el('span', 'cat-name', c.label), el('span', 'cat-sum', info.summary));
    add.append(thumbFor(c, 56, 42), text);
    draggable(add, c.type);
    add.addEventListener('click', () => addNow(c.type));
    const star = el('button', 'cat-star'); star.dataset.type = c.type; star.innerHTML = svg(ICON.star, 14); setStar(star, c.type);
    star.addEventListener('click', () => toggleFav(c.type));
    const more = el('button', 'cat-more'); more.innerHTML = svg(ICON.info, 14); more.title = `About ${c.label}: pins, specs and wiring`; more.setAttribute('aria-label', more.title);
    more.addEventListener('click', () => open(c.type, more));
    add.addEventListener('contextmenu', (e) => { e.preventDefault(); open(c.type, more); });
    box.append(add, star, more);
    cards.set(c.type, box);
    return box;
  }

  /** A small tile for the starred and recent strips. */
  function tile(c: PaletteEntry): HTMLElement {
    const b = el('button', 'cat-tile'); b.title = `Add ${c.label}`;
    b.append(thumbFor(c, 40, 30), el('span', '', c.label));
    draggable(b, c.type);
    b.addEventListener('click', () => addNow(c.type));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); open(c.type, b); });
    return b;
  }

  const head = (icon: string, name: string, count?: number) => {
    const h = el('div', 'cat-head'); h.innerHTML = icon;
    h.append(el('span', '', name)); if (count !== undefined) h.append(el('small', '', String(count)));
    return h;
  };
  const strip = (icon: string, name: string, types: string[]) => {
    const items = types.map((t) => byType.get(t)).filter((c): c is PaletteEntry => Boolean(c));
    if (!items.length) return [];
    const s = el('div', 'cat-strip'); s.append(...items.map(tile));
    return [head(icon, name), s];
  };

  function drawChips(): void {
    const groups = [...new Set(entries.map((c) => c.group))];
    const make = (id: string, label: string, icon: string) => {
      const b = el('button', 'cat-chip'); b.innerHTML = icon; b.title = label; b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', String(chip === id)); b.classList.toggle('on', chip === id);
      b.onclick = () => { chip = chip === id && id !== 'all' ? 'all' : id; find.value = ''; drawChips(); draw(); list.scrollTop = 0; };
      return b;
    };
    chips.replaceChildren(make('all', 'All parts', svg(ICON.all)), make('starred', 'Starred', svg(ICON.star)), ...groups.map((g) => make(g, g, iconFor(g))));
  }

  function draw(): void {
    const q = find.value.trim();
    const out: HTMLElement[] = [];
    if (q) {
      const hits = searchCatalog(entries, q);
      out.push(head(svg(ICON.search, 14), hits.length ? `${hits.length} ${hits.length === 1 ? 'part' : 'parts'}` : 'Nothing found'));
      if (!hits.length) {
        const p = el('p', 'cat-empty'); p.textContent = `No part matches “${q}”. Try another word, like “sensor”, “display” or “motor”.`;
        out.push(p);
      }
      out.push(...hits.map(card));
    } else if (chip === 'starred') {
      out.push(head(svg(ICON.star, 14), 'Starred'));
      const items = favs.map((t) => byType.get(t)).filter((c): c is PaletteEntry => Boolean(c));
      if (!items.length) out.push(el('p', 'cat-empty', 'Nothing starred yet. Star a part you use often and it waits for you here and at the top of the list.'));
      out.push(...items.map(card));
    } else if (chip !== 'all') {
      const items = entries.filter((c) => c.group === chip);
      out.push(head(iconFor(chip), chip, items.length), ...items.map(card));
    } else {
      out.push(...strip(svg(ICON.star, 14), 'Starred', favs), ...strip(svg(ICON.recent, 14), 'Recently used', recent));
      const groups = new Map<string, PaletteEntry[]>();
      for (const c of entries) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
      for (const [g, items] of groups) out.push(head(iconFor(g), g, items.length), ...items.map(card));
    }
    list.replaceChildren(...out);
  }

  // ---------- search keys ----------
  let pending = 0;
  find.addEventListener('input', () => { if (find.value) chip = 'all'; cancelAnimationFrame(pending); pending = requestAnimationFrame(() => { drawChips(); draw(); list.scrollTop = 0; }); });
  find.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = list.querySelector<HTMLElement>('.cat-add'); if (first && find.value.trim()) { e.preventDefault(); first.click(); } }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector<HTMLElement>('.cat-add, .cat-tile')?.focus(); }
    else if (e.key === 'Escape' && find.value) { e.stopPropagation(); find.value = ''; draw(); }
  });
  list.addEventListener('keydown', (e) => {
    // Up and down walk the list; the canvas must not see them, or it moves the selected part.
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault(); e.stopPropagation();
    const all = [...list.querySelectorAll<HTMLElement>('.cat-add, .cat-tile')], i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowUp' && i <= 0) { find.focus(); return; }
    all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable)) { e.preventDefault(); find.focus(); find.select(); }
    if (e.key === 'Escape' && !detail.hidden) { e.stopPropagation(); close(); }
  }, true);

  // ---------- details ----------
  let opener: HTMLElement | null = null;
  let openType = '';
  function close(): void {
    if (detail.hidden) return;
    detail.hidden = true; openType = '';
    opener?.focus(); opener = null;
  }
  document.addEventListener('pointerdown', (e) => {
    if (detail.hidden) return;
    const t = e.target as Node;
    if (!detail.contains(t) && !(t instanceof Element && t.closest('.cat-more, .cat-tile, .cat-add'))) close();
  });
  window.addEventListener('resize', () => { if (!detail.hidden) place(); });

  function place(): void {
    const r = o.box.closest('aside')?.getBoundingClientRect() ?? o.box.getBoundingClientRect();
    const narrow = window.innerWidth < 700;
    detail.classList.toggle('sheet', narrow);
    if (narrow) { detail.style.left = detail.style.top = ''; return; }
    detail.style.left = `${Math.round(r.right + 8)}px`;
    detail.style.top = `${Math.round(r.top + 8)}px`;
  }

  function open(type: string, from: HTMLElement): void {
    const c = byType.get(type);
    if (!c) return;
    if (openType === type && !detail.hidden) { close(); return; }
    opener = from; openType = type;
    const info = infoFor(c);
    detail.replaceChildren();
    detail.setAttribute('aria-label', `About ${c.label}`);

    const top = el('div', 'cat-d-top');
    const kind = el('span', 'cat-d-kind'); kind.innerHTML = iconFor(c.group); kind.append(c.group);
    const x = el('button', 'cat-d-close'); x.innerHTML = svg(ICON.close, 16); x.title = 'Close (Esc)'; x.setAttribute('aria-label', 'Close');
    x.onclick = close;
    top.append(kind, x);

    const stageBox = el('div', 'cat-d-pic');
    const frame = el('div', 'cat-d-frame');
    stageBox.append(frame);
    const pic = drawing(c.tag);
    const dots = el('div', 'cat-d-dots');
    if (pic) frame.append(pic, dots); else { frame.classList.add('none'); frame.innerHTML = svg(ICON[c.group] ?? ICON.other, 56); }

    const title = el('h3', '', c.label);
    const sum = el('p', 'cat-d-sum', info.summary);
    const facts = el('div', 'cat-d-facts');
    if (info.volts) facts.append(el('span', '', info.volts));
    const actions = el('div', 'cat-d-actions');
    const add = el('button', 'cat-d-add'); add.innerHTML = svg(ICON.plus, 15); add.append('Add to circuit');
    add.onclick = () => { addNow(type); close(); };
    draggable(add, type);
    const star = el('button', 'cat-star cat-d-star'); star.dataset.type = type; star.innerHTML = svg(ICON.star, 15); setStar(star, type);
    star.append(el('span', '', 'Star'));
    star.onclick = () => toggleFav(type);
    actions.append(add, star);

    const body = el('div', 'cat-d-body');
    body.append(title, sum, facts, actions);
    if (info.specs.length) {
      const ul = el('ul', 'cat-d-specs'); ul.append(...info.specs.map((s) => el('li', '', s)));
      body.append(el('h4', '', 'Specs'), ul);
    }
    const pinsBox = el('div', 'cat-d-pins');
    body.append(el('h4', '', 'Pins'), pinsBox);
    const pinNames = Object.keys(info.pins ?? {});
    const listPins = (names: string[]) => {
      if (!names.length) { pinsBox.append(el('p', 'cat-empty', 'No pins: it has no wires.')); return; }
      const t = el('table'); const tb = el('tbody');
      for (const n of names) {
        const tr = el('tr'); tr.dataset.pin = n;
        tr.append(el('th', '', n), el('td', '', pinMeaning(type, n) || '—'));
        tr.addEventListener('pointerenter', () => mark(n, true)); tr.addEventListener('pointerleave', () => mark(n, false));
        tb.append(tr);
      }
      t.append(tb); pinsBox.append(t);
    };
    const mark = (n: string, on: boolean) => {
      for (const d of dots.querySelectorAll<HTMLElement>('i')) d.classList.toggle('hot', on && d.dataset.pin === n);
      for (const r of pinsBox.querySelectorAll<HTMLElement>('tr')) r.classList.toggle('hot', on && r.dataset.pin === n);
    };
    if (info.wiring?.length) body.append(el('h4', '', 'Wiring example'), wiringFigure(c.label, info.wiring));
    if (info.code) { const pre = el('pre', 'cat-d-code'); pre.append(el('code', '', info.code)); body.append(pre); }

    detail.append(top, stageBox, body);
    detail.hidden = false;
    place();
    x.focus();

    if (pic) {
      void fit(pic, frame, 300, 170, 2.5).then((k) => {
        // Pins come from the drawing, so the list matches what is on the canvas.
        const fromDrawing = [...new Set((pic.pinInfo ?? []).map((p) => p.name))];
        listPins(fromDrawing.length ? fromDrawing : pinNames);
        for (const p of pic.pinInfo ?? []) {
          const d = el('i'); d.dataset.pin = p.name; d.title = p.name;
          d.style.left = `${p.x * k}px`; d.style.top = `${p.y * k}px`;
          d.addEventListener('pointerenter', () => mark(p.name, true)); d.addEventListener('pointerleave', () => mark(p.name, false));
          dots.append(d);
        }
        frame.classList.add('ready');
      });
    } else listPins(pinNames);
  }

  return {
    update(next: PaletteEntry[]) {
      const k = next.map((c) => `${c.type}|${c.label}|${c.group}|${c.tag}`).join(',');
      if (k === key) return;
      key = k; entries = next; byType = new Map(next.map((c) => [c.type, c]));
      for (const t of [...cards.keys()]) cards.delete(t);
      if (chip !== 'all' && chip !== 'starred' && !next.some((c) => c.group === chip)) chip = 'all';
      find.placeholder = `Search ${next.length} parts`;
      drawChips(); draw();
    },
  };
}

// ---------- wiring figure ----------
const WIRE: Record<string, string> = { GND: 'var(--cat-gnd)', '5V': '#d92d20', '3.3V': '#e8590c', VIN: '#d92d20' };
const SIGNAL = ['#12a150', '#2563eb', '#c026d3', '#ca8a04', '#0891b2', '#7c3aed', '#16a34a', '#db2777'];

/** The part's pins on the left, the Uno's on the right, one wire each. */
function wiringFigure(label: string, rows: Wiring[]): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const rowH = 24, topY = 30, w = 300, h = topY + rows.length * rowH + 8;
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${h}`); s.setAttribute('class', 'cat-wiring'); s.setAttribute('role', 'img');
  s.setAttribute('aria-label', `Wiring: ${rows.map((r) => `${r.pin} to ${r.to}${r.via ? ` through ${r.via}` : ''}`).join(', ')}`);
  const add = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text; s.append(e); return e;
  };
  const boxH = rows.length * rowH + 4;
  add('rect', { x: 1, y: topY - 6, width: 78, height: boxH, rx: 6, class: 'box' });
  add('rect', { x: w - 79, y: topY - 6, width: 78, height: boxH, rx: 6, class: 'box' });
  add('text', { x: 40, y: 14, 'text-anchor': 'middle', class: 'cap' }, label.length > 14 ? `${label.slice(0, 13)}…` : label);
  add('text', { x: w - 40, y: 14, 'text-anchor': 'middle', class: 'cap' }, 'Arduino Uno');
  let n = 0;
  rows.forEach((r, i) => {
    const y = topY + i * rowH + rowH / 2 - 2;
    const color = WIRE[r.to] ?? SIGNAL[n++ % SIGNAL.length];
    add('text', { x: 70, y: y + 4, 'text-anchor': 'end', class: 'pin' }, r.pin);
    add('text', { x: w - 70, y: y + 4, 'text-anchor': 'start', class: 'pin' }, /^\d+$/.test(r.to) ? `D${r.to}` : r.to);
    add('circle', { cx: 79, cy: y, r: 2.6, fill: color });
    add('circle', { cx: w - 79, cy: y, r: 2.6, fill: color });
    if (r.via) {
      const mid = w / 2;
      if (/resistor/i.test(r.via)) {
        add('line', { x1: 79, y1: y, x2: mid - 34, y2: y, stroke: color, 'stroke-width': 2 });
        add('line', { x1: mid + 34, y1: y, x2: w - 79, y2: y, stroke: color, 'stroke-width': 2 });
        add('path', { d: `M${mid - 34} ${y}h6l3-5 4 10 4-10 4 10 4-10 4 10 3-5h6`, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' });
        add('text', { x: mid, y: y - 7, 'text-anchor': 'middle', class: 'via' }, r.via.replace(/\s*resistor/i, ''));
      } else {
        add('line', { x1: 79, y1: y, x2: w - 79, y2: y, stroke: color, 'stroke-width': 2 });
        const text = r.via.length > 20 ? `${r.via.slice(0, 19)}…` : r.via, cw = Math.min(136, text.length * 5.4 + 14);
        add('rect', { x: mid - cw / 2, y: y - 8, width: cw, height: 16, rx: 8, class: 'chip' });
        add('text', { x: mid, y: y + 3.5, 'text-anchor': 'middle', class: 'via' }, text);
        s.lastElementChild!.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: r.via }));
      }
    } else add('line', { x1: 79, y1: y, x2: w - 79, y2: y, stroke: color, 'stroke-width': 2 });
  });
  const fig = document.createElement('figure'); fig.className = 'cat-d-wiring'; fig.append(s);
  return fig;
}

// ---------- look ----------
// The catalogue keeps its own styles, built on the page's colour tokens, so it
// can change without touching the rest of the page's stylesheet.
function injectStyle(): void {
  if (document.getElementById('cat-style')) return;
  const st = document.createElement('style'); st.id = 'cat-style';
  st.textContent = `
.main { grid-template-columns: var(--palette-w, 256px) 1fr; }
#palette { display: flex; flex-direction: column; overflow: hidden; }
.cat, .cat-detail { --cat-gnd: color-mix(in srgb, var(--ink) 72%, var(--panel)); --cat-soft: color-mix(in srgb, var(--ink) 5%, transparent); --cat-hover: color-mix(in srgb, var(--ink) 8%, transparent); }
.cat { display: flex; flex-direction: column; min-height: 0; flex: 1; gap: 8px; }
.cat-search { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 32px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--mute); transition: border-color .15s, box-shadow .15s; }
.cat-search:focus-within { border-color: var(--select); box-shadow: 0 0 0 3px color-mix(in srgb, var(--select) 18%, transparent); }
.cat-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; padding: 0; margin: 0; width: auto; color: var(--ink); }
.cat-search input::-webkit-search-cancel-button { cursor: pointer; }
.cat-search kbd { font: 600 10px ui-monospace, monospace; padding: 1px 5px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; color: var(--mute); }
.cat-search:focus-within kbd { display: none; }
.cat-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.cat-chip { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border-radius: 7px; border: 1px solid transparent; background: none; color: var(--mute); transition: background .15s, color .15s; }
.cat-chip:hover:not(:disabled) { background: var(--cat-hover); color: var(--ink); border-color: transparent; }
.cat-chip.on { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.cat-list { flex: 1; min-height: 0; overflow: auto; margin: 0 -8px; padding: 0 8px 8px; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--mute) 45%, transparent) transparent; }
.cat-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; padding: 8px 2px 4px; background: var(--panel); color: var(--mute); font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
.cat-head svg { width: 14px; height: 14px; flex: none; }
.cat-head small { margin-left: auto; font-weight: 500; letter-spacing: 0; font-variant-numeric: tabular-nums; }
.cat-card { position: relative; margin-bottom: 2px; content-visibility: auto; contain-intrinsic-size: auto 54px; border-radius: 8px; transition: background .12s; }
.cat-card:hover, .cat-card:focus-within { background: var(--cat-hover); }
.cat-add { display: grid; grid-template-columns: 56px 1fr; gap: 10px; align-items: center; width: 100%; min-height: 54px; padding: 6px 8px; border: 0; border-radius: 8px; background: none; text-align: left; cursor: grab; }
.cat-add:active { cursor: grabbing; }
.cat-thumb { display: block; justify-self: center; overflow: hidden; pointer-events: none; width: 40px; height: 30px; opacity: 0; transition: opacity .2s; }
.cat-thumb.ready, .cat-thumb.none { opacity: 1; }
.cat-thumb.none { display: grid; place-items: center; color: var(--mute); border-radius: 6px; background: var(--cat-soft); width: 42px; height: 34px; }
.cat-thumb > * { display: block; transform-origin: 0 0; pointer-events: none; }
.cat-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding-right: 22px; }
.cat-name { font-weight: 600; line-height: 1.25; }
.cat-sum { color: var(--mute); font-size: 11.5px; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cat-star, .cat-more { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--mute); }
.cat-card .cat-star, .cat-card .cat-more { position: absolute; right: 4px; opacity: 0; transition: opacity .12s, color .12s, background .12s; }
.cat-card .cat-star { top: 4px; } .cat-card .cat-more { bottom: 4px; }
.cat-card:hover .cat-star, .cat-card:hover .cat-more, .cat-card:focus-within .cat-star, .cat-card:focus-within .cat-more, .cat-star.on { opacity: 1; }
.cat-star:hover:not(:disabled), .cat-more:hover:not(:disabled) { background: var(--cat-hover); color: var(--ink); }
.cat-star.on { color: #e0a100; } .cat-star.on svg { fill: currentColor; }
.cat-strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(68px, 1fr)); gap: 4px; margin-bottom: 4px; }
.cat-tile { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); cursor: grab; min-width: 0; }
.cat-tile .cat-thumb { width: 40px; height: 30px; }
.cat-tile > span:last-child { font-size: 11px; line-height: 1.2; text-align: center; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cat-empty { color: var(--mute); font-size: 12px; margin: 6px 4px 10px; line-height: 1.45; }
.cat-detail { position: fixed; z-index: 25; width: min(372px, calc(100vw - 24px)); max-height: calc(100vh - 80px); overflow: auto; border-radius: 14px; background: var(--panel); color: var(--ink); border: 1px solid var(--line);
  box-shadow: 0 1px 2px rgb(0 0 0 / .08), 0 18px 48px rgb(0 0 0 / .22); animation: cat-in .16s ease-out; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--mute) 45%, transparent) transparent; }
.cat-detail[hidden] { display: none; }
.cat-detail.sheet { left: 8px; right: 8px; bottom: 8px; top: auto; width: auto; max-height: 75vh; }
@keyframes cat-in { from { opacity: 0; transform: translateX(-6px); } }
.cat-d-top { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; padding: 10px 10px 6px 16px; background: var(--panel); }
.cat-d-kind { display: inline-flex; align-items: center; gap: 6px; color: var(--mute); font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
.cat-d-close { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border-radius: 8px; border: 0; background: var(--panel); color: var(--mute); }
.cat-d-close:hover:not(:disabled) { color: var(--ink); background: var(--cat-soft); }
.cat-d-pic { display: grid; place-items: center; margin: 2px 16px 0; min-height: 150px; padding: 16px; border-radius: 10px;
  background: var(--bg) radial-gradient(color-mix(in srgb, var(--mute) 30%, transparent) 1px, transparent 1px) 0 0 / 14px 14px; }
.cat-d-frame { position: relative; opacity: 0; transition: opacity .2s; }
.cat-d-frame.ready, .cat-d-frame.none { opacity: 1; }
.cat-d-frame.none { color: var(--mute); }
.cat-d-frame > :first-child { display: block; transform-origin: 0 0; pointer-events: none; }
.cat-d-dots { position: absolute; inset: 0; }
.cat-d-dots i { position: absolute; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; border-radius: 50%; background: color-mix(in srgb, var(--select) 30%, transparent); border: 1.5px solid var(--select); opacity: .55; transition: transform .12s, opacity .12s; cursor: help; }
.cat-d-dots i:hover, .cat-d-dots i.hot { opacity: 1; transform: scale(1.6); background: var(--select); }
.cat-d-body { padding: 4px 16px 16px; }
.cat-d-body h3 { margin: 12px 0 2px; font-size: 17px; line-height: 1.25; }
.cat-d-sum { margin: 0 0 8px; color: var(--mute); line-height: 1.45; }
.cat-d-facts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.cat-d-facts:empty { display: none; }
.cat-d-facts span { padding: 2px 8px; border-radius: 999px; background: var(--cat-soft); border: 1px solid var(--line); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.cat-d-facts span::before { content: '⚡ '; }
.cat-d-actions { display: flex; gap: 8px; margin-bottom: 4px; }
.cat-d-add { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 8px; background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; cursor: grab; }
.cat-d-add:hover:not(:disabled) { border-color: var(--accent); filter: brightness(1.08); }
.cat-d-star { width: auto; height: auto; gap: 5px; display: inline-flex; padding: 6px 12px; border: 1px solid var(--line); color: var(--ink); }
.cat-d-star.on span { display: none; }
.cat-d-star.on::after { content: 'Starred'; }
.cat-d-body h4 { margin: 16px 0 6px; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: var(--mute); }
.cat-d-specs { margin: 0; padding-left: 18px; line-height: 1.5; }
.cat-d-specs li::marker { color: var(--mute); }
.cat-d-pins table { width: 100%; border-collapse: collapse; font-size: 12px; }
.cat-d-pins tr { transition: background .1s; }
.cat-d-pins tr.hot { background: color-mix(in srgb, var(--select) 14%, transparent); }
.cat-d-pins th { text-align: left; font: 600 11.5px ui-monospace, monospace; white-space: nowrap; padding: 4px 10px 4px 6px; vertical-align: top; color: var(--ink); }
.cat-d-pins td { padding: 4px 6px 4px 0; color: var(--mute); }
.cat-d-pins tr + tr > * { border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent); }
.cat-d-wiring { margin: 0; padding: 10px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); }
.cat-wiring { display: block; width: 100%; height: auto; color: var(--mute); font: 11px ui-monospace, monospace; }
.cat-wiring .box { fill: var(--panel); stroke: var(--line); }
.cat-wiring .cap { fill: var(--mute); font: 600 10.5px system-ui, sans-serif; }
.cat-wiring .pin { fill: var(--ink); }
.cat-wiring .via { fill: var(--mute); font-size: 9.5px; }
.cat-wiring .chip { fill: var(--panel); stroke: var(--line); }
.cat-d-code { margin: 8px 0 0; padding: 10px 12px; border-radius: 10px; background: var(--term-bg); color: var(--term-ink); font: 11.5px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .cat *, .cat-detail, .cat-detail * { transition: none !important; animation: none !important; } }
@media (max-width: 700px) {
  .main { grid-template-columns: 1fr; }
  #palette { display: block; flex: none; margin: 0; overflow: visible; }
  .cat { flex-direction: row; align-items: center; gap: 6px; }
  .cat-search { width: 150px; flex: none; }
  .palette .cat-search input { display: block; margin: 0; }
  .cat-chips, .cat-head, .cat-strip, .cat-empty, .cat-thumb, .cat-sum, .cat-card .cat-star { display: none; }
  .cat-list { display: flex; gap: 4px; overflow-x: auto; overflow-y: hidden; margin: 0; padding: 0; }
  .cat-card { flex: none; display: flex; align-items: center; border: 1px solid var(--line); }
  .cat-add { display: block; min-height: 0; padding: 5px 10px; white-space: nowrap; }
  .cat-text { padding-right: 0; }
  .cat-card .cat-more { position: static; opacity: 1; }
}`;
  document.head.append(st);
}
