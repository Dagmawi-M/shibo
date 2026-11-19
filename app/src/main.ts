// The editor page: catalog, canvas, wiring, live run. It holds no simulation
// logic; every change is a message to the engine, and what it draws is what
// the engine sends back.
import '@wokwi/elements';
import { connect } from './transport.ts';

interface Part { id: string; type: string; x: number; y: number; rot?: number; attrs?: Record<string, string> }
interface Wire { from: string; to: string; color?: string }
interface Project { parts: Part[]; wires: Wire[] }
interface ControlDef { kind: 'momentary' | 'toggle' | 'range'; min?: number; max?: number; initial: number; label?: string; unit?: string; step?: number; log?: boolean }
interface UiEvent { on: string; control?: string; value?: number; delta?: number; from?: string }
interface CatalogEntry {
  type: string; label: string; tag: string; group: string; attrs?: string[];
  show?: Record<string, string>; events?: UiEvent[]; paint?: string; controls?: Record<string, ControlDef>;
}
type PartEl = HTMLElement & { pinInfo?: { name: string; x: number; y: number }[]; updateComplete?: Promise<unknown> };
type Selection = { kind: 'part'; id: string } | { kind: 'wire'; index: number } | null;
type RunState = 'idle' | 'building' | 'running';

const SVG = 'http://www.w3.org/2000/svg';
const PART_MIME = 'text/shibo-part';
const LOST = 'Lost the connection to the simulator. Start it again, then reload this page.';

document.getElementById('app')!.innerHTML = `
<header class="bar">
  <b>Shibo</b>
  <button id="run" class="primary" title="Compile the sketch and start the circuit">&#9654; Upload &amp; Run</button>
  <button id="stop">&#9632; Stop</button>
  <span class="sketch" id="sketch"></span>
  <span class="sep"></span>
  <button id="undo" title="Undo (Ctrl+Z)" aria-label="Undo">&#8630;</button>
  <button id="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">&#8631;</button>
  <button id="save" title="Save the circuit (Ctrl+S)">Save</button>
  <span class="sep"></span>
  <button id="zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
  <button id="zoom-level" title="Back to 100%">100%</button>
  <button id="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
  <button id="fit" title="Fit the whole circuit in the window">Fit</button>
  <span class="sep"></span>
  <button id="guide" title="Write a printable list of parts and connections">Wiring guide</button>
  <button id="panels" title="Show or hide the serial monitor, settings and problems"></button>
  <span class="where" id="where"></span>
  <span class="status" id="status" role="status"></span>
</header>
<div class="main">
  <aside class="palette">
    <h2>Parts</h2>
    <input id="find" type="search" placeholder="Find a part" aria-label="Find a part">
    <div id="palette"></div>
    <h2>In this circuit</h2>
    <ul id="inventory"></ul>
  </aside>
  <div class="work">
    <span class="hint" id="hint" role="status"></span>
    <div class="welcome" id="welcome" hidden></div>
    <div class="stage" id="stage"><div id="sizer"><div class="canvas" id="canvas"><svg class="wires" id="wires"></svg></div></div></div>
    <div class="side">
      <section class="serial"><h2>Serial monitor <button id="clear" title="Clear the serial monitor">Clear</button></h2><pre id="serial"></pre>
        <input id="serial-in" placeholder="Send to the board (Enter)" aria-label="Send text to the board"></section>
      <section class="controls"><h2>Selected</h2><div id="props"></div><h2>Sensor values</h2><div id="controls"></div></section>
      <section class="problems"><h2>Problems</h2><div id="problems"></div></section>
    </div>
  </div>
</div>
<div id="tip" class="tip" hidden></div>
<div id="menu" class="menu" hidden role="menu"></div>`;

// The page's own elements are looked up once. Nothing a project file contains
// can stand in for them later.
const own: Record<string, HTMLElement> = {};
for (const id of ['run', 'stop', 'save', 'undo', 'redo', 'sketch', 'where', 'status', 'palette', 'inventory', 'stage', 'sizer', 'hint', 'canvas', 'serial',
  'serial-in', 'problems', 'find', 'controls', 'tip', 'menu', 'zoom-in', 'zoom-out', 'zoom-level', 'fit', 'guide', 'panels', 'welcome', 'clear', 'props']) own[id] = document.getElementById(id)!;
const $ = <T extends HTMLElement>(id: string) => own[id] as T;
const canvas = $('canvas'), stage = $('stage'), wiresSvg = document.getElementById('wires') as unknown as SVGSVGElement;

const link = connect();

let project: Project = { parts: [], wires: [] };
let catalog: CatalogEntry[] = [];
let dir: string | null = null;
let sketch: string | null = null;
let dirty = false, canUndo = false, canRedo = false;
let state: RunState = 'idle';
let timeMs = 0;
let els: Record<string, PartEl> = {};
let ox = 60, oy = 60;                  // where project (0,0) sits on the canvas
let zoom = 1;
let selected: Selection = null;
let wireFrom: string | null = null;
let pointer: [number, number] = [0, 0];
let problems: string[] = [];
let lastError = '';
let renderToken = 0;
let lastOutputs: Record<string, Record<string, unknown>> = {};
let templates: { id: string; label: string; detail: string }[] = [];
let follow: string | null = null;            // a part just renamed: keep it selected under its new name
let collapsed = false;
try { collapsed = localStorage.getItem('shibo.panels') === 'hidden'; } catch { /* panels shown */ }
const knobs: Record<string, unknown> = {};                   // where each switch and knob was left, kept across redraws
const values: Record<string, Record<string, number>> = {};   // every control's value, kept across redraws and runs

