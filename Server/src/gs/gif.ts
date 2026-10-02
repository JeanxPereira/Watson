import { REG } from './registers.js';

/**
 * GIF decoding for one transfer path: bytes in, GS register writes out. The rules follow the
 * packed-register handlers in pcsx2/GS/GSState.cpp and the GS manual.
 *
 * A tag is 16 bytes: NLOOP 0:15, EOP 15:1, PRE 46:1, PRIM 47:11, FLG 58:2, NREG 60:4 (0 means
 * 16), then sixteen 4-bit register descriptors.
 */
export type GifEvent =
  | { kind: 'tag'; nloop: number; eop: boolean; pre: boolean; prim: number; flg: number; nreg: number; regs: number[] }
  | { kind: 'write'; reg: number; value: bigint }
  | { kind: 'image'; bytes: number };

const MASK64 = (1n << 64n) - 1n;
const ADC = 1n << 47n;

interface Tag { nloop: number; eop: boolean; pre: boolean; prim: number; flg: number; nreg: number; regs: number[] }

function readTag(bytes: Buffer): Tag {
  const lo = bytes.readBigUInt64LE(0);
  const hi = bytes.readBigUInt64LE(8);
  const nreg = Number((lo >> 60n) & 0xfn) || 16;
  const regs: number[] = [];
  for (let i = 0; i < nreg; i++) regs.push(Number((hi >> BigInt(4 * i)) & 0xfn));
  return {
    nloop: Number(lo & 0x7fffn),
    eop: ((lo >> 15n) & 1n) === 1n,
    pre: ((lo >> 46n) & 1n) === 1n,
    prim: Number((lo >> 47n) & 0x7ffn),
    flg: Number((lo >> 58n) & 3n),
    nreg,
    regs,
  };
}

export class GifPath {
  private buffer: Buffer = Buffer.alloc(0);
  private tag: Tag | null = null;
  /** Data items still owed by the current tag: qwords (PACKED), dwords (REGLIST), bytes (IMAGE). */
  private remaining = 0;
  private index = 0;
  private imageBytes = 0;
  private padding = 0;
  /** Q latched by the last packed ST; a packed RGBAQ carries it. */
  private q = 0n;

  /** `saved` is a path as the dump's state blob stores it: mid-packet when its NLOOP is not 0. */
  constructor(saved?: { tag: Buffer; reg: number }) {
    if (!saved) return;
    const tag = readTag(saved.tag);
    if (tag.nloop === 0) return;
    this.tag = tag;
    if (tag.flg >= 2) {
      this.remaining = tag.nloop * 16;
      this.imageBytes = this.remaining;
    } else {
      this.index = saved.reg;
      this.remaining = tag.nloop * tag.nreg - saved.reg;
      if (tag.flg === 1 && (tag.nloop * tag.nreg) % 2 === 1) this.padding = 8;
    }
  }

  get pendingBytes(): number { return this.buffer.length; }

  feed(chunk: Buffer): GifEvent[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const events: GifEvent[] = [];
    let offset = 0;
    const available = () => this.buffer.length - offset;

    for (;;) {
      if (!this.tag) {
        if (this.padding > 0) {
          if (available() < this.padding) break;
          offset += this.padding;
          this.padding = 0;
        }
        if (available() < 16) break;
        const tag = readTag(this.buffer.subarray(offset, offset + 16));
        offset += 16;
        events.push({ kind: 'tag', ...tag });
        if (tag.nloop === 0) continue;
        this.tag = tag;
        this.index = 0;
        if (tag.flg === 0) {
          this.remaining = tag.nloop * tag.nreg;
          if (tag.pre) events.push({ kind: 'write', reg: REG.PRIM, value: BigInt(tag.prim) });
        } else if (tag.flg === 1) {
          this.remaining = tag.nloop * tag.nreg;
          this.padding = this.remaining % 2 === 1 ? 8 : 0;
        } else {
          this.remaining = tag.nloop * 16;
          this.imageBytes = this.remaining;
        }
        continue;
      }

      const tag = this.tag;
      if (tag.flg === 0) {
        if (available() < 16) break;
        const lo = this.buffer.readBigUInt64LE(offset);
        const hi = this.buffer.readBigUInt64LE(offset + 8);
        offset += 16;
        this.packed(tag.regs[this.index % tag.nreg], lo, hi, events);
        this.index += 1;
        this.remaining -= 1;
      } else if (tag.flg === 1) {
        if (available() < 8) break;
        const value = this.buffer.readBigUInt64LE(offset);
        offset += 8;
        const descriptor = tag.regs[this.index % tag.nreg];
        if (descriptor !== 0xe && descriptor !== 0xf) events.push({ kind: 'write', reg: descriptor, value });
        this.index += 1;
        this.remaining -= 1;
      } else {
        if (available() === 0) break;
        const take = Math.min(this.remaining, available());
        offset += take;
        this.remaining -= take;
        if (this.remaining === 0) events.push({ kind: 'image', bytes: this.imageBytes });
      }
      if (this.remaining === 0) this.tag = null;
    }

    this.buffer = offset === this.buffer.length ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(offset));
    return events;
  }

  private packed(descriptor: number, lo: bigint, hi: bigint, events: GifEvent[]): void {
    const write = (reg: number, value: bigint) => events.push({ kind: 'write', reg, value: value & MASK64 });
    switch (descriptor) {
      case 0x0:
        write(REG.PRIM, lo & 0x7ffn);
        break;
      case 0x1:
        write(REG.RGBAQ, (lo & 0xffn) | (((lo >> 32n) & 0xffn) << 8n) | ((hi & 0xffn) << 16n) | (((hi >> 32n) & 0xffn) << 24n) | (this.q << 32n));
        break;
      case 0x2:
        this.q = hi & 0xffffffffn;
        write(REG.ST, lo);
        break;
      case 0x3:
        write(REG.UV, (lo & 0x3fffn) | (((lo >> 32n) & 0x3fffn) << 16n));
        break;
      case 0x4:
      case 0xc: {
        const value = (lo & 0xffffn) | (((lo >> 32n) & 0xffffn) << 16n) | (((hi >> 4n) & 0xffffffn) << 32n) | (((hi >> 36n) & 0xffn) << 56n);
        write(descriptor === 0xc || (hi & ADC) ? REG.XYZF3 : REG.XYZF2, value);
        break;
      }
      case 0x5:
      case 0xd: {
        const value = (lo & 0xffffn) | (((lo >> 32n) & 0xffffn) << 16n) | ((hi & 0xffffffffn) << 32n);
        write(descriptor === 0xd || (hi & ADC) ? REG.XYZ3 : REG.XYZ2, value);
        break;
      }
      case 0x6: write(REG.TEX0_1, lo); break;
      case 0x7: write(REG.TEX0_2, lo); break;
      case 0x8: write(REG.CLAMP_1, lo); break;
      case 0x9: write(REG.CLAMP_2, lo); break;
      case 0xa:
        write(REG.FOG, ((hi >> 36n) & 0xffn) << 56n);
        break;
      case 0xe:
        write(Number(hi & 0x7fn), lo);
        break;
      default:
        break;
    }
  }
}
