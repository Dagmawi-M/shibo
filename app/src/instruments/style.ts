// Styles for the instruments, using the page's colour tokens so light, dark
// and VS Code themes all work.
export const STYLE = `
.inst-group { display: inline-flex; gap: 4px; align-items: center; }
.inst-group button { display: inline-flex; gap: 6px; align-items: center; }
.inst-group svg, .inst-icon svg { width: 16px; height: 16px; fill: currentColor; flex: none; }
.inst-open[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.inst-mute-btn { padding: 5px 8px; }
.inst-mute-btn.sounding { color: var(--accent); border-color: var(--accent); }
.inst-dock { position: fixed; z-index: 15; display: flex; flex-direction: column; background: var(--panel); color: var(--ink);
  border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 8px 28px #0003; overflow: hidden; }
.inst-dock[hidden] { display: none; }
.inst-dock.paused { border-color: var(--select); }
.inst-head { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.inst-icon { padding: 4px 7px; line-height: 0; }
.inst-close { line-height: 1; font-size: 16px; margin-left: auto; }
.inst-scrub { flex: 1; min-width: 60px; accent-color: var(--accent); }
.inst-clock { font: 12px ui-monospace, monospace; color: var(--mute); min-width: 9em; text-align: right; white-space: nowrap; }
.inst-tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--line); }
.inst-tab { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 6px 10px; color: var(--mute); }
.inst-tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
.inst-body { padding: 10px; overflow: auto; min-height: 0; flex: 1; }
.inst-analyzer { display: flex; flex-direction: column; gap: 8px; }
.inst-picker, .inst-controls { display: flex; flex-wrap: wrap; gap: 4px; }
.inst-chip { padding: 2px 8px; font: 12px ui-monospace, monospace; border-radius: 999px; }
.inst-chip[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.inst-plot { position: relative; min-height: 60px; }
.inst-plot canvas { display: block; width: 100%; cursor: crosshair; touch-action: none; }
.inst-tools { display: flex; gap: 4px; align-items: center; }
.inst-tools button { padding: 2px 10px; }
.inst-tools button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.inst-readout, .inst-mute, .inst-note, .inst-help { font-size: 12px; color: var(--mute); }
.inst-readout { margin-left: 6px; }
.inst-help { margin: 0 0 8px; line-height: 1.5; }
.inst-help code { font: 12px ui-monospace, monospace; color: var(--ink); }
.inst-text { width: 100%; box-sizing: border-box; font: 13px ui-monospace, monospace; color: var(--ink); background: var(--bg);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; resize: vertical; }
.inst-row { display: flex; gap: 10px; align-items: center; margin: 8px 0; }
.inst-note.bad { color: var(--warn); }
.inst-row .primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
@media (max-width: 600px) { .inst-open span { display: none; } .inst-clock { min-width: 0; } }
`;
