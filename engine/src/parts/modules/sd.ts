// A microSD card module on SPI, holding a small FAT16 card in memory.
// It speaks the SD card's SPI mode closely enough for the Arduino SD library:
// CMD0/8/55/41/58 to start, CMD9/10 for card info, CMD17/18 to read,
// CMD24/25 to write, CMD12 and CMD13. The card reports itself as SDHC,
// so blocks are addressed by number.
import type { PartDef } from '../../part.ts';
import { powered } from '../util.ts';

const BLOCKS = 5120;                 // 2.5 MB: the smallest size that is still FAT16 at one block per cluster
const RESERVED = 1, FATS = 2, FAT_BLOCKS = 20, ROOT_ENTRIES = 512;
const ROOT_START = RESERVED + FATS * FAT_BLOCKS, DATA_START = ROOT_START + (ROOT_ENTRIES * 32) / 512;

type Disk = Map<number, Uint8Array>;
const u16 = (b: Uint8Array, at: number, v: number) => { b[at] = v & 255; b[at + 1] = (v >> 8) & 255; };
const u32 = (b: Uint8Array, at: number, v: number) => { u16(b, at, v & 0xffff); u16(b, at + 2, v >>> 16); };
const r16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const r32 = (b: Uint8Array, at: number) => (r16(b, at) | (r16(b, at + 2) << 16)) >>> 0;

/** A freshly formatted card. Blocks never written read as zeros and are not stored. */
function format(): Disk {
  const d: Disk = new Map();
  const boot = new Uint8Array(512);
  boot.set([0xeb, 0x3c, 0x90], 0); boot.set([...'SHIBO   '].map((c) => c.charCodeAt(0)), 3);
  u16(boot, 11, 512); boot[13] = 1; u16(boot, 14, RESERVED); boot[16] = FATS; u16(boot, 17, ROOT_ENTRIES);
  u16(boot, 19, BLOCKS); boot[21] = 0xf8; u16(boot, 22, FAT_BLOCKS); u16(boot, 24, 32); u16(boot, 26, 64);
  boot[36] = 0x80; boot[38] = 0x29; u32(boot, 39, 0x5348_4942);
  boot.set([...'SHIBO SD   FAT16   '].map((c) => c.charCodeAt(0)), 43);
  boot[510] = 0x55; boot[511] = 0xaa;
  d.set(0, boot);
  for (let f = 0; f < FATS; f++) { const fat = new Uint8Array(512); u16(fat, 0, 0xfff8); u16(fat, 2, 0xffff); d.set(RESERVED + f * FAT_BLOCKS, fat); }
  return d;
}

const block = (d: Disk, n: number) => d.get(n) ?? new Uint8Array(512);
const fatEntry = (d: Disk, c: number) => r16(block(d, RESERVED + (c >> 8)), (c & 255) * 2);
function setFat(d: Disk, c: number, v: number) {
  for (let f = 0; f < FATS; f++) { const n = RESERVED + f * FAT_BLOCKS + (c >> 8), b = block(d, n).slice(); u16(b, (c & 255) * 2, v); d.set(n, b); }
}

/** 8.3 name as stored in a directory entry, from "data.txt". */
const shortName = (name: string) => {
  const [base, ext = ''] = name.toUpperCase().split('.');
  return base.slice(0, 8).padEnd(8) + ext.slice(0, 3).padEnd(3);
};