const edit = (op: string, ...args: unknown[]) => link.send({ t: 'edit', op, args });
const typeOf = (id: string) => project.parts.find((p) => p.id === id)?.type ?? '';
const entry = (id: string) => catalog.find((c) => c.type === typeOf(id));
const hint = (text: string) => { $('hint').textContent = text; };
/** A pointer position in canvas coordinates, whatever the zoom. */
const at = (e: { clientX: number; clientY: number }): [number, number] => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom]; };

// ---------- messages from the engine ----------
link.onMessage((m) => {
  switch (m.t) {
    case 'project':
      if (m.dir !== dir) { dir = m.dir; setOrigin(m.project); selected = null; }
      project = m.project; catalog = m.catalog; dirty = m.dirty; canUndo = m.canUndo; canRedo = m.canRedo; sketch = m.sketch; templates = m.templates ?? [];
      // A circuit can arrive with parts above or left of the origin (a template, an undo): make room so none is off the canvas.
      ox = Math.max(ox, 60 - Math.min(0, ...project.parts.map((q) => q.x))); oy = Math.max(oy, 60 - Math.min(0, ...project.parts.map((q) => q.y)));
      if (follow && project.parts.some((p) => p.id === follow)) selected = { kind: 'part', id: follow };
      follow = null;
      if (selected?.kind === 'part' && !project.parts.some((p) => p.id === (selected as { id: string }).id)) selected = null;
      if (selected?.kind === 'wire' && selected.index >= project.wires.length) selected = null;
      lastError = '';
      drawPalette(); void render(); drawBar(); drawProblems(); drawControls(); drawInventory(); drawWelcome(); drawProps(true);
      break;
    case 'status': {
      const was = state; state = m.state; timeMs = m.timeMs;
      if (state === 'building') { $('serial').textContent = ''; lastError = ''; drawProblems(); }
      if (state === 'running' && was !== 'running') { cancelWire(); sendControls(); }
      if (state !== 'running' && was === 'running') showOutputs({});
      canvas.classList.toggle('running', state === 'running');
      drawBar();
      break;
    }
    case 'outputs': showOutputs(m.outputs); break;
    case 'dirty': dirty = m.dirty; drawBar(); break;
    case 'serial': {
      const pre = $('serial');
      pre.textContent = ((pre.textContent ?? '') + m.text).slice(-20000);
      pre.scrollTop = pre.scrollHeight;
      break;
    }
    case 'problems': problems = m.items; drawProblems(); break;
    case 'error': lastError = m.message; drawProblems(); break;
    case 'guideCreated': hint(`Wrote ${String(m.path).split(/[\\/]/).pop()} in the project folder. Open it in a browser to print it.`); break;
    case 'sketchCreated': hint(`Wrote ${String(m.path).split(/[\\/]/).pop()} from your wiring. Open it to change what the board does.`); break;
  }
});
link.onDown(() => hint(LOST));
link.onUp(() => { if ($('hint').textContent === LOST) hint(''); });

