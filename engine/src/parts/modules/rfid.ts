// MFRC522 (RC522) RFID reader on SPI, with MIFARE Classic 1K cards tapped from the panel.
// The chip's registers, FIFO, CRC coprocessor and commands are modelled as the MFRC522
// Arduino library uses them; the cards answer REQA/WUPA, anticollision and select,
// HLTA, authentication (key A or B, checked against the sector trailer), read and write.
// The radio itself is instant, except that a missing card times out after 25 ms as the
// library's timer setting makes the real chip do.
import type { PartDef } from '../../part.ts';
import { keep } from '../util.ts';

// Registers, as the datasheet numbers them.
const R = { Command: 0x01, ComIrq: 0x04, DivIrq: 0x05, Error: 0x06, Status2: 0x08, FIFOData: 0x09, FIFOLevel: 0x0a, Control: 0x0c, BitFraming: 0x0d, Coll: 0x0e, TxControl: 0x14, CRCH: 0x21, CRCL: 0x22, Version: 0x37 };
const CMD = { Idle: 0x00, CalcCRC: 0x03, Transceive: 0x0c, MFAuthent: 0x0e, SoftReset: 0x0f };

/** Cards that can be tapped: four-byte UIDs and what the library calls them. */
export const CARDS = [
  { uid: [0xde, 0xad, 0xbe, 0xef], name: 'White card' },
  { uid: [0x12, 0x34, 0x56, 0x78], name: 'Blue key fob' },
  { uid: [0xa1, 0xb2, 0xc3, 0xd4], name: 'Second white card' },
];

/** CRC_A (ISO 14443-3), low byte first, as the chip's coprocessor computes it with preset 0x6363. */
export function crcA(data: number[]): [number, number] {
  let c = 0x6363;
  for (const b of data) { let x = b ^ (c & 0xff); x = (x ^ (x << 4)) & 0xff; c = ((c >> 8) ^ (x << 8) ^ (x << 3) ^ (x >> 4)) & 0xffff; }
  return [c & 0xff, c >> 8];
}