/** Puts a file in the root folder (used for files a project starts with). */
export function addFile(d: Disk, name: string, data: Uint8Array): void {
  const root = ROOT_START;
  let slot = -1;
  for (let i = 0; i < ROOT_ENTRIES && slot < 0; i++) { const b = block(d, root + (i >> 4)); if (b[(i & 15) * 32] === 0 || b[(i & 15) * 32] === 0xe5) slot = i; }
  if (slot < 0) return;
  let first = 0, prev = 0;
  for (let off = 0, c = 2; off < data.length; off += 512) {
    while (fatEntry(d, c) !== 0) c++;
    if (c >= 2 + BLOCKS - DATA_START) return;
    const b = new Uint8Array(512); b.set(data.subarray(off, off + 512)); d.set(DATA_START + c - 2, b);
    setFat(d, c, 0xffff); if (prev) setFat(d, prev, c); else first = c;
    prev = c;
  }
  const n = root + (slot >> 4), b = block(d, n).slice(), at = (slot & 15) * 32;
  b.fill(0, at, at + 32);
  b.set([...shortName(name)].map((ch) => ch.charCodeAt(0)), at); b[at + 11] = 0x20;
  u16(b, at + 26, first); u32(b, at + 28, data.length);
  d.set(n, b);
}

/** The files in the root folder, with their contents. */
export function listFiles(d: Disk): { name: string; size: number; data: Uint8Array }[] {
  const out: { name: string; size: number; data: Uint8Array }[] = [];
  for (let i = 0; i < ROOT_ENTRIES; i++) {
    const b = block(d, ROOT_START + (i >> 4)), at = (i & 15) * 32;
    if (b[at] === 0) break;
    if (b[at] === 0xe5 || b[at + 11] & 0x18) continue;          // deleted, volume label or folder
    const raw = String.fromCharCode(...b.subarray(at, at + 11));
    const name = raw.slice(0, 8).trimEnd() + (raw.slice(8).trim() ? '.' + raw.slice(8).trim() : '');
    const size = r32(b, at + 28), data = new Uint8Array(size);
    for (let c = r16(b, at + 26), off = 0; c >= 2 && c < 0xfff8 && off < size; c = fatEntry(d, c), off += 512)
      data.set(block(d, DATA_START + c - 2).subarray(0, Math.min(512, size - off)), off);
    out.push({ name, size, data });
  }
  return out;
}

// Card registers, as a 2.5 MB SDHC card would give them.
const CID = [0x03, 0x53, 0x44, 0x53, 0x48, 0x49, 0x42, 0x4f, 0x10, 0x00, 0x00, 0x00, 0x01, 0x01, 0xa8, 0x01];
const C_SIZE = BLOCKS / 1024 - 1;
const CSD = [0x40, 0x0e, 0x00, 0x32, 0x5b, 0x59, 0x00, (C_SIZE >> 16) & 0x3f, (C_SIZE >> 8) & 255, C_SIZE & 255, 0x7f, 0x80, 0x0a, 0x40, 0x00, 0x01];
const DATA = (bytes: Uint8Array | number[]) => [0xfe, ...bytes, 0xff, 0xff];

