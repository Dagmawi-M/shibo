// The ILI9341 240x320 colour TFT on SPI, as driven by Adafruit_ILI9341 and
// similar libraries: commands on D/C low, their parameters and pixels on D/C high.
import type { PartDef } from '../../part.ts';
import { powered } from '../util.ts';

const W = 240, H = 320;
const ARGS: Record<number, number> = { 0x2a: 4, 0x2b: 4, 0x36: 1, 0x3a: 1, 0x26: 1, 0x51: 1, 0xd9: 1, 0x33: 6, 0x37: 2, 0xb1: 2, 0xb6: 3, 0xc0: 1, 0xc1: 1, 0xc5: 2, 0xc7: 1, 0xe0: 15, 0xe1: 15, 0xf2: 1, 0xcf: 3, 0xed: 4, 0xe8: 3, 0xcb: 5, 0xf7: 1, 0xea: 2 };
const MY = 0x80, MX = 0x40, MV = 0x20, BGR = 0x08;

/** RGB565 pixels run-length coded as (count, colour) pairs, then base64: a mostly flat screen stays small. */
export function packFrame(px: Uint16Array): string {
  const out: number[] = [];
  for (let i = 0; i < px.length;) {
    const c = px[i]; let n = 1;
    while (i + n < px.length && px[i + n] === c && n < 65535) n++;
    out.push(n, c); i += n;
  }
  return Buffer.from(new Uint16Array(out).buffer).toString('base64');
}

const ili9341: PartDef = {
  type: 'ili9341', pins: ['VCC', 'GND', 'CS', 'RST', 'D/C', 'MOSI', 'SCK', 'LED', 'MISO'],
  ui: { label: 'Colour TFT (ILI9341)', tag: 'wokwi-ili9341', group: 'Displays', paint: 'tft' },
  links: () => [],
  check: (id, see) => (see.level(`${id}:VCC`) === 1 && see.level(`${id}:LED`) === null
    ? [`${id} pin LED is not connected, so its backlight is off and the screen looks dark. Wire LED to 5V (or to a pin, to dim it).`] : []),
  device(ctx) {
    const fresh = () => ({ awake: false, on: false, invert: false, madctl: 0, c0: 0, c1: W - 1, p0: 0, p1: H - 1, col: 0, page: 0, writing: false,
      cmd: -1, need: 0, args: [] as number[], half: -1, index: 0, reply: [] as number[], rst: 1 as number | null });
    let s = fresh();
    let px = new Uint16Array(W * H), rev = 0, packed = '', packedRev = -1;
    const fed = () => powered(ctx);
    /** Where a pixel at this column and page lands on the glass, given MADCTL. */
    const put = (c: number, p: number, colour: number): void => {
      const mv = s.madctl & MV;
      let a = mv ? p : c, b = mv ? c : p;
      if (a < 0 || a >= W || b < 0 || b >= H) return;
      if (s.madctl & MX) a = W - 1 - a;
      if (s.madctl & MY) b = H - 1 - b;
      // The panel's own column order is mirrored; Adafruit's rotation 0 sets MX to put it right.
      px[b * W + (W - 1 - a)] = s.madctl & BGR ? colour : ((colour & 0x1f) << 11) | (colour & 0x07e0) | (colour >> 11);
    };
    const run = (c: number, a: number[]): void => {
      switch (c) {
        case 0x01: { const keep = s.rst; s = fresh(); s.rst = keep; break; }            // software reset
        case 0x10: s.awake = false; break; case 0x11: s.awake = true; break;
        case 0x28: s.on = false; break; case 0x29: s.on = true; break;
        case 0x20: s.invert = false; break; case 0x21: s.invert = true; break;
        case 0x2a: s.c0 = (a[0] << 8) | a[1]; s.c1 = (a[2] << 8) | a[3]; break;
        case 0x2b: s.p0 = (a[0] << 8) | a[1]; s.p1 = (a[2] << 8) | a[3]; break;
        case 0x2c: s.col = s.c0; s.page = s.p0; s.writing = true; s.half = -1; break;
        case 0x3c: s.writing = true; s.half = -1; break;                                // write memory continue
        case 0x36: s.madctl = a[0]; break;
        case 0xd9: s.index = a[0] & 0x0f; break;                                         // which byte of the next read reply
      }
      rev++;
    };
    // What a read command answers, byte by byte (the first is the one Adafruit's readcommand8 asks for).
    const answer = (c: number): number[] => {
      if (c === 0x0a) return [0x08 | (s.awake ? 0x10 : 0) | (s.on ? 0x04 : 0) | 0x80];
      if (c === 0x0b) return [s.madctl];
      if (c === 0x0c) return [0x05];
      if (c === 0x0d) return [s.invert ? 0x20 : 0];
      if (c === 0x0f) return [0xc0];
      if (c === 0x04 || c === 0xd3) return [0x00, 0x00, 0x93, 0x41];
      return [];
    };
    const pixel = (v: number): void => {
      if (s.col > s.c1 || s.page > s.p1) return;
      put(s.col, s.page, v);
      if (++s.col > s.c1) { s.col = s.c0; if (++s.page > s.p1) s.page = s.p0; }
    };
    return {
      onChange() {
        // RST low holds the chip in reset: everything back to its power-on state.
        const r = ctx.level('RST');
        if (r === 0 && s.rst !== 0) { s = fresh(); rev++; }
        s.rst = r;
      },
      spi: {
        cs: 'CS', sck: 'SCK',
        transfer(b) {
          if (!fed() || s.rst === 0) return 0xff;
          if (ctx.level('D/C') !== 1) {
            s.writing = false; s.cmd = b; s.args = []; s.need = ARGS[b] ?? 0;
            const r = answer(b); s.reply = r.slice(s.index); if (b !== 0xd9) s.index = 0;
            if (!s.need) run(b, []);
            return 0xff;
          }
          if (s.writing) {
            if (s.half < 0) s.half = b; else { pixel((s.half << 8) | b); s.half = -1; rev++; }
            return 0xff;
          }
          if (s.need > 0) { s.args.push(b); if (--s.need === 0) run(s.cmd, s.args); return 0xff; }
          return s.reply.shift() ?? 0;
        },
      },
      outputs: () => ({ on: s.on && s.awake, powered: fed() }),
      display() {
        if (packedRev !== rev) { packed = packFrame(px); packedRev = rev; }
        return { frame: packed, on: fed() && s.on && s.awake && s.rst !== 0, invert: s.invert, backlight: fed() && ctx.level('LED') === 1 };
      },
      save: () => ({ s: structuredClone(s), px: px.slice() }),
      restore(x) { const v = x as { s: typeof s; px: Uint16Array }; s = structuredClone(v.s); px = v.px.slice(); rev++; },
    };
  },
};

export const tft: PartDef[] = [ili9341];
