// Share links: a whole project (circuit and sketch) packed into a URL
// fragment, so it travels with no server, account or network. The fragment
// never leaves the browser: it is not sent in any request.
//
//   #p=v1.<base64url of deflate-raw of JSON {project, sketch}>
//
// This file is pure (no engine imports) so the page can use it too. What it
// decodes is only shaped, not trusted: the project still goes through
// parseProject before the engine sees it.

export const SHARE_VERSION = 'v1';
/** The most text a decoded link may expand to (guards against a tiny link that inflates to gigabytes). */
export const MAX_SHARE_BYTES = 1 << 20;
/** The longest sketch a link may carry. */
export const MAX_SKETCH = 256 * 1024;
/** The link a share is opened from when the page has no address of its own (a VS Code panel). */
export const DEFAULT_BASE = 'http://127.0.0.1:8190/';

export interface Shared { project: unknown; sketch: string | null }

/** Why a link could not be opened, in words for the person holding it. */
export class ShareError extends Error {}

const enc = new TextEncoder();

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await out.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await out.cancel().catch(() => {}); throw new ShareError('this link expands to more than a project can be'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return all;
}

function toBase64url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(t: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(t)) throw new ShareError('this link has characters a Shibo link never has; it may have been cut or changed');
  const s = atob(t.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Pack a project and its sketch into the text after `#p=`. */
export async function encodeShare(s: Shared): Promise<string> {
  const json = JSON.stringify({ project: s.project, sketch: s.sketch ?? null });
  return `${SHARE_VERSION}.${toBase64url(await pipe(enc.encode(json), new CompressionStream('deflate-raw')))}`;
}

/** Unpack the text after `#p=`. Throws ShareError, with a reason fit to show, for anything that is not a whole v1 link. */
export async function decodeShare(text: string): Promise<Shared> {
  const m = /^v(\d+)\.(.*)$/s.exec(text.trim());
  if (!m) throw new ShareError('this is not a Shibo share link');
  if (`v${m[1]}` !== SHARE_VERSION) throw new ShareError(`this link was made by a newer Shibo (format v${m[1]}); update Shibo to open it`);
  if (!m[2]) throw new ShareError('this link is empty; it may have been cut short');
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(await pipe(fromBase64url(m[2]), new DecompressionStream('deflate-raw'), MAX_SHARE_BYTES));
  } catch (err) {
    if (err instanceof ShareError) throw err;
    throw new ShareError('this link is damaged or cut short; ask for it again');
  }
  let raw: any;
  try { raw = JSON.parse(json); } catch { throw new ShareError('this link is damaged or cut short; ask for it again'); }
  if (!raw || typeof raw !== 'object' || !raw.project || typeof raw.project !== 'object') throw new ShareError('this link holds no project');
  if (raw.sketch != null && typeof raw.sketch !== 'string') throw new ShareError('the sketch in this link is not text');
  if (typeof raw.sketch === 'string' && raw.sketch.length > MAX_SKETCH) throw new ShareError('the sketch in this link is too long');
  return { project: raw.project, sketch: raw.sketch ?? null };
}

/** A full link: `base` (any page address; its own fragment is dropped) plus the share. */
export async function shareUrl(base: string, s: Shared, opts: { embed?: boolean } = {}): Promise<string> {
  const u = new URL(base);
  u.hash = '';
  if (opts.embed) u.searchParams.set('embed', '1'); else u.searchParams.delete('embed');
  return `${u.toString()}#p=${await encodeShare(s)}`;
}

/** The share text in a link or fragment (`...#p=v1.xxx`, `#p=...`, or the bare `v1.xxx`), or null if it has none. */
export function shareFromLink(link: string): string | null {
  const t = link.trim();
  const i = t.indexOf('#');
  const frag = i >= 0 ? t.slice(i + 1) : t;
  const p = new URLSearchParams(frag).get('p');
  if (p) return p;
  return /^v\d+\./.test(frag) ? frag : null;
}

/** A ready iframe snippet for an embed link. */
export function embedSnippet(url: string, width = 720, height = 480): string {
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<iframe src="${safe}" width="${width}" height="${height}" style="border:1px solid #ccc;border-radius:6px" title="Shibo circuit" loading="lazy"></iframe>`;
}
