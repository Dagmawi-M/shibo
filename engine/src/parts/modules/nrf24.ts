// nRF24L01+ 2.4 GHz radio on SPI. Radios in the same circuit hear each other when
// they share channel, data rate and address width and the receiver has a pipe open on
// the sender's address. Auto-acknowledge with retries, ack payloads, dynamic payloads
// and the no-ack command are modelled; so are the three-deep FIFOs and the IRQ pin.
// Air time is the real one for the chosen rate; there is no range limit or noise.
import type { PartDef } from '../../part.ts';
import { keep } from '../util.ts';

const REG = { CONFIG: 0x00, EN_AA: 0x01, EN_RXADDR: 0x02, SETUP_AW: 0x03, SETUP_RETR: 0x04, RF_CH: 0x05, RF_SETUP: 0x06, STATUS: 0x07, OBSERVE_TX: 0x08, RPD: 0x09, RX_ADDR_P0: 0x0a, RX_ADDR_P1: 0x0b, TX_ADDR: 0x10, RX_PW_P0: 0x11, FIFO_STATUS: 0x17, DYNPD: 0x1c, FEATURE: 0x1d };
const RX_DR = 0x40, TX_DS = 0x20, MAX_RT = 0x10;

interface Packet { ch: number; rate: number; aw: number; addr: number[]; data: number[]; noack: boolean; dpl: boolean }
/** What a receiving radio offers the others: hear a packet, say whether it acknowledged it (and with what payload). */
interface Receiver { hear(p: Packet): { ack: boolean; payload: number[] | null } | null }

const reset = () => ({
  reg: [0x08, 0x3f, 0x03, 0x03, 0x03, 0x02, 0x0e, 0x0e, 0, 0, 0, 0, 0xc3, 0xc4, 0xc5, 0xc6, 0, 0, 0, 0, 0, 0, 0, 0x11, 0, 0, 0, 0, 0, 0, 0, 0],
  p0: [0xe7, 0xe7, 0xe7, 0xe7, 0xe7], p1: [0xc2, 0xc2, 0xc2, 0xc2, 0xc2], tx: [0xe7, 0xe7, 0xe7, 0xe7, 0xe7],
  txq: [] as { data: number[]; noack: boolean }[], rxq: [] as { pipe: number; data: number[] }[], acks: [] as { pipe: number; data: number[] }[],
  reuse: false,
});

