// The editor page: catalog, canvas, wiring, live run. It holds no simulation
// logic; every change is a message to the engine, and what it draws is what
// the engine sends back.
import '@wokwi/elements';
import './drawings/index.ts';
import { paintTft } from './drawings/modules/paint.ts';
import { connect } from './transport.ts';
import './drawings/index.ts';
import { meterText, type ElectricalMsg } from './meter.ts';
import { mountInstruments } from './instruments/index.ts';
import { mountCatalog } from './catalog.ts';
import { autoRoute, bendPath, dragSegment, nearestSegment, simplify, smoothPath, type Pt, type Rect } from './route.ts';
import { icons } from './icons.ts';
import { mountShare, EMBED, fullEditorUrl } from './share.ts';

interface Part { id: string; type: string; x: number; y: number; rot?: number; attrs?: Record<string, string> }
interface Wire { from: string; to: string; color?: string; points?: Pt[] }
interface Project { parts: Part[]; wires: Wire[] }
interface ControlDef { kind: 'momentary' | 'toggle' | 'range'; min?: number; max?: number; initial: number; label?: string; unit?: string; step?: number; log?: boolean }
interface UiEvent { on: string; control?: string; value?: number; delta?: number; from?: string }
interface CatalogEntry {
  type: string; label: string; tag: string; group: string; attrs?: string[];
  show?: Record<string, string>; events?: UiEvent[]; paint?: string; controls?: Record<string, ControlDef>; chat?: boolean;
}
type PartEl = HTMLElement & { pinInfo?: { name: string; x: number; y: number }[]; updateComplete?: Promise<unknown> };
type Selection = { kind: 'part'; id: string } | { kind: 'wire'; index: number } | null;
type RunState = 'idle' | 'building' | 'running';

const SVG = 'http://www.w3.org/2000/svg';
const PART_MIME = 'text/shibo-part';
const LOST = 'Lost the connection to the simulator. Start it again, then reload this page.';