// ---------- top bar ----------
function drawBar(): void {
  ($('run') as HTMLButtonElement).disabled = state !== 'idle';
  ($('stop') as HTMLButtonElement).disabled = state !== 'running';
  ($('save') as HTMLButtonElement).disabled = !dirty;
  ($('undo') as HTMLButtonElement).disabled = !canUndo;
  ($('redo') as HTMLButtonElement).disabled = !canRedo;
  $('save').textContent = dirty ? 'Save •' : 'Save';
  const folder = (dir ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  $('where').textContent = folder; $('where').title = dir ?? '';
  $('status').textContent = state === 'running' ? `Running · ${(timeMs / 1000).toFixed(1)} s` : state === 'building' ? `Uploading ${sketch ?? 'the sketch'}…` : 'Stopped';
  $('zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  const count = problems.length + (lastError ? 1 : 0);
  $('panels').textContent = `${collapsed ? 'Show' : 'Hide'} panels${count ? ` · ${count} problem${count > 1 ? 's' : ''}` : ''}`;
  $('panels').classList.toggle('alert', count > 0);
  $('stage').parentElement!.classList.toggle('collapsed', collapsed);
  const chip = $('sketch');
  chip.replaceChildren();
  if (sketch) { chip.textContent = `Sketch: ${sketch}`; chip.title = 'This is the code that Upload & Run puts on the board. Saving it while running uploads it again.'; }
  else if (dir) {
    const b = document.createElement('button');
    b.id = 'create-sketch'; b.textContent = 'Create sketch from circuit'; b.title = 'Writes a starter sketch with a named pin for everything you have wired';
    b.onclick = () => link.send({ t: 'createSketch' });
    chip.append(b);
  }
}
$('run').onclick = () => link.send({ t: 'start' });
$('stop').onclick = () => link.send({ t: 'stop' });
$('save').onclick = () => link.send({ t: 'save' });
$('undo').onclick = () => link.send({ t: 'undo' });
$('redo').onclick = () => link.send({ t: 'redo' });
$('guide').onclick = () => link.send({ t: 'guide' });
$('clear').onclick = () => { $('serial').textContent = ''; };
$('panels').onclick = () => { collapsed = !collapsed; try { localStorage.setItem('shibo.panels', collapsed ? 'hidden' : 'shown'); } catch { /* not remembered */ } drawBar(); };
$('serial-in').addEventListener('keydown', (e) => {
  const input = e.target as HTMLInputElement;
  if (e.key === 'Enter') { link.send({ t: 'serial', text: input.value + '\n' }); input.value = ''; }
});

function drawProblems(): void {
  const box = $('problems');
  const items = [...(lastError ? [lastError] : []), ...problems];
  box.replaceChildren();
  drawBar();
  if (!items.length) { const p = document.createElement('div'); p.className = 'ok'; p.textContent = 'No problems found.'; box.append(p); return; }
  const ul = document.createElement('ul');
  for (const text of items) { const li = document.createElement('li'); li.textContent = text; ul.append(li); }
  box.append(ul);
  // A wire to something that is not there cannot be drawn, so it cannot be clicked: offer to clear them.
  if (problems.some((x) => x.startsWith('wire ')) && state !== 'running') {
    const b = document.createElement('button');
    b.textContent = 'Remove broken wires'; b.onclick = () => edit('pruneWires');
    box.append(b);
  }
}

// ---------- catalog ----------
let paletteFor = '';
function drawPalette(): void {
  const box = $('palette'), key = catalog.map((c) => c.type).join(',');
  if (key === paletteFor) return;
  paletteFor = key;
  const groups = new Map<string, CatalogEntry[]>();
  for (const c of catalog) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  box.replaceChildren(...[...groups].map(([name, items]) => {
    const d = document.createElement('details'); d.open = true;
    const sum = document.createElement('summary'); sum.textContent = `${name} (${items.length})`;
    d.append(sum, ...items.map((c) => {
      const b = document.createElement('button');
      b.className = 'card'; b.draggable = true; b.dataset.type = c.type; b.title = `Add ${c.label}: drag it onto the canvas, or click`;
      const thumb = document.createElement('span'); thumb.className = 'thumb';
      const label = document.createElement('span'); label.className = 'name'; label.textContent = c.label;
      b.append(thumb, label);
      // A small live picture of the part. It is only a picture: it takes no clicks.
      if (customElements.get(c.tag)) {
        const pic = document.createElement(c.tag) as PartEl;
        thumb.append(pic);
        void (pic.updateComplete ?? Promise.resolve()).then(() => {
          // Some drawings size their host oddly; the picture inside is what counts.
          const box = (pic.shadowRoot?.querySelector('svg') ?? pic).getBoundingClientRect();
          const w = Math.max(box.width, pic.offsetWidth, 1), h = Math.max(box.height, pic.offsetHeight, 1), k = Math.min(48 / w, 34 / h, 1);
          pic.style.width = `${w}px`; pic.style.height = `${h}px`;
          pic.style.transform = `scale(${k})`; thumb.style.width = `${Math.ceil(w * k)}px`; thumb.style.height = `${Math.ceil(h * k)}px`;
        });
      }
      b.addEventListener('dragstart', (e) => { e.dataTransfer!.setData(PART_MIME, c.type); e.dataTransfer!.effectAllowed = 'copy'; });
      b.addEventListener('click', () => {
        // Clicked rather than dragged: put it in the free space to the right of what is already there.
        let right = 0, top = Infinity;
        for (const el of Object.values(els)) { right = Math.max(right, el.offsetLeft + el.offsetWidth); top = Math.min(top, el.offsetTop); }
        edit('addPart', c.type, Math.round((right ? right + 40 : 60) - ox), Math.round((Number.isFinite(top) ? top : 60) - oy));
      });
      return b;
    }));
    return d;
  }));
  filterPalette();
}
function filterPalette(): void {
  const q = ($('find') as HTMLInputElement).value.trim().toLowerCase();
  for (const d of $('palette').querySelectorAll('details')) {
    let any = false;
    for (const b of d.querySelectorAll('button')) { const hit = !q || b.textContent!.toLowerCase().includes(q); b.hidden = !hit; any ||= hit; }
    (d as HTMLElement).hidden = !any;
    if (q) d.open = true;
  }
}
$('find').addEventListener('input', filterPalette);

/** The components in the circuit, to select or remove without hunting on the canvas. */
function drawInventory(): void {
  const list = $('inventory');
  list.replaceChildren(...project.parts.map((p) => {
    const li = document.createElement('li');
    li.classList.toggle('selected', selected?.kind === 'part' && selected.id === p.id);
    const pick = document.createElement('button'); pick.className = 'pick';
    const name = document.createElement('span'); name.textContent = p.id;
    const kind = document.createElement('small'); kind.textContent = entry(p.id)?.label ?? p.type.replace(/^unknown:/, '');
    pick.append(name, kind);
    pick.onclick = () => { selected = { kind: 'part', id: p.id }; layout(); drawInventory(); els[p.id]?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); };
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.title = `Remove ${p.id} and its wires`; del.setAttribute('aria-label', `Remove ${p.id}`);
    del.onclick = () => edit('removePart', p.id);
    li.append(pick, del);
    return li;
  }));
  if (!project.parts.length) { const li = document.createElement('li'); li.className = 'none'; li.textContent = 'Nothing yet. Start with a board.'; list.append(li); }
}

stage.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes(PART_MIME)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; stage.classList.add('over');
});
stage.addEventListener('dragleave', () => stage.classList.remove('over'));
stage.addEventListener('drop', (e) => {
  stage.classList.remove('over');
  const type = e.dataTransfer?.getData(PART_MIME);
  if (!type) return;
  e.preventDefault();
  const [x, y] = at(e);
  edit('addPart', type, Math.round(x - ox), Math.round(y - oy));
});