const nrf24: PartDef = {
  type: 'nrf24l01', pins: ['GND', 'VCC', 'CE', 'CSN', 'SCK', 'MOSI', 'MISO', 'IRQ'],
  ui: { label: 'Radio (nRF24L01)', tag: 'shibo-nrf24l01', group: 'Modules' },
  links: () => [],
  device(ctx) {
    const s = { ...reset(), on: false, cmd: -1, buf: [] as number[], busy: false, sent: 0, heard: 0, job: 0 };
    const aw = () => (s.reg[REG.SETUP_AW] & 3) + 2;
    const rate = () => (s.reg[REG.RF_SETUP] & 0x20 ? 250 : s.reg[REG.RF_SETUP] & 0x08 ? 2000 : 1000);   // kbit/s
    const up = () => s.on && (s.reg[REG.CONFIG] & 2) !== 0;
    const rxMode = () => up() && (s.reg[REG.CONFIG] & 1) !== 0 && ctx.level('CE') === 1;
    const dyn = (pipe: number) => (s.reg[REG.FEATURE] & 4) !== 0 && (s.reg[REG.DYNPD] & (1 << pipe)) !== 0;
    const pipeAddr = (p: number): number[] => (p === 0 ? s.p0 : p === 1 ? s.p1 : [s.reg[REG.RX_ADDR_P0 + p], ...s.p1.slice(1)]);
    const status = (): number => {
      const pipe = s.rxq.length ? s.rxq[0].pipe : 7;
      return (s.reg[REG.STATUS] & 0x70) | (pipe << 1) | (s.txq.length >= 3 ? 1 : 0);
    };
    const fifoStatus = () => (s.reuse ? 0x40 : 0) | (s.txq.length >= 3 ? 0x20 : 0) | (s.txq.length ? 0 : 0x10) | (s.rxq.length >= 3 ? 2 : 0) | (s.rxq.length ? 0 : 1);
    const flag = (bits: number) => { s.reg[REG.STATUS] |= bits; ctx.changed(); };

    const receiver: Receiver = {
      hear(p) {
        if (!rxMode() || p.ch !== s.reg[REG.RF_CH] || p.rate !== rate() || p.aw !== aw()) return null;
        for (let pipe = 0; pipe < 6; pipe++) {
          if (!(s.reg[REG.EN_RXADDR] & (1 << pipe)) || pipeAddr(pipe).slice(0, p.aw).join() !== p.addr.join()) continue;
          // A static-length pipe only takes packets of its length; a dynamic one needs the sender to use dynamic payloads too.
          if (dyn(pipe) ? !p.dpl : p.dpl || p.data.length !== (s.reg[REG.RX_PW_P0 + pipe] & 63)) return null;
          if (s.rxq.length >= 3) return null;                 // full: the packet is lost and not acknowledged
          s.rxq.push({ pipe, data: p.data }); s.heard++;
          const ack = !p.noack && (s.reg[REG.EN_AA] & (1 << pipe)) !== 0;
          let payload: number[] | null = null;
          if (ack && (s.reg[REG.FEATURE] & 2)) { const i = s.acks.findIndex((a) => a.pipe === pipe); if (i >= 0) payload = s.acks.splice(i, 1)[0].data; }
          flag(RX_DR);
          return { ack, payload };
        }
        return null;
      },
    };

    /** Send the packet at the head of the TX FIFO, with retries if it wants an acknowledgement. */
    const transmit = (tries: number): void => {
      const pkt = s.txq[0];
      const job = s.job;
      const bytes = 1 + aw() + pkt.data.length + 2 + (s.reg[REG.FEATURE] & 4 ? 1 : 0);
      const air = 130e3 + (bytes * 8 + 9) * (1e6 / rate());
      ctx.after(air, () => {
        if (job !== s.job || !up()) { s.busy = false; return; }
        const wantAck = !pkt.noack && (s.reg[REG.EN_AA] & 1) !== 0;
        const p: Packet = { ch: s.reg[REG.RF_CH], rate: rate(), aw: aw(), addr: s.tx.slice(0, aw()), data: pkt.data, noack: pkt.noack || !wantAck, dpl: (s.reg[REG.FEATURE] & 4) !== 0 && (s.reg[REG.DYNPD] & 1) !== 0 };
        let got: { ack: boolean; payload: number[] | null } | null = null;
        for (const peer of ctx.peers() as Receiver[]) { const g = peer?.hear(p); if (g && !got) got = g; }
        if (!wantAck || got?.ack) {
          if (!s.reuse) s.txq.shift();
          s.sent++; s.reg[REG.OBSERVE_TX] = (s.reg[REG.OBSERVE_TX] & 0xf0) | tries;
          if (got?.payload && s.rxq.length < 3) { s.rxq.push({ pipe: 0, data: got.payload }); s.reg[REG.STATUS] |= RX_DR; }
          s.busy = false; flag(TX_DS); kick();
          return;
        }
        const arc = s.reg[REG.SETUP_RETR] & 15, ard = (((s.reg[REG.SETUP_RETR] >> 4) & 15) + 1) * 250e3;
        if (tries < arc) { ctx.after(ard, () => { if (job === s.job) transmit(tries + 1); else s.busy = false; }); return; }
        s.reg[REG.OBSERVE_TX] = Math.min(15, (s.reg[REG.OBSERVE_TX] >> 4) + 1) << 4 | tries;
        s.busy = false; flag(MAX_RT);                       // the packet stays in the FIFO
      });
    };
    /** In transmit mode with CE high, the chip sends whatever is in its TX FIFO. */
    const kick = (): void => {
      if (s.busy || !up() || s.reg[REG.CONFIG] & 1 || ctx.level('CE') !== 1 || !s.txq.length || s.reg[REG.STATUS] & MAX_RT) return;
      s.busy = true; transmit(0);
    };

    const writeReg = (a: number, v: number[]): void => {
      if (a === REG.RX_ADDR_P0 || a === REG.RX_ADDR_P1 || a === REG.TX_ADDR) {
        const t = a === REG.RX_ADDR_P0 ? s.p0 : a === REG.RX_ADDR_P1 ? s.p1 : s.tx;
        v.slice(0, 5).forEach((b, i) => { t[i] = b; });
        return;
      }
      if (!v.length) return;
      const b = v[0];
      if (a === REG.STATUS) { s.reg[a] &= ~(b & 0x70); return; }
      if (a === REG.OBSERVE_TX || a === REG.RPD || a === REG.FIFO_STATUS) return;
      s.reg[a] = b;
      if (a === REG.CONFIG && !(b & 2)) { s.job++; s.busy = false; }
    };
    const readReg = (a: number, i: number): number => {
      if (a === REG.RX_ADDR_P0) return s.p0[i] ?? 0;
      if (a === REG.RX_ADDR_P1) return s.p1[i] ?? 0;
      if (a === REG.TX_ADDR) return s.tx[i] ?? 0;
      if (a === REG.STATUS) return status();
      if (a === REG.FIFO_STATUS) return fifoStatus();
      return s.reg[a] ?? 0;
    };
    /** A command ends when CSN goes high: payloads and addresses are taken then. */
    const finish = (): void => {
      const c = s.cmd, d = s.buf;
      s.cmd = -1; s.buf = [];
      if (c >= 0x20 && c < 0x40) writeReg(c & 0x1f, d);
      else if ((c === 0xa0 || c === 0xb0) && d.length && s.txq.length < 3) { s.reuse = false; s.txq.push({ data: d.slice(0, 32), noack: c === 0xb0 }); }
      else if ((c & 0xf8) === 0xa8 && d.length && s.txq.length < 3) s.acks.push({ pipe: c & 7, data: d.slice(0, 32) });
      kick();
    };

    return {
      peer: receiver,
      spi: {
        cs: 'CSN', sck: 'SCK',
        transfer(b) {
          if (!s.on) return 0xff;
          if (s.cmd < 0) {
            s.cmd = b;
            if (b === 0xe1) { s.txq = []; s.acks = []; s.reuse = false; }
            else if (b === 0xe2) s.rxq = [];
            else if (b === 0xe3) s.reuse = true;
            return status();
          }
          const c = s.cmd, i = s.buf.length;
          s.buf.push(b);
          if (c < 0x20) return readReg(c, i);
          if (c === 0x61) { const head = s.rxq[0]; const v = head?.data[i] ?? 0; if (head && i === (dyn(head.pipe) ? head.data.length : s.reg[REG.RX_PW_P0 + head.pipe] & 63) - 1) s.rxq.shift(); return v; }
          if (c === 0x60) return s.rxq[0]?.data.length ?? 0;
          return 0;
        },
      },
      onChange() {
        const on = ctx.level('VCC') === 1 && ctx.level('GND') === 0;
        if (on !== s.on) { Object.assign(s, reset(), { on, cmd: -1, buf: [], busy: false, job: s.job + 1 }); }
        if (ctx.level('CSN') !== 0 && s.cmd >= 0) finish();
        kick();
      },
      drives() {
        if (!s.on) return [];
        // IRQ is active low while an unmasked flag is set.
        return [{ pin: 'IRQ', level: s.reg[REG.STATUS] & 0x70 & ~s.reg[REG.CONFIG] ? 0 : 1 }];
      },
      outputs: () => ({ powered: s.on, mode: !up() ? 'off' : s.reg[REG.CONFIG] & 1 ? 'listening' : 'sending', channel: s.reg[REG.RF_CH], sent: s.sent, heard: s.heard }),
      ...keep(s),
    };
  },
};

export const radios: PartDef[] = [nrf24];