const hex = (b: number[]) => b.map((v) => v.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => (s.match(/../g) ?? []).map((h) => parseInt(h, 16));

/** A block as a fresh card holds it: block 0 has the UID, trailers have keys of all FF. */
function blank(card: number, block: number): number[] {
  if (block === 0) { const u = CARDS[card].uid; return [...u, u[0] ^ u[1] ^ u[2] ^ u[3], 0x08, 0x04, 0x00, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69]; }
  if (block % 4 === 3) return [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x07, 0x80, 0x69, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  return Array(16).fill(0);
}

type CardState = 'idle' | 'ready' | 'active' | 'halt';

const rc522: PartDef = {
  type: 'rc522', pins: ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3.3V'],
  ui: { label: 'RFID reader (RC522)', tag: 'shibo-rc522', group: 'Modules' },
  controls: {
    present: { kind: 'toggle', initial: 0, label: 'Card on reader' },
    card: { kind: 'range', min: 1, max: CARDS.length, initial: 1, step: 1, label: 'Which card' },
  },
  links: () => [],
  device(ctx) {
    const s = {
      reg: Array<number>(64).fill(0), fifo: [] as number[], addr: -1, read: false,
      // The card in the field: which one, what it is doing, the sector it has authenticated, its memory (hex per changed block).
      card: -1, cstate: 'idle' as CardState, authSector: -1, pendingWrite: -1, mem: {} as Record<string, string>, on: false, job: 0,
    };
    const resetRegs = () => {
      s.reg.fill(0); s.fifo = []; s.reg[R.Version] = 0x92; s.reg[R.ComIrq] = 0x14;
      s.reg[R.Control] = 0x10; s.reg[R.TxControl] = 0x80; s.reg[R.Coll] = 0x80;
    };
    resetRegs();
    const powered = () => ctx.level('3.3V') === 1 && ctx.level('GND') === 0 && ctx.level('RST') !== 0;
    const cardHere = () => (s.reg[R.TxControl] & 0x03) !== 0 && ctx.control('present') ? Math.round(ctx.control('card')) - 1 : -1;
    const block = (n: number): number[] => { const k = `${s.card}:${n}`; return s.mem[k] ? unhex(s.mem[k]) : blank(s.card, n); };
    const irq = (bits: number) => { s.reg[R.ComIrq] |= bits; };

    /** What the card in the field answers to a frame, or null for silence. `bits`: valid bits in the last byte sent. */
    const answer = (f: number[], bits: number): { data: number[]; bits?: number } | null => {
      if (s.card < 0) return null;
      const u = CARDS[s.card].uid, bcc = u[0] ^ u[1] ^ u[2] ^ u[3];
      if (bits === 7 && f.length === 1) {
        if (f[0] === 0x26 && s.cstate === 'idle' || f[0] === 0x52 && (s.cstate === 'idle' || s.cstate === 'halt')) { s.cstate = 'ready'; s.authSector = -1; return { data: [0x04, 0x00] }; }
        return null;
      }
      if (s.cstate === 'ready' && f[0] === 0x93) {
        if (f[1] === 0x20 && f.length === 2) return { data: [...u, bcc] };
        if (f[1] === 0x70 && f.length === 9 && hex(f.slice(2, 7)) === hex([...u, bcc])) { s.cstate = 'active'; const sak = [0x08]; return { data: [...sak, ...crcA(sak)] }; }
        return null;
      }
      if (s.cstate !== 'active') return null;
      // Everything below carries a CRC; a bad one is ignored, as the card would.
      if (s.pendingWrite >= 0) {
        const n = s.pendingWrite; s.pendingWrite = -1;
        if (f.length !== 18 || hex(crcA(f.slice(0, 16))) !== hex(f.slice(16))) return { data: [0x0], bits: 4 };
        if (n !== 0) s.mem[`${s.card}:${n}`] = hex(f.slice(0, 16));
        return { data: [0x0a], bits: 4 };
      }
      if (f.length < 3 || hex(crcA(f.slice(0, -2))) !== hex(f.slice(-2))) return null;
      const body = f.slice(0, -2);
      if (body[0] === 0x50) { s.cstate = 'halt'; s.authSector = -1; s.reg[R.Status2] &= ~0x08; return null; }
      if ((body[0] === 0x30 || body[0] === 0xa0) && body[1] < 64) {
        if (s.authSector !== body[1] >> 2) { s.cstate = 'idle'; return { data: [0x4], bits: 4 }; }
        if (body[0] === 0xa0) { s.pendingWrite = body[1]; return { data: [0x0a], bits: 4 }; }
        const d = block(body[1]);
        // A read never shows key A; it reads as zeros. The access bits shown are the factory ones.
        if (body[1] % 4 === 3) d.fill(0, 0, 6);
        return { data: [...d, ...crcA(d)] };
      }
      return null;
    };

    const run = (cmd: number): void => {
      const job = ++s.job;
      if (cmd === CMD.SoftReset) { resetRegs(); s.reg[R.Command] = 0x10; ctx.after(50e3, () => { if (s.job === job) s.reg[R.Command] = 0; }); return; }
      if (cmd === CMD.CalcCRC) { const [lo, hi] = crcA(s.fifo); s.reg[R.CRCL] = lo; s.reg[R.CRCH] = hi; s.reg[R.DivIrq] |= 0x04; return; }
      if (cmd === CMD.MFAuthent) {
        const f = s.fifo.splice(0); s.reg[R.Command] = 0;
        const u = s.card >= 0 ? CARDS[s.card].uid : [];
        if (s.cstate === 'active' && (f[0] === 0x60 || f[0] === 0x61) && f[1] < 64 && hex(f.slice(8, 12)) === hex(u)) {
          const t = block((f[1] & ~3) + 3), key = f[0] === 0x60 ? t.slice(0, 6) : t.slice(10, 16);
          if (hex(f.slice(2, 8)) === hex(key)) { s.authSector = f[1] >> 2; s.reg[R.Status2] |= 0x08; irq(0x10); return; }
        }
        // A wrong key: the card stops answering and the timer runs out.
        s.cstate = 'idle'; s.authSector = -1;
        ctx.after(25e6, () => { if (s.job === job) irq(0x01); });
        return;
      }
      // Transceive waits for StartSend.
    };
    const send = (): void => {
      const job = ++s.job;
      const bits = s.reg[R.BitFraming] & 7, f = s.fifo.splice(0);
      s.reg[R.Error] = 0; s.reg[R.Control] = (s.reg[R.Control] & ~7);
      irq(0x40);
      const got = answer(f, bits);
      if (!got) { ctx.after(25e6, () => { if (s.job === job) irq(0x01); }); return; }
      s.fifo = got.data; s.reg[R.Control] |= got.bits ?? 0;
      irq(0x30);
    };

    const write = (r: number, v: number): void => {
      switch (r) {
        case R.Command:
          s.reg[r] = v & 0x3f;
          run(v & 0x0f);
          return;
        case R.ComIrq: if (v & 0x80) s.reg[r] |= v & 0x7f; else s.reg[r] &= ~v & 0x7f; return;
        case R.DivIrq: if (v & 0x80) s.reg[r] |= v & 0x14; else s.reg[r] &= ~v & 0x14; return;
        case R.FIFOData: if (s.fifo.length < 64) s.fifo.push(v); return;
        case R.FIFOLevel: if (v & 0x80) { s.fifo = []; s.reg[R.Error] &= ~0x10; } return;
        case R.BitFraming:
          s.reg[r] = v & 0x7f;
          if (v & 0x80 && (s.reg[R.Command] & 0x0f) === CMD.Transceive) send();
          return;
        case R.Status2: s.reg[r] = (s.reg[r] & 0x08 & v) | (v & 0xc0); return;
        case R.Version: return;
        default: s.reg[r] = v;
      }
    };
    const read = (r: number): number => {
      if (r === R.FIFOData) return s.fifo.shift() ?? 0;
      if (r === R.FIFOLevel) return s.fifo.length;
      return s.reg[r];
    };

    return {
      spi: {
        cs: 'SDA', sck: 'SCK',
        transfer(b) {
          if (!s.on) return 0xff;
          if (s.addr < 0) { s.addr = (b >> 1) & 0x3f; s.read = Boolean(b & 0x80); return 0; }
          if (s.read) { const v = read(s.addr); if (b & 0x80) s.addr = (b >> 1) & 0x3f; return v; }
          write(s.addr, b); return 0;
        },
      },
      onChange() {
        if (ctx.level('SDA') !== 0) s.addr = -1;
        const on = powered();
        if (on !== s.on) { s.on = on; resetRegs(); s.job++; }
        // A card leaving the field forgets everything; a new one starts idle.
        const here = s.on ? cardHere() : -1;
        if (here !== s.card) { s.card = here; s.cstate = 'idle'; s.authSector = -1; s.pendingWrite = -1; s.reg[R.Status2] &= ~0x08; }
      },
      // IRQ is not driven: the MFRC522 library polls.
      outputs: () => ({ powered: s.on, card: s.card >= 0 ? CARDS[s.card].name : '' }),
      ...keep(s),
    };
  },
};

export const rfid: PartDef[] = [rc522];