const microsd: PartDef = {
  type: 'microsd', pins: ['CD', 'DO', 'GND', 'SCK', 'VCC', 'DI', 'CS'],
  ui: { label: 'microSD card', tag: 'wokwi-microsd-card', group: 'Modules' },
  attrs: ['files'],
  controls: { inserted: { kind: 'toggle', initial: 1, label: 'Card inserted' } },
  links: () => [],
  device(ctx) {
    const start = (): Disk => {
      const d = format();
      // attrs.files: JSON of name -> text, the files the card starts with.
      try { for (const [n, t] of Object.entries(JSON.parse(ctx.attrs.files || '{}') as Record<string, string>)) addFile(d, n, new TextEncoder().encode(String(t))); } catch { /* bad JSON: an empty card */ }
      return d;
    };
    let disk = start();
    let s = { idle: true, app: false, cmd: [] as number[], out: [] as number[], wr: null as null | { at: number; multi: boolean; buf: number[] | null }, rd: -1, rev: 0 };
    const here = () => powered(ctx) && ctx.control('inserted') === 1;
    const reply = (...b: number[]) => { s.out.push(0xff, ...b); };
    const command = (c: number, arg: number): void => {
      const app = s.app; s.app = false;
      const r1 = s.idle ? 1 : 0;
      if (c === 0) { s.idle = true; s.rd = -1; s.wr = null; return reply(1); }
      if (c === 8) return reply(r1, 0, 0, 1, arg & 255);
      if (c === 55) { s.app = true; return reply(r1); }
      if (app && c === 41) { s.idle = false; return reply(0); }
      if (c === 58) return reply(r1, 0xc0, 0xff, 0x80, 0x00);
      if (s.idle) return reply(1 | 4);
      if (c === 9) return reply(0, ...DATA(CSD));
      if (c === 10) return reply(0, ...DATA(CID));
      if (c === 13) return reply(0, 0);
      if (c === 12) { s.rd = -1; s.out = []; return reply(0xff, 0, 0xff); }
      if (c === 16) return reply(0);
      if (arg >= BLOCKS && (c === 17 || c === 18 || c === 24 || c === 25)) return reply(0x40);
      if (c === 17) return reply(0, ...DATA(block(disk, arg)));
      if (c === 18) { s.rd = arg; return reply(0); }
      if (c === 24 || c === 25) { s.wr = { at: arg, multi: c === 25, buf: null }; return reply(0); }
      if (app && c === 23) return reply(0);
      reply(4);                                                    // illegal command
    };
    const take = (b: number): void => {
      const w = s.wr!;
      if (!w.buf) {
        if (b === 0xfe || (w.multi && b === 0xfc)) w.buf = [];
        else if (w.multi && b === 0xfd) { s.wr = null; s.out.push(0xff, 0x00, 0xff); }
        return;
      }
      w.buf.push(b);
      if (w.buf.length < 514) return;
      disk.set(w.at, Uint8Array.from(w.buf.slice(0, 512))); s.rev++;
      s.out.push(0x05, 0x00, 0x00);                                 // accepted, then busy for a moment
      if (w.multi && w.at + 1 < BLOCKS) s.wr = { at: w.at + 1, multi: true, buf: null }; else s.wr = null;
    };
    return {
      onChange() {
        // Letting go of CS ends whatever reply was being clocked out.
        if (ctx.level('CS') !== 0 && s.out.length && !s.wr) s.out = [];
        if (!here() && !s.idle) { s.idle = true; s.out = []; s.cmd = []; s.wr = null; s.rd = -1; }
      },
      spi: {
        cs: 'CS', sck: 'SCK',
        transfer(b) {
          if (!here()) return 0xff;
          const out = s.out.length ? s.out.shift()! : 0xff;
          if (s.cmd.length || (b & 0xc0) === 0x40 && !s.wr?.buf) {
            s.cmd.push(b);
            if (s.cmd.length === 6) {
              const [c, a, bb, cc, dd] = s.cmd; s.cmd = [];
              s.out = [];
              command(c & 0x3f, ((a << 24) | (bb << 16) | (cc << 8) | dd) >>> 0);
            }
            return out;
          }
          if (s.wr) { take(b); return out; }
          if (s.rd >= 0 && !s.out.length) { s.out.push(...DATA(block(disk, s.rd))); s.rd = (s.rd + 1) % BLOCKS; }
          return out;
        },
      },
      outputs: () => ({ powered: powered(ctx), inserted: ctx.control('inserted') === 1 }),
      display() {
        const files = listFiles(disk).map((f) => `${f.name} (${f.size} bytes)`);
        return { powered: powered(ctx), inserted: ctx.control('inserted') === 1, files: files.join('\n') };
      },
      save: () => ({ s: structuredClone(s), disk: [...disk].map(([k, v]) => [k, v.slice()] as const) }),
      restore(x) {
        const v = x as { s: typeof s; disk: [number, Uint8Array][] };
        s = structuredClone(v.s); disk = new Map(v.disk.map(([k, b]) => [k, b.slice()]));
      },
    };
  },
};

export const sd: PartDef[] = [microsd];