document.getElementById('app')!.innerHTML = `
<header class="bar">
  <div class="brand">${icons.logo}<b>Shibo</b><span class="where" id="where"></span></div>
  <div class="group">
    <button id="run" class="primary" title="Compile the sketch and start the circuit">${icons.play}<span>Upload &amp; Run</span></button>
    <button id="stop" title="Stop the circuit">${icons.stop}<span>Stop</span></button>
  </div>
  <span class="status" id="status" role="status"></span>
  <span class="sketch" id="sketch"></span>
  <span class="grow"></span>
  <div class="group joined">
    <button id="undo" class="icon-only" title="Undo (Ctrl+Z)" aria-label="Undo">${icons.undo}</button>
    <button id="redo" class="icon-only" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${icons.redo}</button>
  </div>
  <button id="save" title="Save the circuit (Ctrl+S)">${icons.save}<span class="label" id="save-label">Save</span></button>
  <span class="sep"></span>
  <div class="group joined">
    <button id="zoom-out" class="icon-only" title="Zoom out (Ctrl+wheel)" aria-label="Zoom out">${icons.minus}</button>
    <button id="zoom-level" title="Back to 100%">100%</button>
    <button id="zoom-in" class="icon-only" title="Zoom in (Ctrl+wheel)" aria-label="Zoom in">${icons.plus}</button>
  </div>
  <button id="fit" title="Fit the whole circuit in the window">${icons.fit}<span class="label">Fit</span></button>
  <button id="snap" class="icon-only toggle" title="Snap parts and wire bends to the grid (hold Alt to place freely)" aria-label="Snap to grid">${icons.grid}</button>
  <span class="sep"></span>
  <button id="share" title="Copy a link or embed code for this circuit, or open one">${icons.share}<span class="label">Share</span></button>
  <a id="open-full" class="open-full" target="_blank" rel="noopener">Open in Shibo</a>
  <button id="guide" title="Write a printable list of parts and connections">${icons.guide}<span class="label">Wiring guide</span></button>
  <button id="panels" title="Show or hide the serial monitor, settings and problems">${icons.panels}<span class="label" id="panels-label"></span></button>
</header>
<div class="main">
  <aside class="palette">
    <h2>Parts</h2>
    <div id="palette"></div>
    <h2>In this circuit</h2>
    <ul id="inventory"></ul>
  </aside>
  <div class="work">
    <div class="viewport">
      <span class="hint" id="hint" role="status"></span>
      <div class="welcome" id="welcome" hidden></div>
      <div class="stage" id="stage"><div id="sizer"><div class="canvas" id="canvas"><svg class="wires" id="wires"></svg></div></div></div>
      <canvas class="minimap" id="minimap" aria-label="Map of the whole circuit: click to go there"></canvas>
    </div>
    <div class="side" id="side">
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
  'serial-in', 'problems', 'controls', 'tip', 'menu', 'zoom-in', 'zoom-out', 'zoom-level', 'fit', 'guide', 'panels', 'welcome', 'clear', 'props',
  'snap', 'minimap', 'side', 'save-label', 'panels-label']) own[id] = document.getElementById(id)!;
const $ = <T extends HTMLElement>(id: string) => own[id] as T;
const canvas = $('canvas'), stage = $('stage'), wiresSvg = document.getElementById('wires') as unknown as SVGSVGElement;

const link = connect();
if (EMBED) {
  // An embed is read-only: it may run the circuit and use its controls, never change it.
  document.body.classList.add('embed');
  const blocked = new Set(['edit', 'save', 'undo', 'redo', 'createSketch', 'template', 'guide']);
  const send = link.send;
  link.send = (m: any) => { if (!blocked.has(m?.t)) send(m); };
  (document.getElementById('open-full') as HTMLAnchorElement).href = fullEditorUrl();
}

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
/** Every part that is selected. A single part selection is `selected` too; a wire selection leaves this empty. */
const group = new Set<string>();
let adopt: Set<string> | null = null;   // ids before a paste: whatever is new afterwards gets selected
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
const GRID = 10;                       // what parts and wire bends snap to
let snap = true;
try { snap = localStorage.getItem('shibo.snap') !== 'off'; } catch { /* snapping on */ }
const knobs: Record<string, unknown> = {};                   // where each switch and knob was left, kept across redraws
const values: Record<string, Record<string, number>> = {};   // every control's value, kept across redraws and runs

const edit = (op: string, ...args: unknown[]) => link.send({ t: 'edit', op, args });
const typeOf = (id: string) => project.parts.find((p) => p.id === id)?.type ?? '';
const entry = (id: string) => catalog.find((c) => c.type === typeOf(id));
const hint = (text: string) => { $('hint').textContent = text; };
/** A pointer position in canvas coordinates, whatever the zoom. */
const at = (e: { clientX: number; clientY: number }): [number, number] => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom]; };

// ---------- instruments: sound, timeline, analyzer, script, pin readings ----------
const inst = mountInstruments({
  send: (m) => link.send(m), values, redrawControls: () => drawControls(),
  project: () => project, controlsOf: (id) => entry(id)?.controls ?? {},
});

// ---------- messages from the engine ----------
const share = mountShare({ send: (m) => link.send(m), hint: (t) => hint(t), menu: document.getElementById('menu')!, button: document.getElementById('share')! });
link.onMessage((m) => {
  inst.onMessage(m);
  void share.onMessage(m);
  switch (m.t) {
    case 'project':
      if (m.dir !== dir) { dir = m.dir; setOrigin(m.project); selected = null; group.clear(); }
      project = m.project; catalog = m.catalog; dirty = m.dirty; canUndo = m.canUndo; canRedo = m.canRedo; sketch = m.sketch; templates = m.templates ?? [];
      // A circuit can arrive with parts above or left of the origin (a template, an undo): make room so none is off the canvas.
      ox = Math.max(ox, 60 - Math.min(0, ...project.parts.map((q) => q.x))); oy = Math.max(oy, 60 - Math.min(0, ...project.parts.map((q) => q.y)));
      if (follow && project.parts.some((p) => p.id === follow)) { if (selected?.kind === 'part') group.delete(selected.id); selected = { kind: 'part', id: follow }; group.add(follow); }
      follow = null;
      if (adopt) {
        const fresh = project.parts.filter((p) => !adopt!.has(p.id)).map((p) => p.id);
        if (fresh.length) selectParts(fresh);
        adopt = null;
      }
      for (const id of [...group]) if (!project.parts.some((p) => p.id === id)) group.delete(id);
      if (selected?.kind === 'part' && !group.has(selected.id)) selected = group.size ? { kind: 'part', id: [...group][0] } : null;
      if (selected?.kind === 'wire' && selected.index >= project.wires.length) selected = null;
      lastError = '';
      palette.update(catalog); void render(); drawBar(); drawProblems(); drawControls(); drawInventory(); drawWelcome(); drawProps(true);
      break;
    case 'status': {
      const was = state; state = m.state; timeMs = m.timeMs;
      if (state === 'building') { $('serial').textContent = ''; lastError = ''; drawProblems(); }
      if (state === 'running' && was !== 'running') { cancelWire(); sendControls(); }
      if (state !== 'running' && was === 'running') { showOutputs({}); meter = null; drawMeter(); }
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
    case 'electrical': meter = m as ElectricalMsg; drawMeter(); break;
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
  $('save-label').textContent = dirty ? 'Save •' : 'Save';
  $('save').classList.toggle('dirty', dirty);
  const folder = (dir ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  $('where').textContent = folder; $('where').title = dir ?? '';
  $('status').textContent = state === 'running' ? `Running · ${(timeMs / 1000).toFixed(1)} s` : state === 'building' ? `Uploading ${sketch ?? 'the sketch'}…` : 'Stopped';
  $('status').dataset.state = state;
  $('zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  const count = problems.length + (lastError ? 1 : 0);
  $('panels-label').textContent = `${collapsed ? 'Show' : 'Hide'} panels${count ? ` · ${count} problem${count > 1 ? 's' : ''}` : ''}`;
  $('panels').classList.toggle('alert', count > 0);
  $('panels').setAttribute('aria-pressed', String(!collapsed));
  $('snap').setAttribute('aria-pressed', String(snap));
  const work = $('stage').closest('.work')!;
  if (work.classList.contains('collapsed') !== collapsed) { work.classList.toggle('collapsed', collapsed); $('side').toggleAttribute('inert', collapsed); }
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
$('snap').onclick = () => { snap = !snap; try { localStorage.setItem('shibo.snap', snap ? 'on' : 'off'); } catch { /* not remembered */ } drawBar(); };
/** Where a part or bend lands: on the grid when snapping is on and Alt is not held. */
const snapTo = (v: number, free = false) => (snap && !free ? Math.round(v / GRID) * GRID : Math.round(v));
$('serial-in').addEventListener('keydown', (e) => {
  const input = e.target as HTMLInputElement;
  if (e.key === 'Enter') { link.send({ t: 'serial', text: input.value + '\n' }); input.value = ''; }
});

function drawProblems(): void {
  const box = $('problems');
  const items = [...(lastError ? [lastError] : []), ...problems];
  box.replaceChildren();
  drawBar();
  if (!items.length) { box.classList.remove('has'); const p = document.createElement('div'); p.className = 'ok'; p.textContent = 'No problems found.'; box.append(p); return; }
  const ul = document.createElement('ul');
  for (const text of items) { const li = document.createElement('li'); li.textContent = text; ul.append(li); }
  box.classList.toggle('has', items.length > 0);
  box.append(ul);
  // A wire to something that is not there cannot be drawn, so it cannot be clicked: offer to clear them.
  if (problems.some((x) => x.startsWith('wire ')) && state !== 'running') {
    const b = document.createElement('button');
    b.textContent = 'Remove broken wires'; b.onclick = () => edit('pruneWires');
    box.append(b);
  }
}

// ---------- catalog ----------
// The catalogue itself lives in catalog.ts; it calls back here to add a clicked part.
const palette = mountCatalog({ box: $('palette'), mime: PART_MIME, add(type) {
  // Clicked rather than dragged: put it in the free space to the right of what is already there.
  let right = 0, top = Infinity;
  for (const el of Object.values(els)) { right = Math.max(right, el.offsetLeft + el.offsetWidth); top = Math.min(top, el.offsetTop); }
  edit('addPart', type, Math.round((right ? right + 40 : 60) - ox), Math.round((Number.isFinite(top) ? top : 60) - oy));
} });

/** The components in the circuit, to select or remove without hunting on the canvas. */
function drawInventory(): void {
  const list = $('inventory');
  list.replaceChildren(...project.parts.map((p) => {
    const li = document.createElement('li');
    li.classList.toggle('selected', group.has(p.id));
    const pick = document.createElement('button'); pick.className = 'pick';
    const name = document.createElement('span'); name.textContent = p.id;
    const kind = document.createElement('small'); kind.textContent = entry(p.id)?.label ?? p.type.replace(/^unknown:/, '');
    pick.append(name, kind);
    pick.onclick = (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) toggleSelected(p.id); else selectParts([p.id]);
      layout(); drawInventory(); els[p.id]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: calm() ? 'auto' : 'smooth' });
    };
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
/** Whether to keep movement to a minimum, as the person has asked their system to. */
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let drawn = new Set<string>();             // parts already on the canvas once: only new ones fade in
async function render(): Promise<void> {
  const token = ++renderToken;
  const before = drawn;
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
    if (before.size && !before.has(p.id)) el.classList.add('enter');
    if (p.type.startsWith('unknown:')) el.classList.add('inert');
    el.dataset.id = p.id;
    place(el, p);
    el.addEventListener('pointerdown', (e) => startDrag(e, p.id));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (state === 'running') return; partMenu(e, p.id); });
    el.addEventListener('input', () => { knobs[p.id] = (el as any).value; });
    for (const ev of c?.events ?? []) el.addEventListener(ev.on, (e) => onPartEvent(p.id, ev, e));
    canvas.append(el);
    els[p.id] = el;
  }
  drawn = new Set(project.parts.map((p) => p.id));
  if (!drawn.size) drawn.add('');                 // the first part on an empty canvas still fades in
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
/** The outline a part takes up on the canvas, turned if it is turned. */
function outline(id: string): Rect | null {
  const el = els[id];
  if (!el) return null;
  const w = el.offsetWidth, h = el.offsetHeight, quarter = rotOf(id) === 90 || rotOf(id) === 270;
  const [rw, rh] = quarter ? [h, w] : [w, h];
  return { x: el.offsetLeft + (w - rw) / 2, y: el.offsetTop + (h - rh) / 2, w: rw, h: rh };
}

// ---------- selection ----------
function selectParts(ids: string[]): void { group.clear(); for (const id of ids) group.add(id); selected = ids.length ? { kind: 'part', id: ids[0] } : null; }
function toggleSelected(id: string): void {
  if (selected?.kind === 'wire') { selected = null; group.clear(); }
  if (group.has(id)) group.delete(id); else group.add(id);
  selected = group.has(id) ? { kind: 'part', id } : group.size ? { kind: 'part', id: [...group][0] } : null;
}
function selectWire(index: number): void { group.clear(); selected = { kind: 'wire', index }; }
function clearSelection(): void { group.clear(); selected = null; }
const selectedParts = () => project.parts.filter((p) => group.has(p.id));

/** Position pins and wires from where the parts are now. */
function layout(): void {
  for (const old of canvas.querySelectorAll('.pin')) old.remove();
  let w = 0, h = 0;
  for (const [id, el] of Object.entries(els)) {
    const span = rotOf(id) ? Math.max(el.offsetWidth, el.offsetHeight) : 0;      // a turned part can reach further either way
    w = Math.max(w, el.offsetLeft + Math.max(el.offsetWidth, span)); h = Math.max(h, el.offsetTop + Math.max(el.offsetHeight, span));
    el.classList.toggle('selected', group.has(id));
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
  extent = [w + 240, h + 240];
  // The canvas always fills the window, so its grid does too; it grows past it with the circuit.
  const cw = Math.max(w + 240, Math.floor(stage.clientWidth / zoom)), ch = Math.max(h + 240, Math.floor(stage.clientHeight / zoom));
  canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
  canvas.style.transform = `scale(${zoom})`;
  canvas.style.backgroundPosition = `${ox % 20}px ${oy % 20}px`;      // the grid lines up with the project's own origin, as snapping does
  $('sizer').style.width = `${cw * zoom}px`; $('sizer').style.height = `${ch * zoom}px`;
  wiresSvg.setAttribute('width', String(cw)); wiresSvg.setAttribute('height', String(ch));
  drawWires(); drawProps(); drawMinimap();
}
let extent: [number, number] = [0, 0];       // how far the circuit reaches, canvas units

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

// ---------- wires: routed round parts, or through the bends someone dragged in ----------
const WIRE_COLORS = ['red', 'black', 'green', 'blue', 'gold', 'orange', 'purple', 'gray', 'white'];
const routeCache = new Map<string, Pt[]>();
let routes: Pt[][] = [];                                   // the path each wire is drawn along, by wire number
let moving: { ids: Set<string>; dx: number; dy: number } | null = null;     // parts being dragged right now
let bending: { index: number; pts: Pt[] } | null = null;                  // a wire being reshaped right now
const ends = (w: Wire) => [w.from.slice(0, w.from.indexOf(':')), w.to.slice(0, w.to.indexOf(':'))];

/** The path a wire takes on the canvas now. */
function wirePath(wire: Wire, index: number, a: Pt, b: Pt, rects: Map<string, Rect>, sig: string): Pt[] {
  if (bending?.index === index) return bending.pts;
  const [p, q] = ends(wire);
  if (wire.points?.length) {
    const along = moving && moving.ids.has(p) && moving.ids.has(q) ? [moving.dx, moving.dy] : [0, 0];   // bends move with both its parts
    return bendPath(a, wire.points.map(([x, y]) => [x + ox + along[0], y + oy + along[1]] as Pt), b);
  }
  // While parts are being dragged, only the wires on them are routed again; the rest wait for the drop.
  if (moving && !moving.ids.has(p) && !moving.ids.has(q) && routes[index]?.length) {
    const old = routes[index];
    if (old[0][0] === a[0] && old[0][1] === a[1] && old.at(-1)![0] === b[0] && old.at(-1)![1] === b[1]) return old;
  }
  const key = `${a}|${b}|${p}|${q}|${sig}`;
  let pts = routeCache.get(key);
  if (!pts) {
    const own = [rects.get(p), rects.get(q)].filter((r): r is Rect => !!r);
    pts = autoRoute(a, b, [...rects.values()], { own });
    if (routeCache.size > 600) routeCache.clear();
    routeCache.set(key, pts);
  }
  return pts;
}

let meter: ElectricalMsg | null = null;   // the latest voltages and currents, while running
function wireTitle(i: number): string {
  const w = project.wires[i], m = meterText(meter, i, w.from, w.to);
  return `${w.from} → ${w.to}${state === 'running' ? '' : ' · drag to bend it'}` + (m ? `\n${m}` : '');
}
/** Refresh what each wire reads, and mark parts with an electrical problem, without redrawing. */
function drawMeter(): void {
  wiresSvg.querySelectorAll<SVGPathElement>('path.hit').forEach((h) => { const t = h.querySelector('title'), i = Number(h.dataset.wire); if (t && project.wires[i]) t.textContent = wireTitle(i); });
  for (const p of project.parts) document.querySelector(`[data-id="${CSS.escape(p.id)}"]`)?.classList.toggle('overloaded', meter?.parts[p.id] === 'warn');
}

function drawWires(): void {
  wiresSvg.replaceChildren();
  const rects = new Map<string, Rect>();
  for (const id of Object.keys(els)) { const r = outline(id); if (r) rects.set(id, r); }
  const sig = [...rects.values()].map((r) => `${r.x},${r.y},${r.w},${r.h}`).join(';');
  const next: Pt[][] = [];
  project.wires.forEach((wire, index) => {
    const a = pinPos(wire.from), b = pinPos(wire.to);
    if (!a || !b) return;
    const pts = wirePath(wire, index, a, b, rects, sig);
    next[index] = pts;
    const d = smoothPath(pts);
    const isSel = selected?.kind === 'wire' && selected.index === index;
    const g = document.createElementNS(SVG, 'g');
    g.setAttribute('class', 'w' + (isSel ? ' selected' : '') + (bending?.index === index ? ' bending' : ''));
    const halo = document.createElementNS(SVG, 'path');
    halo.setAttribute('d', d); halo.setAttribute('class', 'halo');
    const line = document.createElementNS(SVG, 'path');
    line.setAttribute('d', d); line.setAttribute('stroke', /^[a-zA-Z#][\w#]*$/.test(wire.color ?? '') ? wire.color! : 'gray');
    line.setAttribute('class', 'wire' + (isSel ? ' selected' : ''));
    const hit = document.createElementNS(SVG, 'path');
    hit.setAttribute('d', d); hit.setAttribute('class', 'hit');
    const title = document.createElementNS(SVG, 'title'); hit.append(title); hit.dataset.wire = String(index);
    title.textContent = wireTitle(index);
    const pick = () => { selectWire(index); layout(); drawInventory(); };
    // Where a wire lies over a part, the part wins: it can always be picked up, and the wire is clicked where it runs free.
    hit.addEventListener('pointerdown', (e) => { const id = partUnder(e); if (id) startDrag(e as PointerEvent, id); else startBend(e as PointerEvent, index); });
    hit.addEventListener('click', (e) => { e.stopPropagation(); if (bent) { bent = false; return; } if (state !== 'running' && !partUnder(e)) pick(); });
    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault(); if (state === 'running' || EMBED) return;
      const id = partUnder(e);
      if (id) { partMenu(e as MouseEvent, id); return; }
      pick();
      const items: MenuItem[] = [['Remove this wire', () => edit('removeWire', index), 'Del']];
      if (wire.points?.length) items.unshift(['Route it for me again', () => edit('setWirePoints', index, [])]);
      menu(e as MouseEvent, items, (c) => edit('setWireColor', index, c));
    });
    g.append(halo, line, hit);
    // A selected wire shows a grip on each run that can be dragged sideways.
    if (isSel && state !== 'running') for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      if (Math.hypot(x1 - x0, y1 - y0) < 24) continue;
      const grip = document.createElementNS(SVG, 'rect'), flat = y0 === y1;
      grip.setAttribute('x', String((x0 + x1) / 2 - (flat ? 7 : 3))); grip.setAttribute('y', String((y0 + y1) / 2 - (flat ? 3 : 7)));
      grip.setAttribute('width', flat ? '14' : '6'); grip.setAttribute('height', flat ? '6' : '14'); grip.setAttribute('rx', '3');
      grip.setAttribute('class', 'grip');
      g.append(grip);
    }
    wiresSvg.append(g);
  });
  routes = next;
  if (wireFrom) {
    const a = pinPos(wireFrom);
    if (a) {
      const rubber = document.createElementNS(SVG, 'path');
      rubber.setAttribute('d', smoothPath(simplify([a, [pointer[0], a[1]], pointer]))); rubber.setAttribute('class', 'rubber');
      wiresSvg.append(rubber);
    }
  }
}

/** Drag a wire sideways to bend it. Its ends stay on their pins; the bends are saved with the circuit. */
let bent = false;                // a bend just finished: the click that follows is not a selection
function startBend(e: PointerEvent, index: number): void {
  if (EMBED) return;
  if (state === 'running' || e.button !== 0 || wireFrom || !routes[index]) return;
  const start = at(e), base = routes[index].map((p) => [p[0], p[1]] as Pt), seg = nearestSegment(base, start);
  // Listen on the window: the wire's own element is redrawn (and so detached) on every move.
  let moved = false;
  const move = (ev: PointerEvent) => {
    const p = at(ev);
    if (!moved && Math.hypot(p[0] - start[0], p[1] - start[1]) < 4) return;
    if (!moved) { moved = true; selectWire(index); drawInventory(); }
    // Bends snap to the same grid as the parts, counted from the project's origin.
    const q: Pt = [snapTo(p[0] - ox, ev.altKey) + ox, snapTo(p[1] - oy, ev.altKey) + oy];
    bending = { index, pts: dragSegment(base, seg, q) };
    drawWires();
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    if (!moved || !bending) return;
    const pts = simplify(bending.pts).slice(1, -1).map(([x, y]) => [x - ox, y - oy]);
    bent = true; setTimeout(() => { bent = false; }, 0);
    edit('setWirePoints', index, pts);
    // Keep the new shape on show until the circuit comes back with it.
    setTimeout(() => { if (bending?.index === index) { bending = null; drawWires(); } }, 400);
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}

// ---------- wiring: click pin then pin, or press on one pin and release on another ----------
function pinDown(ref: string): void {
  if (EMBED) return;
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
let boxed = false;               // a drag-box selection just finished: the click that follows does not clear it
canvas.addEventListener('click', (e) => {
  if (e.target !== canvas) return;
  if (boxed) { boxed = false; return; }
  if (wireFrom) cancelWire(); else if (selected || group.size) { clearSelection(); layout(); drawInventory(); }
});

// ---------- right-click menu ----------
type MenuItem = [string, () => void, string?];
function swatches(pick: (color: string) => void): HTMLElement {
  const row = document.createElement('div'); row.className = 'swatches';
  for (const c of WIRE_COLORS) {
    const b = document.createElement('button'); b.style.background = c; b.title = c; b.setAttribute('aria-label', `Make it ${c}`);
    b.onclick = () => pick(c);
    row.append(b);
  }
  return row;
}
function menu(e: MouseEvent, items: MenuItem[], color?: (c: string) => void): void {
  const m = $('menu');
  m.replaceChildren(...items.map(([label, run, keys]) => {
    const b = document.createElement('button'); b.textContent = label; b.setAttribute('role', 'menuitem');
    if (keys) b.dataset.keys = keys;              // shown beside the label by the style sheet, not part of its text
    if (/^Remove/.test(label)) b.classList.add('danger');
    b.onclick = () => { m.hidden = true; run(); };
    return b;
  }));
  if (color) m.prepend(swatches((c) => { m.hidden = true; color(c); }));
  m.hidden = false;
  m.style.left = `${Math.min(e.clientX, window.innerWidth - m.offsetWidth - 4)}px`;
  m.style.top = `${Math.min(e.clientY, window.innerHeight - m.offsetHeight - 4)}px`;
  (m.querySelector('button[role=menuitem]') as HTMLElement | null)?.focus({ preventScroll: true });
}
/** The menu for a part: on its own, or for everything selected with it. */
function partMenu(e: MouseEvent, id: string): void {
  if (EMBED) return;
  if (!group.has(id)) selectParts([id]);
  layout(); drawInventory();
  if (group.size > 1) {
    const ids = [...group];
    menu(e, [['Duplicate', () => duplicate(), 'Ctrl+D'], ['Copy', () => copy(), 'Ctrl+C'], [`Remove ${ids.length} parts`, () => edit('removeParts', ids), 'Del']]);
    return;
  }
  menu(e, [['Rotate', () => edit('rotatePart', id), 'R'], ['Duplicate', () => duplicate(), 'Ctrl+D'], ['Copy', () => copy(), 'Ctrl+C'], [`Remove ${id}`, () => edit('removePart', id), 'Del']]);
}
window.addEventListener('pointerdown', (e) => { if (!$('menu').hidden && !$('menu').contains(e.target as Node)) $('menu').hidden = true; }, true);

// ---------- moving parts: one, or everything selected ----------
function startDrag(e: PointerEvent, id: string): void {
  if (EMBED) return;
  if (state === 'running' || e.button !== 0 || wireFrom) return;
  const el = els[id], part = project.parts.find((p) => p.id === id);
  if (!el || !part) return;
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    toggleSelected(id); layout(); drawInventory();
    if (!group.has(id)) return;
  } else if (!group.has(id)) selectParts([id]);
  else selected = { kind: 'part', id };
  const parts = selectedParts(), start = new Map(parts.map((p) => [p.id, [p.x, p.y] as const]));
  const x0 = e.clientX, y0 = e.clientY, px = part.x, py = part.y;
  let moved = false, dx = 0, dy = 0;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const rx = (ev.clientX - x0) / zoom, ry = (ev.clientY - y0) / zoom;
    if (!moved && Math.hypot(rx, ry) < 3) return;
    moved = true;
    // The part under the pointer lands on the grid; the rest keep their places around it.
    dx = snapTo(px + rx, ev.altKey) - px; dy = snapTo(py + ry, ev.altKey) - py;
    for (const p of parts) { const [sx, sy] = start.get(p.id)!; dx = Math.max(dx, -ox - sx); dy = Math.max(dy, -oy - sy); }
    for (const p of parts) { const [sx, sy] = start.get(p.id)!; p.x = sx + dx; p.y = sy + dy; place(els[p.id], p); }
    moving = { ids: new Set(parts.map((p) => p.id)), dx, dy };
    canvas.classList.add('dragging');
    layout();
  };
  const up = () => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    canvas.classList.remove('dragging');
    const was = moving; moving = null;
    if (!moved) return;
    if (!dx && !dy) { layout(); return; }
    if (parts.length === 1) edit('movePart', id, part.x, part.y);
    else edit('moveParts', [...(was?.ids ?? [])], dx, dy);
  };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  layout(); drawInventory();
}

// ---------- copy, paste, duplicate ----------
interface Clip { parts: Part[]; wires: Wire[] }
const CLIP_MIME = 'shibo-circuit';
let clip: Clip | null = null, pastes = 0;
function copied(): Clip | null {
  const parts = selectedParts();
  if (!parts.length) return null;
  const ids = new Set(parts.map((p) => p.id));
  return structuredClone({ parts, wires: project.wires.filter((w) => ends(w).every((x) => ids.has(x))) });
}
function copy(): boolean {
  const c = copied();
  if (!c) return false;
  clip = c; pastes = 0;
  hint(`Copied ${c.parts.length === 1 ? c.parts[0].id : `${c.parts.length} parts`}. Ctrl+V puts a copy in.`);
  return true;
}
function paste(what: Clip | null = clip): void {
  if (!what?.parts.length || state === 'running') return;
  pastes++;
  const off = GRID * 2 * pastes;
  adopt = new Set(project.parts.map((p) => p.id));
  edit('pasteParts', what, off, off);
}
function duplicate(): void {
  const c = copied();
  if (!c || state === 'running') return;
  adopt = new Set(project.parts.map((p) => p.id));
  edit('pasteParts', c, GRID * 2, GRID * 2);
}
const typingIn = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
// Through the system clipboard too, so a copy can go to another Shibo window. Text selected on the page copies as text.
document.addEventListener('copy', (e) => {
  if (typingIn(e.target) || String(window.getSelection() ?? '') || !copy()) return;
  e.clipboardData?.setData('text/plain', JSON.stringify({ [CLIP_MIME]: 1, ...clip }));
  e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (typingIn(e.target) || String(window.getSelection() ?? '') || state === 'running' || !copy()) return;
  e.clipboardData?.setData('text/plain', JSON.stringify({ [CLIP_MIME]: 1, ...clip }));
  e.preventDefault();
  edit('removeParts', clip!.parts.map((p) => p.id));
  pastes = -1;                // pasting after a cut puts it back where it was
});
document.addEventListener('paste', (e) => {
  if (typingIn(e.target)) return;
  let from: Clip | null = null;
  try {
    const raw = JSON.parse(e.clipboardData?.getData('text/plain') ?? '');
    if (raw?.[CLIP_MIME] === 1 && Array.isArray(raw.parts) && Array.isArray(raw.wires)) from = { parts: raw.parts, wires: raw.wires };
  } catch { /* not a circuit: use what was copied here */ }
  if (from && JSON.stringify(from) !== JSON.stringify(clip)) { clip = from; pastes = 0; }
  if (!clip) return;
  e.preventDefault(); paste();
});

// ---------- zoom ----------
function setZoom(z: number, about?: { clientX: number; clientY: number }): void {
  const old = zoom;
  zoom = Math.min(3, Math.max(0.4, Math.round(z * 10) / 10));
  try { localStorage.setItem('shibo.zoom', String(zoom)); } catch { /* the size is just not remembered */ }
  // Keep the point under the pointer (or the middle of the view) where it is.
  const r = stage.getBoundingClientRect(), fx = about ? about.clientX - r.left : stage.clientWidth / 2, fy = about ? about.clientY - r.top : stage.clientHeight / 2;
  const cx = (stage.scrollLeft + fx) / old, cy = (stage.scrollTop + fy) / old;
  layout(); drawBar();
  stage.scrollLeft = cx * zoom - fx; stage.scrollTop = cy * zoom - fy;
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
  stage.scrollTo({ left: 0, top: 0, behavior: calm() ? 'auto' : 'smooth' });
};

// ---------- the empty background: drag a box to select, or move around ----------
let spaceDown = false;
function pan(e: PointerEvent): void {
  const x0 = e.clientX, y0 = e.clientY, sx = stage.scrollLeft, sy = stage.scrollTop;
  stage.classList.add('panning');
  const move = (ev: PointerEvent) => { stage.scrollLeft = sx - (ev.clientX - x0); stage.scrollTop = sy - (ev.clientY - y0); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); stage.classList.remove('panning'); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
stage.addEventListener('pointerdown', (e) => {
  const empty = e.target === canvas || e.target === stage || e.target === $('sizer');
  // The middle button, or the left with Space held, always moves the view.
  if (e.button === 1 || (e.button === 0 && spaceDown)) { e.preventDefault(); pan(e); return; }
  if (e.button !== 0 || wireFrom || !empty) return;
  // While running nothing can be selected, so a drag just moves the view, as it always has.
  if (state === 'running' || EMBED) { pan(e); return; }
  const [x0, y0] = at(e), keep = e.shiftKey || e.ctrlKey || e.metaKey ? new Set(group) : new Set<string>();
  const box = document.createElement('div'); box.className = 'marquee';
  let moved = false;
  const move = (ev: PointerEvent) => {
    const [x1, y1] = at(ev);
    if (!moved && Math.hypot(x1 - x0, y1 - y0) * zoom < 4) return;
    if (!moved) { moved = true; canvas.append(box); }
    const r: Rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    // Anything the box touches is picked up.
    const hits = Object.keys(els).filter((id) => { const o = outline(id); return o && o.x < r.x + r.w && o.x + o.w > r.x && o.y < r.y + r.h && o.y + o.h > r.y; });
    selectParts([...new Set([...keep, ...hits])]);
    for (const [id, el] of Object.entries(els)) el.classList.toggle('selected', group.has(id));
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (!moved) return;
    box.remove(); boxed = true; setTimeout(() => { boxed = false; }, 0);
    layout(); drawInventory();
    if (group.size > 1) hint(`${group.size} parts selected: drag one to move them all, Ctrl+D duplicates, Delete removes.`);
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
stage.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1), e); }, { passive: false });
stage.addEventListener('scroll', () => drawMinimap());
new ResizeObserver(() => layout()).observe(stage);

// ---------- the map of a circuit too big for the window ----------
let mapFrame = 0;
function drawMinimap(): void {
  if (mapFrame) return;
  mapFrame = requestAnimationFrame(() => { mapFrame = 0; paintMinimap(); });
}
const MAP_W = 180, MAP_H = 120;
let mapScale = 1;
function paintMinimap(): void {
  const map = $('minimap') as HTMLCanvasElement;
  const [w, h] = extent;
  const big = project.parts.length > 0 && (w * zoom > stage.clientWidth + 8 || h * zoom > stage.clientHeight + 8);
  map.classList.toggle('show', big);
  if (!big) return;
  const k = (mapScale = Math.min(MAP_W / w, MAP_H / h)), dpr = window.devicePixelRatio || 1;
  const cw = Math.ceil(w * k), ch = Math.ceil(h * k);
  if (map.width !== Math.round(cw * dpr) || map.height !== Math.round(ch * dpr)) {
    map.width = Math.round(cw * dpr); map.height = Math.round(ch * dpr); map.style.width = `${cw}px`; map.style.height = `${ch}px`;
  }
  const g = map.getContext('2d');
  if (!g) return;
  const css = getComputedStyle(map), color = (v: string) => css.getPropertyValue(v).trim();
  g.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
  g.clearRect(0, 0, w, h);
  g.lineWidth = 2 / k; g.lineJoin = 'round';
  project.wires.forEach((wire, i) => {
    const pts = routes[i];
    if (!pts?.length) return;
    g.strokeStyle = /^[a-zA-Z#][\w#]*$/.test(wire.color ?? '') ? wire.color! : 'gray'; g.globalAlpha = 0.7;
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1]); g.stroke();
  });
  g.globalAlpha = 1;
  for (const id of Object.keys(els)) {
    const r = outline(id);
    if (!r) continue;
    g.fillStyle = group.has(id) ? color('--select') : color('--map-part');
    g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, 4 / k); g.fill();
  }
  // The part of the circuit the window shows now.
  const vx = stage.scrollLeft / zoom, vy = stage.scrollTop / zoom, vw = stage.clientWidth / zoom, vh = stage.clientHeight / zoom;
  g.fillStyle = color('--map-view'); g.strokeStyle = color('--select'); g.lineWidth = 1.5 / k;
  g.beginPath(); g.rect(vx, vy, vw, vh); g.fill(); g.stroke();
}
// Click or drag on the map to bring that part of the circuit into view.
$('minimap').addEventListener('pointerdown', (e) => {
  const map = $('minimap');
  map.setPointerCapture(e.pointerId);
  const go = (ev: PointerEvent) => {
    const r = map.getBoundingClientRect(), x = (ev.clientX - r.left) / mapScale, y = (ev.clientY - r.top) / mapScale;
    stage.scrollLeft = x * zoom - stage.clientWidth / 2; stage.scrollTop = y * zoom - stage.clientHeight / 2;
  };
  go(e);
  const up = () => { map.removeEventListener('pointermove', go); map.removeEventListener('pointerup', up); };
  map.addEventListener('pointermove', go); map.addEventListener('pointerup', up);
});

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const typing = typingIn(e.target);
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (mod && key === 's') { e.preventDefault(); if (dirty) link.send({ t: 'save' }); return; }
  if (typing || EMBED) return;
  if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) { if (!spaceDown) { spaceDown = true; stage.classList.add('pan-ready'); } e.preventDefault(); return; }
  if (mod && key === 'z') { e.preventDefault(); link.send({ t: e.shiftKey ? 'redo' : 'undo' }); return; }
  if (mod && key === 'y') { e.preventDefault(); link.send({ t: 'redo' }); return; }
  if (mod && key === 'a' && state !== 'running') { e.preventDefault(); selectParts(project.parts.map((p) => p.id)); layout(); drawInventory(); return; }
  if (mod && key === 'd') { e.preventDefault(); duplicate(); return; }
  if (e.key === 'Escape') { $('menu').hidden = true; if (wireFrom) cancelWire(); else if (selected || group.size) { clearSelection(); layout(); drawInventory(); } }
  if (group.size && state !== 'running' && !mod) {
    const parts = selectedParts(), unit = snap && !e.altKey ? GRID : 1;
    const step = e.shiftKey ? unit * 10 : unit, by: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (parts.length === 1 && key === 'r') { e.preventDefault(); edit('rotatePart', parts[0].id); return; }
    if (parts.length && by[e.key]) {
      e.preventDefault();
      if (parts.length === 1) edit('movePart', parts[0].id, parts[0].x + by[e.key][0], parts[0].y + by[e.key][1]);
      else edit('moveParts', parts.map((p) => p.id), by[e.key][0], by[e.key][1]);
      return;
    }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && (selected || group.size) && state !== 'running') {
    e.preventDefault();
    const s = selected, ids = [...group]; clearSelection();
    if (ids.length > 1) edit('removeParts', ids);
    else if (s?.kind === 'part') edit('removePart', s.id); else if (s?.kind === 'wire') edit('removeWire', s.index);
  }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; stage.classList.remove('pan-ready'); } });
window.addEventListener('blur', () => { spaceDown = false; stage.classList.remove('pan-ready'); });

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
  for (const log of document.querySelectorAll<HTMLElement>('pre.chat')) {
    const t = String(outputs[log.dataset.chat!]?.received ?? '');
    if (log.textContent !== t) { log.textContent = t; log.scrollTop = log.scrollHeight; }
  }
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
    if (c?.paint === 'tft') paintTft(el, o);
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
    const chat = entry(p.id)?.chat;
    if (!labelled.length && !chat) continue;
    const h = document.createElement('h3'); h.textContent = p.id; box.append(h);
    if (chat) {
      // A phone talking to the module: what the board sent, and a box to send back.
      const log = document.createElement('pre'); log.className = 'chat'; log.dataset.chat = p.id;
      log.textContent = String(lastOutputs[p.id]?.received ?? '');
      const say = document.createElement('input'); say.placeholder = 'Send from the phone (Enter)'; say.setAttribute('aria-label', `Send text to ${p.id}`);
      say.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (state !== 'running') { say.placeholder = 'Run the circuit first'; return; }
        link.send({ t: 'serial', part: p.id, text: say.value + '\n' }); say.value = '';
      });
      box.append(log, say);
    }
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
  const key = sel ? JSON.stringify([sel, part, sel.kind === 'wire' ? project.wires[sel.index] : null, state === 'running', [...group]]) : '';
  if ((!force && key === propsFor) || box.contains(document.activeElement)) return;      // do not rebuild under the user's hand
  propsFor = key;
  box.replaceChildren();
  const row = (label: string, control: HTMLElement): void => { const l = document.createElement('label'); const t = document.createElement('span'); t.textContent = label; l.append(t, control); box.append(l); };
  const locked = state === 'running';
  if (group.size > 1) {
    const kind = document.createElement('div'); kind.className = 'kind'; kind.textContent = `${group.size} parts selected`;
    const names = document.createElement('div'); names.className = 'ok'; names.textContent = [...group].join(', ');
    const actions = document.createElement('div'); actions.className = 'actions';
    const dup = document.createElement('button'); dup.textContent = 'Duplicate'; dup.title = 'Ctrl+D'; dup.disabled = locked; dup.onclick = () => duplicate();
    const del = document.createElement('button'); del.textContent = 'Remove'; del.disabled = locked; del.onclick = () => edit('removeParts', [...group]);
    actions.append(dup, del); box.append(kind, names, actions);
  } else if (part) {
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
    const dup = document.createElement('button'); dup.textContent = 'Duplicate'; dup.title = 'Ctrl+D'; dup.disabled = locked; dup.onclick = () => duplicate();
    const del = document.createElement('button'); del.textContent = 'Remove'; del.disabled = locked; del.onclick = () => edit('removePart', part.id);
    actions.append(rot, dup, del); box.append(actions);
  } else if (sel?.kind === 'wire' && project.wires[sel.index]) {
    const w = project.wires[sel.index], index = sel.index;
    const kind = document.createElement('div'); kind.className = 'kind'; kind.textContent = `Wire: ${w.from} → ${w.to}`;
    box.append(kind);
    if (!locked) {
      box.append(swatches((c) => edit('setWireColor', index, c)));
      const del = document.createElement('button'); del.textContent = 'Remove'; del.onclick = () => edit('removeWire', index);
      const actions = document.createElement('div'); actions.className = 'actions';
      if (w.points?.length) { const re = document.createElement('button'); re.textContent = 'Reroute'; re.title = 'Forget the bends and route it round the parts again'; re.onclick = () => edit('setWirePoints', index, []); actions.append(re); }
      else { const tip = document.createElement('div'); tip.className = 'ok'; tip.textContent = 'Drag the wire to bend it.'; box.append(tip); }
      actions.append(del); box.append(actions);
    }
  } else { const d = document.createElement('div'); d.className = 'ok'; d.textContent = 'Click a part or a wire to change its settings. Drag a box round parts to pick several.'; box.append(d); }
}

drawBar(); drawProblems(); drawControls(); drawInventory(); drawWelcome(); drawProps(true);
