// Share links and embeds on the page. The codec is engine/src/share.ts; this
// file is the Share menu, the "Open from link" box, and opening the link the
// page was loaded with. Everything stays in the browser and the local engine.
import { decodeShare, shareFromLink, shareUrl, embedSnippet, DEFAULT_BASE, ShareError } from '../../engine/src/share.ts';

/** True when the page was opened as an embed (`?embed=1`): a read-only view. */
export const EMBED = new URLSearchParams(location.search).get('embed') === '1';

interface Deps { send(m: unknown): void; hint(text: string): void; menu: HTMLElement; button: HTMLElement }

/** Where shared links point: this page when it has a web address, else the standalone app's usual one. */
function base(): string {
  return /^https?:$/.test(location.protocol) ? location.origin + location.pathname : DEFAULT_BASE;
}

export function mountShare(d: Deps) {
  let pending = shareFromLink(location.hash);           // the link this page was opened with, loaded once the engine is ready
  let want: 'link' | 'embed' | null = null;
  const box = document.createElement('dialog');
  box.id = 'share-box'; box.className = 'share-box';
  document.body.append(box);

  const show = (title: string, body: (HTMLElement | string)[]) => {
    box.replaceChildren();
    const h = document.createElement('h3'); h.textContent = title;
    const close = document.createElement('button'); close.textContent = 'Close'; close.className = 'share-close'; close.onclick = () => box.close();
    box.append(h, ...body, close);
    if (!box.open) box.showModal();
  };

  /** Show text ready to copy, and copy it if the browser lets us. */
  const offer = async (title: string, text: string, what: string) => {
    const area = document.createElement('textarea'); area.id = 'share-text'; area.readOnly = true; area.value = text; area.rows = 4;
    const note = document.createElement('p'); note.className = 'share-note';
    show(title, [area, note]);
    area.select();
    try { await navigator.clipboard.writeText(text); note.textContent = `Copied the ${what}. It holds the circuit and the sketch; whoever opens it needs Shibo running.`; }
    catch { note.textContent = `Select the ${what} above and copy it. It holds the circuit and the sketch.`; }
  };

  const openText = async (link: string, embed = false) => {
    const text = shareFromLink(link);
    if (!text) { d.hint('Could not open that link: it is not a Shibo share link (it should contain #p=v1.).'); return false; }
    try {
      const s = await decodeShare(text);
      d.send({ t: 'openShared', project: s.project, sketch: s.sketch, embed });
      return true;
    } catch (err) {
      d.hint(`Could not open that link: ${err instanceof ShareError ? err.message : 'it is damaged'}. Nothing here was changed.`);
      return false;
    }
  };

  const openBox = () => {
    const input = document.createElement('input'); input.id = 'share-paste'; input.placeholder = 'Paste a Shibo link'; input.setAttribute('aria-label', 'Shibo link');
    const go = document.createElement('button'); go.id = 'share-open'; go.className = 'primary'; go.textContent = 'Open';
    const note = document.createElement('p'); note.className = 'share-note';
    note.textContent = 'This replaces the circuit (Undo brings it back) and the sketch (the old one is kept in .shibo-backup).';
    go.onclick = async () => { if (await openText(input.value)) box.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    show('Open from link', [input, go, note]);
    input.focus();
  };

  d.button.onclick = (e) => {
    e.stopPropagation();
    const items: [string, string, () => void][] = [
      ['share-copy', 'Copy share link', () => { want = 'link'; d.send({ t: 'shareInfo' }); }],
      ['share-embed', 'Copy embed code', () => { want = 'embed'; d.send({ t: 'shareInfo' }); }],
      ['share-from', 'Open from link…', openBox],
    ];
    d.menu.replaceChildren(...items.map(([id, label, act]) => {
      const b = document.createElement('button'); b.id = id; b.setAttribute('role', 'menuitem'); b.textContent = label;
      b.onclick = () => { d.menu.hidden = true; act(); };
      return b;
    }));
    const r = d.button.getBoundingClientRect();
    d.menu.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 200))}px`; d.menu.style.top = `${r.bottom + 4}px`;
    d.menu.hidden = false;
  };

  if (EMBED && !pending) { document.body.classList.add('embed-blocked'); d.hint('This embed has no circuit in its link.'); }
  return {
    /** Every engine message passes through here first. */
    async onMessage(m: any) {
      if (m.t === 'project' && pending) {
        const text = pending; pending = null;
        if (!(await openText('#p=' + text, EMBED)) && !EMBED) history.replaceState(null, '', location.pathname + location.search);
      }
      if (m.t === 'shared') {
        if (EMBED) document.body.classList.toggle('embed-blocked', !m.ok);
        d.hint(m.ok ? m.message : `Could not open that link: ${m.message}`);
        // Done with the link: a reload must not open it again over later work.
        if (m.ok && !EMBED && location.hash) history.replaceState(null, '', location.pathname + location.search);
      }
      if (m.t === 'shareInfo' && want) {
        const kind = want; want = null;
        const s = { project: m.project, sketch: m.sketch };
        if (kind === 'link') await offer('Share link', await shareUrl(base(), s), 'link');
        else await offer('Embed code', embedSnippet(await shareUrl(base(), s, { embed: true })), 'embed code');
      }
    },
  };
}

/** The address of this circuit in the full editor, for an embed's "Open in Shibo" link. */
export function fullEditorUrl(): string {
  const u = new URL(location.href);
  u.searchParams.delete('embed');
  return u.toString();
}
