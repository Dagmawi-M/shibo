// The bench instruments on the page: buzzer sound, a pause and rewind
// timeline, a logic analyzer, the environment script, and live pin readings
// on hover. main.ts mounts this with one call and passes every message in.
import { Sound } from './sound.ts';
import { Analyzer, fmtTime, type Signal } from './analyzer.ts';
import { formatScript, parseScript, type ScriptStep } from '../../../engine/src/instruments/scripttext.ts';
import { STYLE } from './style.ts';

interface ControlDef { kind: 'momentary' | 'toggle' | 'range'; min?: number; max?: number; initial: number; label?: string; unit?: string }
export interface InstrumentHost {
  send(m: unknown): void;
  /** The page's own record of every control's value; the engine's changes are written into it. */
  values: Record<string, Record<string, number>>;
  /** Redraw the sensor sliders after values changed. */
  redrawControls(): void;
  project(): { parts: { id: string; type: string }[]; script?: ScriptStep[] };
  controlsOf(partId: string): Record<string, ControlDef>;
}
interface Reading { node: string; level: 0 | 1 | null; volts: number | null; freq: number | null; duty: number | null }

const OPEN_KEY = 'shibo.instruments', TAB_KEY = 'shibo.instruments.tab';
const ICON = {
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z"/></svg>',
  live: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5v9l5-4.5zM8.5 3.5v9l5-4.5z"/></svg>',
  sound: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  muted: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z"/><path d="M11 6l4 4M15 6l-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  scope: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 11h3V5h4v6h3V5h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
}
const fmtHz = (f: number) => (f >= 1000 ? `${Number((f / 1000).toFixed(2))} kHz` : `${Number(f.toPrecision(3))} Hz`);

/** What a pin is doing, in a few words. */
export function describe(r: Reading): string {
  if (r.freq !== null && r.duty !== null) return `toggling ${fmtHz(r.freq)} · ${Math.round(r.duty * 100)}% high`;
  const parts: string[] = [r.level === 1 ? 'HIGH' : r.level === 0 ? 'LOW' : 'floating'];
  if (r.volts !== null) parts.push(`${r.volts.toFixed(2)} V`);
  return parts.join(' · ');
}

