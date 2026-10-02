import { REG, decodeRegister } from './registers.js';
import { GsState } from './state.js';

/**
 * Primitive assembly as the GS does it: a write to XYZ2 or XYZF2 puts a vertex in the queue and
 * draws the primitive it completes; XYZ3 and XYZF3 put the vertex in the queue and draw nothing.
 * Primitives that share their PRIM and register state are grouped into one draw.
 */
export interface Vertex {
  /** Raw 12.4 fixed-point position as written. */
  x: number; y: number; z: number;
  /** Position in pixels: XYOFFSET subtracted, divided by 16. */
  px: number; py: number;
  rgba: [number, number, number, number];
  q: number; s: number; t: number;
  /** Texel coordinates from UV, in texels. */
  u: number; v: number;
  fog: number;
}

export type PrimitiveName = 'point' | 'line' | 'linestrip' | 'triangle' | 'tristrip' | 'trifan' | 'sprite' | 'invalid';

export interface Draw {
  index: number;
  frame: number;
  primitive: PrimitiveName;
  context: 0 | 1;
  primitives: number;
  vertices: Vertex[];
  /** Vertex indices, `size` per primitive. */
  indices: number[];
  bbox: [number, number, number, number];
  state: Record<string, string>;
}

const NAMES: PrimitiveName[] = ['point', 'line', 'linestrip', 'triangle', 'tristrip', 'trifan', 'sprite', 'invalid'];
/** Vertices a primitive needs; 0 never completes. */
const SIZE = [1, 2, 2, 3, 3, 3, 2, 0];

const KICKS = new Set<number>([REG.XYZ2, REG.XYZF2, REG.XYZ3, REG.XYZF3]);

export class DrawAssembler {
  private queue: Vertex[] = [];
  private open: Draw | null = null;
  private openKey = '';
  private openSeen = new Map<Vertex, number>();
  private closed: Draw[] = [];
  private frame = 0;
  private count = 0;
  private key: string | null = null;

  constructor(private state: GsState) {}

  apply(reg: number, value: bigint): void {
    if (KICKS.has(reg)) {
      this.kick(reg, value);
      return;
    }
    this.state.write(reg, value);
    this.key = null;
    if (reg === REG.PRIM) this.queue = [];
  }

  endFrame(): void {
    this.close();
    this.frame += 1;
  }

  take(): Draw[] {
    const out = this.closed;
    this.closed = [];
    return out;
  }

  private close(): void {
    if (this.open) this.closed.push(this.open);
    this.open = null;
    this.openKey = '';
    this.openSeen = new Map();
  }

  private kick(reg: number, value: bigint): void {
    const prim = Number(this.state.effectivePrim());
    const type = prim & 7;
    const context = ((prim >> 9) & 1) as 0 | 1;
    const withFog = reg === REG.XYZF2 || reg === REG.XYZF3;
    const position = decodeRegister(withFog ? 'XYZF2' : 'XYZ2', value);
    const offset = decodeRegister('XYOFFSET', this.state.get(`XYOFFSET_${context + 1}`));
    const colour = decodeRegister('RGBAQ', this.state.get('RGBAQ'));
    const st = decodeRegister('ST', this.state.get('ST'));
    const uv = decodeRegister('UV', this.state.get('UV'));

    this.queue.push({
      x: position.X, y: position.Y, z: position.Z,
      px: (position.X - offset.OFX) / 16, py: (position.Y - offset.OFY) / 16,
      rgba: [colour.R, colour.G, colour.B, colour.A],
      q: colour.Q, s: st.S, t: st.T,
      u: uv.U / 16, v: uv.V / 16,
      fog: withFog ? position.F : decodeRegister('FOG', this.state.get('FOG')).F,
    });

    const size = SIZE[type];
    if (size === 0 || this.queue.length < size) return;

    const primitive = this.queue.slice(0, size);
    if (type === 2) this.queue = [primitive[1]];
    else if (type === 4) this.queue = [primitive[1], primitive[2]];
    else if (type === 5) this.queue = [primitive[0], primitive[2]];
    else this.queue = [];

    if (reg === REG.XYZ2 || reg === REG.XYZF2) this.emit(primitive, type, context);
  }

  private emit(primitive: Vertex[], type: number, context: 0 | 1): void {
    if (this.key === null) this.key = JSON.stringify(this.state.snapshot(context));
    if (!this.open || this.openKey !== this.key) {
      this.close();
      this.openKey = this.key;
      this.open = {
        index: this.count++,
        frame: this.frame,
        primitive: NAMES[type],
        context,
        primitives: 0,
        vertices: [],
        indices: [],
        bbox: [Infinity, Infinity, -Infinity, -Infinity],
        state: this.state.snapshot(context),
      };
    }
    const draw = this.open;
    for (const vertex of primitive) {
      let at = this.openSeen.get(vertex);
      if (at === undefined) {
        at = draw.vertices.length;
        draw.vertices.push(vertex);
        this.openSeen.set(vertex, at);
        draw.bbox = [Math.min(draw.bbox[0], vertex.px), Math.min(draw.bbox[1], vertex.py), Math.max(draw.bbox[2], vertex.px), Math.max(draw.bbox[3], vertex.py)];
      }
      draw.indices.push(at);
    }
    draw.primitives += 1;
  }
}