// ---------- canvas ----------
function setOrigin(p: Project): void {
  ox = 60 - Math.min(0, ...p.parts.map((q) => q.x));
  oy = 60 - Math.min(0, ...p.parts.map((q) => q.y));
}

async function render(): Promise<void> {
  const token = ++renderToken;
  for (const el of Object.values(els)) el.remove();
  els = {};
  for (const p of project.parts) {
    const c = catalog.find((x) => x.type === p.type);
    const tag = c?.tag ?? p.type.replace(/^unknown:/, '');
    const known = /^[a-z][a-z0-9-]*-[a-z0-9-]*$/.test(tag) && customElements.get(tag);
    const el = document.createElement(known ? tag : 'div') as PartEl;
    if (!known) { el.classList.add('box'); el.textContent = `${p.id} (${tag})`; }
    // Only settings this part type is known to take, and only plain values: a project file can come from anyone.
    for (const k of c?.attrs ?? []) {
      const v = p.attrs?.[k];
      if (typeof v === 'string' && /^[\w#.-]{0,32}$/.test(v)) el.setAttribute(k, v);
    }
    if (p.id in knobs) (el as any).value = knobs[p.id];
    el.classList.add('part');
    if (p.type.startsWith('unknown:')) el.classList.add('inert');
    el.dataset.id = p.id;
    place(el, p);
    el.addEventListener('pointerdown', (e) => startDrag(e, p.id));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (state === 'running') return; selected = { kind: 'part', id: p.id }; layout(); menu(e, [['Rotate', () => edit('rotatePart', p.id)], [`Remove ${p.id}`, () => edit('removePart', p.id)]]); });
    el.addEventListener('input', () => { knobs[p.id] = (el as any).value; });
    for (const ev of c?.events ?? []) el.addEventListener(ev.on, (e) => onPartEvent(p.id, ev, e));
    canvas.append(el);
    els[p.id] = el;
  }
  await Promise.all(Object.values(els).map((e) => e.updateComplete));
  if (token !== renderToken) return;
  layout();
  showOutputs(lastOutputs);                  // a redraw must not turn lit LEDs dark
}

function place(el: HTMLElement, p: Part): void { el.style.left = `${p.x + ox}px`; el.style.top = `${p.y + oy}px`; el.style.transform = p.rot ? `rotate(${p.rot}deg)` : ''; }

/** Where a pin is on the canvas, allowing for the part being turned about its centre. */
function pinAt(el: PartEl, rot: number | undefined, x: number, y: number): [number, number] {
  if (rot) {
    const cx = el.offsetWidth / 2, cy = el.offsetHeight / 2, a = (rot * Math.PI) / 180, dx = x - cx, dy = y - cy;
    [x, y] = [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
  }
  return [el.offsetLeft + x, el.offsetTop + y];
}
const rotOf = (id: string) => project.parts.find((p) => p.id === id)?.rot;

function pinPos(ref: string): [number, number] | null {
  const i = ref.indexOf(':'); const el = els[ref.slice(0, i)];
  const info = el?.pinInfo?.find((x) => x.name === ref.slice(i + 1));
  return el && info ? pinAt(el, rotOf(ref.slice(0, i)), info.x, info.y) : null;
}

/** Position pins and wires from where the parts are now. */
function layout(): void {
  for (const old of canvas.querySelectorAll('.pin')) old.remove();
  let w = 0, h = 0;
  for (const [id, el] of Object.entries(els)) {
    const span = rotOf(id) ? Math.max(el.offsetWidth, el.offsetHeight) : 0;      // a turned part can reach further either way
    w = Math.max(w, el.offsetLeft + Math.max(el.offsetWidth, span)); h = Math.max(h, el.offsetTop + Math.max(el.offsetHeight, span));
    el.classList.toggle('selected', selected?.kind === 'part' && selected.id === id);
    if (typeOf(id).startsWith('unknown:')) continue;
    for (const pin of el.pinInfo ?? []) {
      const ref = `${id}:${pin.name}`;
      const dot = document.createElement('div');
      dot.className = 'pin' + (ref === wireFrom ? ' from' : '') + (wireFrom && ref !== wireFrom ? ' target' : '');
      const [px, py] = pinAt(el, rotOf(id), pin.x, pin.y);
      dot.style.left = `${px}px`; dot.style.top = `${py}px`;
      dot.dataset.ref = ref; dot.setAttribute('aria-label', `${id} pin ${pin.name}`);
      dot.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); pinDown(ref); });
      dot.addEventListener('pointerenter', () => tip(dot, id, pin.name));
      dot.addEventListener('pointerleave', () => { $('tip').hidden = true; });
      canvas.append(dot);
    }
  }
  canvas.style.width = `${w + 240}px`; canvas.style.height = `${h + 240}px`;
  canvas.style.transform = `scale(${zoom})`;
  $('sizer').style.width = `${(w + 240) * zoom}px`; $('sizer').style.height = `${(h + 240) * zoom}px`;
  wiresSvg.setAttribute('width', String(w + 240)); wiresSvg.setAttribute('height', String(h + 240));
  drawWires(); drawProps();
}

/** A label for the pin under the pointer: which part, which pin. */
function tip(dot: HTMLElement, id: string, pin: string): void {
  const t = $('tip'), r = dot.getBoundingClientRect();
  t.textContent = `${id} · ${pin}`;
  t.hidden = false;
  t.style.left = `${Math.max(4, Math.min(window.innerWidth - t.offsetWidth - 4, r.left + r.width / 2 - t.offsetWidth / 2))}px`;
  t.style.top = `${r.top - t.offsetHeight - 6 < 0 ? r.bottom + 6 : r.top - t.offsetHeight - 6}px`;
}