export function mountInstruments(host: InstrumentHost): { onMessage(m: any): void } {
  const style = el('style'); style.textContent = STYLE; document.head.append(style);
  const sound = new Sound();
  let running = false, paused = false, fromMs = 0, toMs = 0, nowMs = 0;
  let open = false;
  try { open = localStorage.getItem(OPEN_KEY) === 'open'; } catch { /* closed */ }

  // ---- toolbar: open the instruments, mute the buzzer ----
  const bar = document.querySelector('header.bar') ?? document.querySelector('header') ?? document.body;
  const group = el('span', 'inst-group');
  const toggle = el('button', 'inst-open'); toggle.type = 'button';
  toggle.innerHTML = `${ICON.scope}<span>Instruments</span>`; toggle.title = 'Timeline, logic analyzer and environment script';
  const mute = el('button', 'inst-mute-btn'); mute.type = 'button';
  group.append(toggle, mute);
  bar.insertBefore(group, document.getElementById('status') ?? null);

  // ---- the dock ----
  const dock = el('section', 'inst-dock'); dock.setAttribute('aria-label', 'Instruments');
  const head = el('div', 'inst-head');
  const playBtn = el('button', 'inst-icon'); playBtn.type = 'button';
  const liveBtn = el('button', 'inst-icon'); liveBtn.type = 'button'; liveBtn.innerHTML = ICON.live; liveBtn.title = 'Back to now and carry on'; liveBtn.setAttribute('aria-label', liveBtn.title);
  const scrub = el('input', 'inst-scrub'); scrub.type = 'range'; scrub.min = '0'; scrub.max = '0'; scrub.step = '1'; scrub.setAttribute('aria-label', 'Simulated time: drag to go back');
  const clock = el('output', 'inst-clock');
  const close = el('button', 'inst-icon inst-close', '×'); close.type = 'button'; close.title = 'Hide the instruments'; close.setAttribute('aria-label', close.title);
  head.append(playBtn, liveBtn, scrub, clock, close);
  const tabs = el('div', 'inst-tabs'); tabs.setAttribute('role', 'tablist');
  const body = el('div', 'inst-body');
  const analyzer = new Analyzer((ids) => host.send({ t: 'watch', signals: ids }), (ms) => seek(ms));
  const scriptPane = el('div', 'inst-script');
  const panes: Record<string, [string, HTMLElement]> = { analyzer: ['Logic analyzer', analyzer.el], script: ['Environment', scriptPane] };
  let tab = 'analyzer';
  try { const t = localStorage.getItem(TAB_KEY); if (t && t in panes) tab = t; } catch { /* first tab */ }
  const tabBtns: Record<string, HTMLButtonElement> = {};
  for (const [id, [label]] of Object.entries(panes)) {
    const b = el('button', 'inst-tab', label); b.type = 'button'; b.setAttribute('role', 'tab');
    b.onclick = () => { tab = id; try { localStorage.setItem(TAB_KEY, id); } catch { /* not remembered */ } drawTabs(); };
    tabs.append(b); tabBtns[id] = b;
  }
  dock.append(head, tabs, body);
  document.body.append(dock);

  function drawTabs(): void {
    for (const [id, b] of Object.entries(tabBtns)) b.setAttribute('aria-selected', String(id === tab));
    body.replaceChildren(panes[tab][1]);
    if (tab === 'script') drawScript(false);
    analyzer.draw();
  }

  /** Sit over the bottom of the canvas, whatever the page layout around it is. */
  function place(): void {
    if (dock.hidden !== !open) dock.hidden = !open;
    if (toggle.getAttribute('aria-pressed') !== String(open)) toggle.setAttribute('aria-pressed', String(open));
    if (!open) return;
    const stage = document.getElementById('stage');
    const r = stage?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const w = Math.min(Math.max(280, r.width - 24), 880);
    dock.style.left = `${Math.max(8, r.left + 12)}px`; dock.style.width = `${Math.min(w, window.innerWidth - 16)}px`;
    dock.style.bottom = `${Math.max(8, window.innerHeight - r.bottom + 12)}px`;
    dock.style.maxHeight = `${Math.max(180, r.height - 24)}px`;
  }
  const setOpen = (v: boolean) => { open = v; try { localStorage.setItem(OPEN_KEY, v ? 'open' : 'closed'); } catch { /* not remembered */ } place(); if (v) analyzer.draw(); };
  toggle.onclick = () => setOpen(!open);
  close.onclick = () => setOpen(false);
  window.addEventListener('resize', place);
  const stage = document.getElementById('stage');
  if (stage) new ResizeObserver(place).observe(stage);
  // Panels elsewhere on the page can open and close (classes, hidden). React to those only, and at most
  // once a frame: placing the dock changes attributes too, which must not set off another placing.
  let queued = false;
  new MutationObserver((records) => {
    if (queued || records.every((r) => dock.contains(r.target) || toggle.contains(r.target))) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; place(); });
  }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'hidden'] });

  // ---- timeline ----
  function drawTimeline(): void {
    const can = running;
    playBtn.disabled = !can; scrub.disabled = !can; liveBtn.disabled = !can || !paused;
    playBtn.innerHTML = paused ? ICON.play : ICON.pause;
    playBtn.title = paused ? 'Carry on from here' : 'Pause the simulation'; playBtn.setAttribute('aria-label', playBtn.title);
    if (document.activeElement !== scrub || !paused) { scrub.min = String(Math.floor(fromMs)); scrub.max = String(Math.ceil(toMs)); scrub.value = String(Math.round(nowMs)); }
    const behind = paused && nowMs < toMs - 0.5;
    clock.textContent = !can ? 'Not running' : behind ? `${fmtTime(nowMs * 1e6)} of ${fmtTime(toMs * 1e6)}` : paused ? `Paused at ${fmtTime(nowMs * 1e6)}` : fmtTime(nowMs * 1e6);
    dock.classList.toggle('paused', paused && can);
    analyzer.setTime(nowMs * 1e6, toMs * 1e6, paused && can);
  }
  playBtn.onclick = () => host.send({ t: paused ? 'resume' : 'pause' });
  liveBtn.onclick = () => { host.send({ t: 'seek', ms: toMs }); host.send({ t: 'resume' }); };
  let seekTimer = 0, seekWant: number | null = null;
  function seek(ms: number): void {
    // Scrubbing sends many positions; the engine only needs the latest one at a time.
    seekWant = ms;
    if (seekTimer) return;
    seekTimer = window.setTimeout(function go() {
      seekTimer = 0;
      if (seekWant === null) return;
      host.send({ t: 'seek', ms: seekWant }); seekWant = null;
      seekTimer = window.setTimeout(go, 60);
    }, 0);
  }
  scrub.addEventListener('input', () => { nowMs = Number(scrub.value); paused = true; drawTimeline(); seek(nowMs); });

  // ---- mute ----
  function drawMute(): void {
    mute.innerHTML = sound.muted ? ICON.muted : ICON.sound;
    mute.title = sound.muted ? 'Buzzer sound is off: click to hear it' : 'Buzzer sound is on: click to mute';
    mute.setAttribute('aria-label', mute.title); mute.setAttribute('aria-pressed', String(sound.muted));
    mute.classList.toggle('sounding', sound.sounding && !sound.muted);
  }
  sound.onChange = drawMute;
  mute.onclick = () => sound.setMuted(!sound.muted);

  // ---- environment script ----
  const help = el('p', 'inst-help');
  help.innerHTML = 'Change what sensors sense on a schedule, from the start of each run. One step per line:<br><code>at 5s set ntc1.temperature to 40</code> · <code>at 2s ramp ntc1.temperature to 60 over 8s</code>';
  const area = el('textarea', 'inst-text'); area.spellcheck = false; area.rows = 6; area.setAttribute('aria-label', 'Environment script');
  area.placeholder = '# at 1s set ntc1.temperature to 30';
  const chips = el('div', 'inst-controls');
  const row = el('div', 'inst-row');
  const save = el('button', 'primary', 'Save script'); save.type = 'button';
  const note = el('span', 'inst-note'); note.setAttribute('role', 'status');
  row.append(save, note);
  scriptPane.append(help, area, row, chips);
  let savedText = '';
  function drawScript(force: boolean): void {
    const text = formatScript(host.project().script ?? []);
    if (force || area.value === savedText) area.value = text;
    savedText = text;
    dirtyScript();
    // What can be scripted in this circuit: click one to add a line for it.
    chips.replaceChildren();
    for (const p of host.project().parts) for (const [name, d] of Object.entries(host.controlsOf(p.id))) {
      if (!d.label && d.kind !== 'momentary') continue;
      const range = d.kind === 'range' ? `${d.min ?? 0} to ${d.max ?? 1}${d.unit ? ' ' + d.unit : ''}` : '0 or 1';
      const b = el('button', 'inst-chip', `${p.id}.${name}`); b.type = 'button'; b.title = `${d.label ?? name}: ${range}. Click to add a step.`;
      b.onclick = () => {
        const v = d.kind === 'range' ? d.max ?? 1 : 1;
        area.value = (area.value.trimEnd() ? area.value.trimEnd() + '\n' : '') + `at 1s set ${p.id}.${name} to ${v}`;
        area.focus(); dirtyScript();
      };
      chips.append(b);
    }
    if (!chips.childElementCount) chips.append(el('span', 'inst-mute', 'Add a sensor to the circuit to script what it senses.'));
  }
  function dirtyScript(): void {
    const changed = area.value.trim() !== savedText.trim();
    save.disabled = !changed;
    const { errors } = parseScript(area.value);
    note.classList.toggle('bad', errors.length > 0);
    note.textContent = errors[0] ?? (changed ? (running ? 'Saving stops the run; the script starts with the next one.' : 'Not saved yet.') : savedText ? 'Runs from the start of every run.' : '');
  }
  area.addEventListener('input', dirtyScript);
  save.onclick = () => {
    const { steps, errors } = parseScript(area.value);
    if (errors.length) { note.textContent = errors[0]; note.classList.add('bad'); return; }
    savedText = area.value;
    host.send({ t: 'edit', op: 'setScript', args: [steps] });
  };

  // ---- live pin readings on hover ----
  let hovering: { ref: string; dot: HTMLElement } | null = null, probeTimer = 0;
  document.addEventListener('pointerover', (e) => {
    const dot = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.pin');
    if (!dot?.dataset.ref || hovering?.dot === dot) return;
    hovering = { ref: dot.dataset.ref, dot };
    askProbe();
  });
  document.addEventListener('pointerout', (e) => {
    if (hovering && !(e.relatedTarget instanceof Node && hovering.dot.contains(e.relatedTarget))) { hovering = null; clearTimeout(probeTimer); }
  });
  function askProbe(): void {
    clearTimeout(probeTimer);
    if (!hovering || !running) return;
    host.send({ t: 'probe', node: hovering.ref });
    probeTimer = window.setTimeout(askProbe, 250);
  }
  function showReading(r: Reading): void {
    const tip = document.getElementById('tip');
    if (!hovering || hovering.ref !== r.node || !tip || tip.hidden) return;
    const i = r.node.indexOf(':');
    tip.textContent = `${r.node.slice(0, i)} · ${r.node.slice(i + 1)} · ${describe(r)}`;
    const d = hovering.dot.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(window.innerWidth - tip.offsetWidth - 4, d.left + d.width / 2 - tip.offsetWidth / 2))}px`;
  }

  drawTabs(); drawTimeline(); drawMute(); place();

  return {
    onMessage(m: any): void {
      switch (m?.t) {
        case 'project': drawScript(false); break;
        case 'status': {
          const was = running;
          running = m.state === 'running';
          document.body.classList.toggle('inst-running', running);
          if (running && !was) {
            paused = false; analyzer.clear();
            // A step at the very start must win over the slider position the page is about to send.
            for (const s of host.project().script ?? []) if (s.at === 0 && !s.over) (host.values[s.part] ??= {})[s.control] = s.value;
          }
          if (!running) { paused = false; sound.stopAll(); clearTimeout(probeTimer); }
          if (typeof m.timeMs === 'number' && running) nowMs = m.timeMs;
          drawTimeline(); dirtyScript();
          break;
        }
        case 'timeline': ({ fromMs, toMs, nowMs, paused } = m); drawTimeline(); break;
        case 'signals': analyzer.setSignals(m.list as Signal[]); break;
        case 'trace': analyzer.onTrace(m); break;
        case 'tones': sound.set(m.tones); break;
        case 'probe': showReading(m.reading); break;
        case 'controls': {
          for (const [part, vals] of Object.entries(m.values as Record<string, Record<string, number>>)) Object.assign(host.values[part] ??= {}, vals);
          host.redrawControls();
          break;
        }
      }
    },
  };
}
