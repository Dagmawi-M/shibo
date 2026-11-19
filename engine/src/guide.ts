// A printable page that says what to buy and what to connect to what.
import { catalog } from './edit.ts';
import type { Project } from './project.ts';

const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const SAFE_COLOR = /^[a-zA-Z#][\w#]{0,31}$/;

export function generateGuide(project: Project, title: string): string {
  const label = (type: string) => catalog.find((c) => c.type === type)?.label ?? type.replace(/^unknown:/, '');
  const typeOf = new Map(project.parts.map((p) => [p.id, p.type]));
  const counts = new Map<string, string[]>();
  for (const p of project.parts) counts.set(label(p.type), [...(counts.get(label(p.type)) ?? []), p.id]);
  const end = (ref: string) => { const i = ref.indexOf(':'); return { id: ref.slice(0, i), pin: ref.slice(i + 1) }; };
  const rows = project.wires.map((w, n) => {
    const a = end(w.from), b = end(w.to), color = SAFE_COLOR.test(w.color ?? '') ? w.color! : 'gray';
    return `<tr class="wire"><td>${n + 1}</td><td><span class="dot" style="background:${esc(color)}"></span>${esc(color)}</td>` +
      `<td><b>${esc(a.id)}</b> <small>${esc(label(typeOf.get(a.id) ?? ''))}</small></td><td class="pin">${esc(a.pin)}</td>` +
      `<td><b>${esc(b.id)}</b> <small>${esc(label(typeOf.get(b.id) ?? ''))}</small></td><td class="pin">${esc(b.pin)}</td><td class="tick"></td></tr>`;
  }).join('\n');
  const parts = [...counts].map(([name, ids]) => `<tr><td>${ids.length}</td><td>${esc(name)}</td><td>${ids.map(esc).join(', ')}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}: wiring guide</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; color: #1c2330; background: #fff; max-width: 860px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 8px; } p { color: #556; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #dfe3e8; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #667085; }
  small { color: #667085; } .pin { font-family: ui-monospace, monospace; font-weight: 600; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; border: 1px solid #99a; margin-right: 6px; vertical-align: baseline; }
  .tick { width: 22px; } .tick::after { content: ""; display: block; width: 14px; height: 14px; border: 1.5px solid #667085; border-radius: 3px; }
  .wrap { overflow-x: auto; }
  @media print { body { padding: 0; } tr { break-inside: avoid; } }
</style></head><body>
<h1>${esc(title)}</h1>
<p>Wiring guide made by Shibo. Tick each wire as you connect it. Wire with the power unplugged.</p>
<h2>Parts (${project.parts.length})</h2>
<div class="wrap"><table><thead><tr><th>Qty</th><th>Part</th><th>Named in the circuit</th></tr></thead><tbody>
${parts || '<tr><td colspan="3">No parts yet.</td></tr>'}
</tbody></table></div>
<h2>Connections (${project.wires.length})</h2>
<div class="wrap"><table><thead><tr><th>#</th><th>Wire</th><th>From</th><th>Pin</th><th>To</th><th>Pin</th><th>Done</th></tr></thead><tbody>
${rows || '<tr><td colspan="7">No wires yet.</td></tr>'}
</tbody></table></div>
</body></html>
`;
}