/** The part lying under the pointer, if there is one beneath whatever was hit. */
function partUnder(e: Event): string | null {
  const m = e as MouseEvent;
  const el = document.elementsFromPoint(m.clientX, m.clientY).find((x) => x instanceof HTMLElement && x.classList.contains('part')) as HTMLElement | undefined;
  return el?.dataset.id ?? null;
}

/** A wire's path: along, round the corner, then up or down. */
function route(a: [number, number], b: [number, number]): string {
  const dx = b[0] - a[0], dy = b[1] - a[1], r = Math.min(8, Math.abs(dx), Math.abs(dy));
  if (r < 1) return `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`;
  return `M${a[0]} ${a[1]} L${b[0] - Math.sign(dx) * r} ${a[1]} Q${b[0]} ${a[1]} ${b[0]} ${a[1] + Math.sign(dy) * r} L${b[0]} ${b[1]}`;
}
const WIRE_COLORS = ['red', 'black', 'green', 'blue', 'gold', 'orange', 'purple', 'gray', 'white'];

function drawWires(): void {
  wiresSvg.replaceChildren();
  project.wires.forEach((wire, index) => {
    const a = pinPos(wire.from), b = pinPos(wire.to);
    if (!a || !b) return;
    const d = route(a, b);
    const halo = document.createElementNS(SVG, 'path');
    halo.setAttribute('d', d); halo.setAttribute('class', 'halo');
    const line = document.createElementNS(SVG, 'path');
    line.setAttribute('d', d); line.setAttribute('stroke', /^[a-zA-Z#][\w#]*$/.test(wire.color ?? '') ? wire.color! : 'gray');
    line.setAttribute('class', 'wire' + (selected?.kind === 'wire' && selected.index === index ? ' selected' : ''));
    const hit = document.createElementNS(SVG, 'path');
    hit.setAttribute('d', d); hit.setAttribute('class', 'hit');
    const title = document.createElementNS(SVG, 'title'); title.textContent = `${wire.from} → ${wire.to}`; hit.append(title);
    const pick = () => { selected = { kind: 'wire', index }; layout(); drawInventory(); };
    // Where a wire lies over a part, the part wins: it can always be picked up, and the wire is clicked where it runs free.
    hit.addEventListener('pointerdown', (e) => { const id = partUnder(e); if (id) startDrag(e as PointerEvent, id); });
    hit.addEventListener('click', (e) => { e.stopPropagation(); if (state !== 'running' && !partUnder(e)) pick(); });
    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault(); if (state === 'running') return;
      const id = partUnder(e);
      if (id) { selected = { kind: 'part', id }; layout(); menu(e as MouseEvent, [['Rotate', () => edit('rotatePart', id)], [`Remove ${id}`, () => edit('removePart', id)]]); return; }
      pick(); menu(e as MouseEvent, [['Remove this wire', () => edit('removeWire', index)]], (c) => edit('setWireColor', index, c)); });
    wiresSvg.append(halo, line, hit);
  });
  if (wireFrom) {
    const a = pinPos(wireFrom);
    if (a) {
      const rubber = document.createElementNS(SVG, 'path');
      rubber.setAttribute('d', route(a, pointer)); rubber.setAttribute('class', 'rubber');
      wiresSvg.append(rubber);
    }
  }
}

// ---------- wiring: click pin then pin, or press on one pin and release on another ----------
function pinDown(ref: string): void {
  if (state === 'running') return;
  if (!wireFrom) {
    wireFrom = ref; pointer = pinPos(ref) ?? pointer;
    hint(`Wire from ${ref}: click another pin, or drag to it. Esc cancels.`);
    layout();
    return;
  }
  finishWire(ref);
}
function finishWire(ref: string): void {
  const from = wireFrom;
  if (!from) return;
  cancelWire();
  if (from === ref) { hint('That is the same pin, so no wire was added.'); return; }
  edit('addWire', from, ref);
}
function cancelWire(): void {
  if (!wireFrom) return;
  wireFrom = null; hint(''); layout();
}
stage.addEventListener('pointermove', (e) => {
  if (!wireFrom) return;
  pointer = at(e);
  drawWires();
});
window.addEventListener('pointerup', (e) => {
  // Released over a different pin after pressing on one: that is a dragged wire.
  if (!wireFrom) return;
  const over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.pin');
  if (over?.dataset.ref && over.dataset.ref !== wireFrom) finishWire(over.dataset.ref);
});
canvas.addEventListener('click', (e) => {
  if (e.target !== canvas) return;
  if (wireFrom) cancelWire(); else if (selected) { selected = null; layout(); drawInventory(); }
});

// ---------- right-click menu ----------
function swatches(pick: (color: string) => void): HTMLElement {
  const row = document.createElement('div'); row.className = 'swatches';
  for (const c of WIRE_COLORS) {
    const b = document.createElement('button'); b.style.background = c; b.title = c; b.setAttribute('aria-label', `Make it ${c}`);
    b.onclick = () => pick(c);
    row.append(b);
  }
  return row;
}
function menu(e: MouseEvent, items: [string, () => void][], color?: (c: string) => void): void {
  const m = $('menu');
  m.replaceChildren(...items.map(([label, run]) => {
    const b = document.createElement('button'); b.textContent = label; b.setAttribute('role', 'menuitem');
    b.onclick = () => { m.hidden = true; run(); };
    return b;
  }));
  if (color) m.prepend(swatches((c) => { m.hidden = true; color(c); }));
  m.hidden = false;
  m.style.left = `${Math.min(e.clientX, window.innerWidth - m.offsetWidth - 4)}px`;
  m.style.top = `${Math.min(e.clientY, window.innerHeight - m.offsetHeight - 4)}px`;
}
window.addEventListener('pointerdown', (e) => { if (!$('menu').hidden && !$('menu').contains(e.target as Node)) $('menu').hidden = true; }, true);

