// Paints frames the engine sends for the modules' screens onto their drawings.

/** The ILI9341 frame: base64 of (count, RGB565 colour) pairs covering 240x320 pixels. */
export function paintTft(el: any, o: Record<string, unknown>): void {
  const frame = typeof o.frame === 'string' ? o.frame : '';
  // Backlight off is black; a panel that is lit but not switched on (not yet set up, or DISPOFF) shows white.
  const mode = !o.backlight ? 'dark' : !o.on || !frame ? 'blank' : o.invert ? 'invert' : 'on';
  const key = mode + (mode === 'on' || mode === 'invert' ? frame : '');
  const canvas: HTMLCanvasElement | undefined = el.canvas;
  if (!canvas || el.__tft === key) return;
  el.__tft = key;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = 240; canvas.height = 320;
  if (mode === 'dark' || mode === 'blank') { ctx.fillStyle = mode === 'dark' ? '#000' : '#f4f4f4'; ctx.fillRect(0, 0, 240, 320); return; }
  const bin = atob(frame), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pairs = new Uint16Array(bytes.buffer, 0, bytes.length >> 1), img = new ImageData(240, 320), d = img.data, flip = mode === 'invert' ? 255 : 0;
  let at = 0;
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const c = pairs[i + 1], r = (((c >> 11) & 31) * 255 / 31) ^ flip, g = (((c >> 5) & 63) * 255 / 63) ^ flip, b = ((c & 31) * 255 / 31) ^ flip;
    for (let n = pairs[i]; n > 0 && at < d.length; n--, at += 4) { d[at] = r; d[at + 1] = g; d[at + 2] = b; d[at + 3] = 255; }
  }
  ctx.putImageData(img, 0, 0);
}
