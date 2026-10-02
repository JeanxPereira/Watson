import { REG, RGBAQ_ALIAS, registerName, hex64 } from './registers.js';

/**
 * The GS register state a draw depends on. It is seeded from the state blob at the head of a
 * dump (GSState::Freeze, version 9) and then follows every register write.
 *
 * Blob layout, little-endian: u32 version; fifteen 8-byte globals; two contexts of twelve
 * 8-byte registers; the vertex registers (RGBAQ and ST 8 bytes, UV and FOG 4 bytes, XYZ 8
 * bytes, 8 obsolete bytes); transfer state; 4 MB of VRAM; four saved GIF paths of 20 bytes
 * (16-byte tag, u32 register index); the Q latch as a 4-byte float.
 */
const GLOBALS = ['PRIM', 'PRMODECONT', 'TEXCLUT', 'SCANMSK', 'TEXA', 'FOGCOL', 'DIMX', 'DTHE', 'COLCLAMP', 'PABE', 'BITBLTBUF', 'TRXDIR', 'TRXPOS', 'TRXREG'];
const CONTEXT = ['XYOFFSET', 'TEX0', 'TEX1', 'CLAMP', 'MIPTBP1', 'MIPTBP2', 'SCISSOR', 'ALPHA', 'TEST', 'FBA', 'FRAME', 'ZBUF'];

const VERSION = 9;
const GLOBALS_AT = 4;
const CONTEXTS_AT = GLOBALS_AT + 15 * 8;
const VERTEX_AT = CONTEXTS_AT + 2 * 12 * 8;
const FIXED_END = VERTEX_AT + 8 + 8 + 4 + 4 + 8 + 8;
const VRAM_BYTES = 4 * 1024 * 1024;
const PATHS_BYTES = 4 * 20;

const SNAPSHOT_CONTEXT = ['FRAME', 'ZBUF', 'TEX0', 'TEX1', 'CLAMP', 'ALPHA', 'TEST', 'SCISSOR', 'XYOFFSET', 'FBA'];
const SNAPSHOT_GLOBAL = ['TEXA', 'FOGCOL', 'COLCLAMP', 'DTHE', 'PABE', 'DIMX', 'TEXCLUT', 'PRMODECONT'];

/** TEX2 carries only these TEX0 fields: PSM 20:6 and CBP..CLD 37:27. */
const TEX2_MASK = (0x3fn << 20n) | (((1n << 27n) - 1n) << 37n);
/** PRIM is eleven bits; its low three are the primitive type. */
const PRIM_BITS = 0x7ffn;
const PRIM_TYPE = 0x7n;

export class GsState {
  private values = new Map<string, bigint>();
  savedPaths: { tag: Buffer; reg: number }[] = [];
  vramOffset = -1;
  /** The Q latch saved in the dump, as IEEE-754 bits. */
  q = 0x3f800000n;

  static empty(): GsState {
    const state = new GsState();
    state.values.set('PRMODECONT', 1n);
    return state;
  }

  static fromBlob(blob: Buffer): GsState {
    const needed = FIXED_END + VRAM_BYTES + PATHS_BYTES + 4;
    if (blob.length < needed) {
      throw new Error(`state blob is ${blob.length} bytes; a version ${VERSION} GS state needs at least ${needed}`);
    }
    const version = blob.readUInt32LE(0);
    if (version !== VERSION) {
      throw new Error(`state version ${version} is not supported; this reader knows the layout of version ${VERSION}`);
    }

    const state = new GsState();
    GLOBALS.forEach((name, i) => state.values.set(name, blob.readBigUInt64LE(GLOBALS_AT + 8 * i)));
    for (let c = 0; c < 2; c++) {
      CONTEXT.forEach((name, i) => state.values.set(`${name}_${c + 1}`, blob.readBigUInt64LE(CONTEXTS_AT + 96 * c + 8 * i)));
    }
    state.values.set('PRIM', state.get('PRIM') & PRIM_BITS);
    state.values.set('RGBAQ', blob.readBigUInt64LE(VERTEX_AT));
    state.values.set('ST', blob.readBigUInt64LE(VERTEX_AT + 8));
    state.values.set('UV', BigInt(blob.readUInt32LE(VERTEX_AT + 16)));
    state.values.set('FOG', BigInt(blob.readUInt32LE(VERTEX_AT + 20) & 0xff) << 56n);

    const pathsAt = blob.length - 4 - PATHS_BYTES;
    for (let i = 0; i < 4; i++) {
      state.savedPaths.push({
        tag: Buffer.from(blob.subarray(pathsAt + 20 * i, pathsAt + 20 * i + 16)),
        reg: blob.readUInt32LE(pathsAt + 20 * i + 16),
      });
    }
    state.vramOffset = pathsAt - VRAM_BYTES;
    state.q = BigInt(blob.readUInt32LE(blob.length - 4));
    return state;
  }

  /**
   * Apply a register write the way the GS does. PRIM is one register: while PRMODECONT.AC is 1
   * a PRIM write replaces it and PRMODE is ignored; while AC is 0 a PRIM write changes only the
   * primitive type and a PRMODE write replaces everything but the type.
   */
  write(reg: number, value: bigint): void {
    const direct = (this.get('PRMODECONT') & 1n) === 1n;
    switch (reg) {
      case REG.PRIM:
        this.values.set('PRIM', direct ? value & PRIM_BITS : (this.get('PRIM') & ~PRIM_TYPE) | (value & PRIM_TYPE));
        return;
      case REG.PRMODE:
        if (!direct) this.values.set('PRIM', (value & PRIM_BITS & ~PRIM_TYPE) | (this.get('PRIM') & PRIM_TYPE));
        return;
      case REG.TEX2_1:
      case REG.TEX2_2: {
        const name = reg === REG.TEX2_1 ? 'TEX0_1' : 'TEX0_2';
        this.values.set(name, (this.get(name) & ~TEX2_MASK) | (value & TEX2_MASK));
        return;
      }
      case RGBAQ_ALIAS:
        this.values.set('RGBAQ', value);
        return;
      default:
        this.values.set(registerName(reg), value);
    }
  }

  get(name: string): bigint {
    return this.values.get(name) ?? 0n;
  }

  context(index: 0 | 1): Record<string, bigint> {
    const out: Record<string, bigint> = {};
    for (const name of CONTEXT) out[name] = this.get(`${name}_${index + 1}`);
    return out;
  }

  /** PRIM as the GS holds it, eleven bits. */
  effectivePrim(): bigint {
    return this.get('PRIM');
  }

  /** The registers a draw in this context depends on, as hex strings. */
  snapshot(ctxt: 0 | 1): Record<string, string> {
    const out: Record<string, string> = { PRIM: hex64(this.effectivePrim()) };
    for (const name of SNAPSHOT_CONTEXT) out[name] = hex64(this.get(`${name}_${ctxt + 1}`));
    for (const name of SNAPSHOT_GLOBAL) out[name] = hex64(this.get(name));
    return out;
  }
}