// ---------- moving parts ----------
function startDrag(e: PointerEvent, id: string): void {
  if (state === 'running' || e.button !== 0 || wireFrom) return;
  const el = els[id], part = project.parts.find((p) => p.id === id);
  if (!el || !part) return;
  selected = { kind: 'part', id };
  const x0 = e.clientX, y0 = e.clientY, px = part.x, py = part.y;
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - x0) / zoom, dy = (ev.clientY - y0) / zoom;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    part.x = Math.max(-ox, Math.round(px + dx)); part.y = Math.max(-oy, Math.round(py + dy));
    place(el, part); layout();
  };
  const up = () => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    if (moved) edit('movePart', id, part.x, part.y);
  };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  layout(); drawInventory();
}

// ---------- zoom ----------
function setZoom(z: number): void {
  zoom = Math.min(3, Math.max(0.4, Math.round(z * 10) / 10));
  try { localStorage.setItem('shibo.zoom', String(zoom)); } catch { /* the size is just not remembered */ }
  layout(); drawBar();
}
try { const z = Number(localStorage.getItem('shibo.zoom')); if (z >= 0.4 && z <= 3) zoom = z; } catch { /* default zoom */ }
$('zoom-in').onclick = () => setZoom(zoom + 0.2);
$('zoom-out').onclick = () => setZoom(zoom - 0.2);
$('zoom-level').onclick = () => setZoom(1);
$('fit').onclick = () => {
  let w = 0, h = 0;
  for (const el of Object.values(els)) { w = Math.max(w, el.offsetLeft + el.offsetWidth); h = Math.max(h, el.offsetTop + el.offsetHeight); }
  if (!w || !h) return;
  setZoom(Math.floor(Math.min((stage.clientWidth - 24) / (w + 40), (stage.clientHeight - 24) / (h + 40)) * 10) / 10);
  stage.scrollTo(0, 0);
};
// Drag the empty background to move around a circuit bigger than the window.
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || wireFrom || (e.target !== canvas && e.target !== stage && e.target !== $('sizer'))) return;
  const x0 = e.clientX, y0 = e.clientY, sx = stage.scrollLeft, sy = stage.scrollTop;
  const move = (ev: PointerEvent) => { stage.scrollLeft = sx - (ev.clientX - x0); stage.scrollTop = sy - (ev.clientY - y0); stage.classList.add('panning'); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); stage.classList.remove('panning'); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
stage.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1)); }, { passive: false });

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (mod && key === 's') { e.preventDefault(); if (dirty) link.send({ t: 'save' }); return; }
  if (typing) return;
  if (mod && key === 'z') { e.preventDefault(); link.send({ t: e.shiftKey ? 'redo' : 'undo' }); return; }
  if (mod && key === 'y') { e.preventDefault(); link.send({ t: 'redo' }); return; }
  if (e.key === 'Escape') { $('menu').hidden = true; if (wireFrom) cancelWire(); else if (selected) { selected = null; layout(); drawInventory(); } }
  if (selected?.kind === 'part' && state !== 'running' && !mod) {
    const part = project.parts.find((p) => p.id === (selected as { id: string }).id);
    const step = e.shiftKey ? 10 : 1, by: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (part && key === 'r') { e.preventDefault(); edit('rotatePart', part.id); return; }
    if (part && by[e.key]) { e.preventDefault(); edit('movePart', part.id, part.x + by[e.key][0], part.y + by[e.key][1]); return; }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected && state !== 'running') {
    e.preventDefault();
    const s = selected; selected = null;
    if (s.kind === 'part') edit('removePart', s.id); else edit('removeWire', s.index);
  }
});

// ---------- live run ----------
function control(part: string, name: string, value: number): void {
  (values[part] ??= {})[name] = value;
  if (state === 'running') link.send({ t: 'control', part, name, value });
}
const current = (part: string, name: string): number => values[part]?.[name] ?? entry(part)?.controls?.[name]?.initial ?? 0;

