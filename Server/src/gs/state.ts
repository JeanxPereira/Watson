import { REG, registerName, hex64 } from './registers.js';

/**
 * The GS register state a draw depends on. It is seeded from the state blob at the head of a
 * dump (GSState::Freeze, version 9) and then follows every register write.
 *
 * Blob layout, little-endian: u32 version; fifteen 8-byte globals; two contexts of twelve
 * 8-byte registers; vertex registers; transfer state; 4 MB of VRAM; four saved GIF paths of
 * 20 bytes (16-byte tag, u32 register index); a 4-byte float.
 */
const GLOBALS = ['PRIM', 'PRMODECONT', 'TEXCLUT', 'SCANMSK', 'TEXA', 'FOGCOL', 'DIMX', 'DTHE', 'COLCLAMP', 'PABE', 'BITBLTBUF', 'TRXDIR', 'TRXPOS', 'TRXREG'];
const CONTEXT = ['XYOFFSET', 'TEX0', 'TEX1', 'CLAMP', 'MIPTBP1', 'MIPTBP2', 'SCISSOR', 'ALPHA', 'TEST', 'FBA', 'FRAME', 'ZBUF'];
const VERTEX = ['RGBAQ', 'ST', 'UV', 'FOG'];

const GLOBALS_AT = 4;
const CONTEXTS_AT = GLOBALS_AT + 15 * 8;
const VERTEX_AT = CONTEXTS_AT + 2 * 12 * 8;
const FIXED_END = VERTEX_AT + 5 * 8 + 8;
const VRAM_BYTES = 4 * 1024 * 1024;
const PATHS_BYTES = 4 * 20;

const SNAPSHOT_CONTEXT = ['FRAME', 'ZBUF', 'TEX0', 'TEX1', 'CLAMP', 'ALPHA', 'TEST', 'SCISSOR', 'XYOFFSET', 'FBA'];
const SNAPSHOT_GLOBAL = ['TEXA', 'FOGCOL', 'COLCLAMP', 'DTHE', 'PABE', 'DIMX', 'TEXCLUT', 'PRMODECONT'];

/** TEX2 carries only these TEX0 fields: PSM 20:6 and CBP..CLD 37:27. */
const TEX2_MASK = (0x3fn << 20n) | (((1n << 27n) - 1n) << 37n);

export class GsState {
  private values = new Map<string, bigint>();
  savedPaths: { tag: Buffer; reg: number }[] = [];
  vramOffset = -1;

  static empty(): GsState {
    const state = new GsState();
    state.values.set('PRMODECONT', 1n);
    return state;
  }

  static fromBlob(blob: Buffer): GsState {
    const needed = FIXED_END + VRAM_BYTES + PATHS_BYTES + 4;
    if (blob.length < needed) {
      throw new Error(`state blob is ${blob.length} bytes; a version 9 GS state needs at least ${needed}`);
    }
    const state = new GsState();
    GLOBALS.forEach((name, i) => state.values.set(name, blob.readBigUInt64LE(GLOBALS_AT + 8 * i)));
    for (let c = 0; c < 2; c++) {
      CONTEXT.forEach((name, i) => state.values.set(`${name}_${c + 1}`, blob.readBigUInt64LE(CONTEXTS_AT + 96 * c + 8 * i)));
    }
    VERTEX.forEach((name, i) => state.values.set(name, blob.readBigUInt64LE(VERTEX_AT + 8 * i)));

    const pathsAt = blob.length - 4 - PATHS_BYTES;
    for (let i = 0; i < 4; i++) {
      state.savedPaths.push({
        tag: Buffer.from(blob.subarray(pathsAt + 20 * i, pathsAt + 20 * i + 16)),
        reg: blob.readUInt32LE(pathsAt + 20 * i + 16),
      });
    }
    state.vramOffset = pathsAt - VRAM_BYTES;
    return state;
  }

  write(reg: number, value: bigint): void {
    if (reg === REG.TEX2_1 || reg === REG.TEX2_2) {
      const name = reg === REG.TEX2_1 ? 'TEX0_1' : 'TEX0_2';
      this.values.set(name, (this.get(name) & ~TEX2_MASK) | (value & TEX2_MASK));
      return;
    }
    this.values.set(registerName(reg), value);
  }

  get(name: string): bigint {
    return this.values.get(name) ?? 0n;
  }

  context(index: 0 | 1): Record<string, bigint> {
    const out: Record<string, bigint> = {};
    for (const name of CONTEXT) out[name] = this.get(`${name}_${index + 1}`);
    return out;
  }

  /** PRIM as the GS uses it: its attribute bits come from PRMODE while PRMODECONT.AC is 0. */
  effectivePrim(): bigint {
    const prim = this.get('PRIM');
    if (this.get('PRMODECONT') & 1n) return prim;
    return (prim & 0x7n) | (this.get('PRMODE') & 0x7f8n);
  }

  /** The registers a draw in this context depends on, as hex strings. */
  snapshot(ctxt: 0 | 1): Record<string, string> {
    const out: Record<string, string> = { PRIM: hex64(this.effectivePrim()) };
    for (const name of SNAPSHOT_CONTEXT) out[name] = hex64(this.get(`${name}_${ctxt + 1}`));
    for (const name of SNAPSHOT_GLOBAL) out[name] = hex64(this.get(name));
    return out;
  }
}