/** Turn something done to a part's own drawing (a press, a turn) into control values. */
function onPartEvent(id: string, ev: UiEvent, e: Event): void {
  const el = els[id] as any, detail = (e as CustomEvent).detail;
  switch (ev.from) {
    case 'value': control(id, ev.control!, Number(el.value) ? 1 : 0); break;
    case 'pot': {
      const min = Number(el.min ?? 0), max = Number(el.max ?? 1023), v = Number(el.value ?? 0);
      control(id, ev.control!, Math.round(Math.min(1, Math.max(0, max > min ? (v - min) / (max - min) : 0)) * 1023));
      break;
    }
    case 'dip': { const i = Number(detail); if (i >= 0 && i < 8) control(id, `sw${i + 1}`, el.values?.[i] ? 1 : 0); break; }
    case 'keypad': { const r = Number(detail?.row), c = Number(detail?.column); if (r >= 0 && r < 4 && c >= 0 && c < 4) control(id, ev.control!, r * 4 + c + 1); break; }
    case 'ir': {
      // A remote has no wires: its key goes to every infrared receiver in the circuit.
      const code = Number(detail?.irCode);
      if (code >= 0 && code <= 255) for (const p of project.parts) if (p.type === 'ir-receiver') { control(p.id, 'command', code); control(p.id, 'command', -1); }
      break;
    }
    case 'digit': { const d = Number(detail?.digit); if (d >= 0 && d <= 9) { control(id, ev.control!, d); control(id, ev.control!, -1); } break; }
    case 'joystick': control(id, 'x', Math.max(-1, Math.min(1, Number(el.xValue) || 0))); control(id, 'y', Math.max(-1, Math.min(1, Number(el.yValue) || 0))); break;
    default:
      if (ev.delta !== undefined) control(id, ev.control!, current(id, ev.control!) + ev.delta);
      else if (ev.value !== undefined) control(id, ev.control!, ev.value);
  }
  drawControls();
}
/** Controls keep the value you left them at when a run starts. */
function sendControls(): void {
  for (const p of project.parts) for (const [name, def] of Object.entries(entry(p.id)?.controls ?? {})) {
    const v = current(p.id, name);
    if (v !== def.initial && def.kind !== 'momentary') link.send({ t: 'control', part: p.id, name, value: v });
  }
}
function showOutputs(outputs: Record<string, Record<string, unknown>>): void {
  lastOutputs = outputs;
  for (const [id, el] of Object.entries(els) as [string, any][]) {
    const c = entry(id), o = outputs[id] ?? {};
    for (const [prop, key] of Object.entries(c?.show ?? {})) {
      const v = o[key];
      // With nothing running there is no value: put each property back to off.
      if (prop === 'characters') { el.characters = Uint8Array.from(Array.isArray(v) ? v : []); continue; }
      el[prop] = v === undefined ? (prop === 'values' ? [] : typeof el[prop] === 'number' ? 0 : false) : typeof v === 'boolean' && typeof el[prop] === 'number' ? Number(v) : v;
    }
    if (c?.paint === 'oled') paintOled(el, o);
    if (c?.paint === 'pixels') paintPixels(el, typeOf(id), o);
  }
}

/** The OLED's 128x64 frame arrives as hex, one byte per 8-pixel column slice. */
function paintOled(el: any, o: Record<string, unknown>): void {
  const fb = typeof o.fb === 'string' && o.on ? o.fb : '';
  if (el.__fb === fb + (o.invert ? '!' : '')) return;
  el.__fb = fb + (o.invert ? '!' : '');
  const img = new ImageData(128, 64);
  for (let page = 0; page < 8; page++) for (let x = 0; x < 128; x++) {
    const b = fb ? parseInt(fb.substr((page * 128 + x) * 2, 2), 16) || 0 : 0;
    for (let i = 0; i < 8; i++) {
      const lit = fb ? Boolean((b >> i) & 1) !== Boolean(o.invert) : false, at = ((page * 8 + i) * 128 + x) * 4;
      img.data[at] = img.data[at + 1] = img.data[at + 2] = lit ? 255 : 0; img.data[at + 3] = 255;
    }
  }
  el.imageData = img; el.redraw?.();
}

function paintPixels(el: any, type: string, o: Record<string, unknown>): void {
  const px = Array.isArray(o.pixels) ? (o.pixels as number[]) : [], key = px.join(',');
  if (el.__px === key) return;
  el.__px = key;
  if (!px.length) { el.reset?.(); return; }
  const cols = Number(el.cols) || 8;
  for (let i = 0; i * 3 < px.length; i++) {
    const rgb = { r: px[i * 3] / 255, g: px[i * 3 + 1] / 255, b: px[i * 3 + 2] / 255 };
    if (type === 'neopixel-matrix') el.setPixel?.(Math.floor(i / cols), i % cols, rgb); else el.setPixel?.(i, rgb);
  }
}

// ---------- sliders for sensor values ----------
const slider = { toPos: (d: ControlDef, v: number) => (d.log ? Math.log10(v) : v), fromPos: (d: ControlDef, x: number) => (d.log ? Math.pow(10, x) : x) };
function drawControls(): void {
  const box = $('controls');
  if (box.contains(document.activeElement)) return;          // do not rebuild under the user's hand
  box.replaceChildren();
  for (const p of project.parts) {
    const labelled = Object.entries(entry(p.id)?.controls ?? {}).filter(([, d]) => d.label);
    if (!labelled.length) continue;
    const h = document.createElement('h3'); h.textContent = p.id; box.append(h);
    for (const [name, d] of labelled) {
      const row = document.createElement('label'), text = document.createElement('span'), input = document.createElement('input'), out = document.createElement('output');
      text.textContent = d.label!;
      const v = current(p.id, name);
      const show = (x: number) => { out.textContent = d.kind === 'range' ? `${Number(x.toPrecision(4))}${d.unit ? ' ' + d.unit : ''}` : x ? 'yes' : 'no'; };
      if (d.kind === 'range') {
        input.type = 'range'; input.min = String(slider.toPos(d, d.min ?? 0)); input.max = String(slider.toPos(d, d.max ?? 1));
        input.step = d.log ? '0.01' : String(d.step ?? 1); input.value = String(slider.toPos(d, v));
        input.addEventListener('input', () => { const x = slider.fromPos(d, Number(input.value)); show(x); control(p.id, name, x); });
      } else {
        input.type = 'checkbox'; input.checked = Boolean(v);
        input.addEventListener('change', () => { show(input.checked ? 1 : 0); control(p.id, name, input.checked ? 1 : 0); });
      }
      show(v);
      row.append(text, input, out); box.append(row);
    }
  }
  if (!box.childElementCount) { const d = document.createElement('div'); d.className = 'ok'; d.textContent = 'Sensors you add appear here with a slider for what they sense.'; box.append(d); }
}

// ---------- an empty canvas says how to begin ----------
function drawWelcome(): void {
  const box = $('welcome');
  box.hidden = project.parts.length > 0 || !dir;
  if (box.hidden) return;
  box.replaceChildren();
  const h = document.createElement('h2'); h.textContent = 'Start your circuit';
  const p = document.createElement('p'); p.textContent = 'Pick a starting point, or drag any part in from the list on the left.';
  const grid = document.createElement('div'); grid.className = 'starts';
  for (const t of templates) {
    const b = document.createElement('button'); b.dataset.template = t.id;
    const name = document.createElement('b'); name.textContent = t.label;
    const about = document.createElement('span'); about.textContent = t.detail;
    b.append(name, about);
    b.onclick = () => link.send({ t: 'template', id: t.id });
    grid.append(b);
  }
  box.append(h, p, grid);
}

// ---------- settings of whatever is selected ----------
const CHOICES: Record<string, string[]> = {
  color: ['red', 'green', 'blue', 'yellow', 'orange', 'white', 'purple', 'pink', 'cyan'], common: ['cathode', 'anode'], pins: ['full', 'i2c'],
  digits: ['1', '2', '3', '4'], columns: ['4', '3'], flip: ['', '1'], colon: ['', '1'],
};
const ATTR_LABEL: Record<string, string> = { color: 'Colour', common: 'Common pin', pins: 'Wiring', digits: 'Digits', columns: 'Columns', flip: 'Flipped', colon: 'Colon', value: 'Value', pixels: 'Pixels', rows: 'Rows', cols: 'Columns', background: 'Backlight colour', horn: 'Horn', hornColor: 'Horn colour', size: 'Size', arrow: 'Arrow colour' };
let propsFor = '';
function drawProps(force = false): void {
  const box = $('props');
  const sel = selected, part = sel?.kind === 'part' ? project.parts.find((p) => p.id === sel.id) : undefined;
  const key = sel ? JSON.stringify([sel, part, sel.kind === 'wire' ? project.wires[sel.index] : null, state === 'running']) : '';
  if ((!force && key === propsFor) || box.contains(document.activeElement)) return;      // do not rebuild under the user's hand
  propsFor = key;
  box.replaceChildren();
  const row = (label: string, control: HTMLElement): void => { const l = document.createElement('label'); const t = document.createElement('span'); t.textContent = label; l.append(t, control); box.append(l); };
  const locked = state === 'running';
  if (part) {
    const c = entry(part.id);
    const kind = document.createElement('div'); kind.className = 'kind'; kind.textContent = c?.label ?? part.type.replace(/^unknown:/, '');
    box.append(kind);
    const name = document.createElement('input'); name.value = part.id; name.disabled = locked; name.setAttribute('aria-label', 'Name of this part'); name.maxLength = 64;
    name.addEventListener('change', () => { const v = name.value.trim(); if (v && v !== part.id) { follow = v; edit('renamePart', part.id, v); } });
    row('Name', name);
    for (const attr of c?.attrs ?? []) {
      const now = part.attrs?.[attr] ?? '';
      let control: HTMLInputElement | HTMLSelectElement;
      if (CHOICES[attr]) {
        control = document.createElement('select');
        for (const v of CHOICES[attr].includes(now) ? CHOICES[attr] : [now, ...CHOICES[attr]]) { const o = document.createElement('option'); o.value = v; o.textContent = v || (attr === 'flip' || attr === 'colon' ? 'no' : 'default'); if (v === '1') o.textContent = 'yes'; control.append(o); }
        control.value = now;
      } else { control = document.createElement('input'); control.value = now; control.maxLength = 32; }
      control.disabled = locked;
      control.addEventListener('change', () => edit('setAttr', part.id, attr, control.value.trim()));
      row(ATTR_LABEL[attr] ?? attr, control);
    }
    const actions = document.createElement('div'); actions.className = 'actions';
    const rot = document.createElement('button'); rot.textContent = 'Rotate'; rot.title = 'Quarter turn (R)'; rot.disabled = locked; rot.onclick = () => edit('rotatePart', part.id);
    const del = document.createElement('button'); del.textContent = 'Remove'; del.disabled = locked; del.onclick = () => edit('removePart', part.id);
    actions.append(rot, del); box.append(actions);
  } else if (sel?.kind === 'wire' && project.wires[sel.index]) {
    const w = project.wires[sel.index], index = sel.index;
    const kind = document.createElement('div'); kind.className = 'kind'; kind.textContent = `Wire: ${w.from} → ${w.to}`;
    box.append(kind);
    if (!locked) {
      box.append(swatches((c) => edit('setWireColor', index, c)));
      const del = document.createElement('button'); del.textContent = 'Remove'; del.onclick = () => edit('removeWire', index);
      const actions = document.createElement('div'); actions.className = 'actions'; actions.append(del); box.append(actions);
    }
  } else { const d = document.createElement('div'); d.className = 'ok'; d.textContent = 'Click a part or a wire to change its settings.'; box.append(d); }
}

drawBar(); drawProblems(); drawControls(); drawInventory(); drawWelcome(); drawProps(true);
