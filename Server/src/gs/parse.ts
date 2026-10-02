import * as fs from 'node:fs';
import { walkGsDump } from '../gsdump.js';
import { REG, registerName, decodeRegister, hex64 } from './registers.js';
import { GifPath } from './gif.js';
import { GsState } from './state.js';
import { DrawAssembler, Draw } from './draws.js';

/**
 * Turn a GS dump into JSON Lines (header, initial state, then draws, transfers and frame marks
 * in the order the GS received them) and a summary of what the frames are made of.
 */
export interface Summary {
  packets: number;
  frames: number;
  draws: number;
  writes: number;
  imageBytes: number;
  unknownRegisters: Record<string, number>;
  perFrame: { draws: number; primitives: number }[];
  byPrimitive: Record<string, number>;
  /** Blend equation of each draw with alpha blending on, by draw count. */
  alpha: Record<string, number>;
  blendingOff: number;
  frameTargets: Record<string, number>;
  textures: Record<string, number>;
  untextured: number;
  tests: Record<string, number>;
  uploads: Record<string, number>;
  copies: Record<string, number>;
}

const REGISTERS = 8192;
const hex = (value: number, digits: number) => `0x${value.toString(16).padStart(digits, '0')}`;
const bump = (table: Record<string, number>, key: string) => { table[key] = (table[key] ?? 0) + 1; };

/** The GS blend equation, `(A - B) * C >> 7 + D`, in words. */
export function describeAlpha(alpha: Record<string, number>): string {
  const colour = ['Cs', 'Cd', '0', '0'];
  const coverage = ['As', 'Ad', `FIX(${alpha.FIX})`, `FIX(${alpha.FIX})`];
  return `(${colour[alpha.A]} - ${colour[alpha.B]}) * ${coverage[alpha.C]} >> 7 + ${colour[alpha.D]}`;
}

const ATST = ['NEVER', 'ALWAYS', 'LESS', 'LEQUAL', 'EQUAL', 'GEQUAL', 'GREATER', 'NOTEQUAL'];
const AFAIL = ['KEEP', 'FB_ONLY', 'ZB_ONLY', 'RGB_ONLY'];
const ZTST = ['NEVER', 'ALWAYS', 'GEQUAL', 'GREATER'];

function describeTest(test: Record<string, number>): string {
  const alpha = test.ATE ? `alpha ${ATST[test.ATST]} ${test.AREF} fail ${AFAIL[test.AFAIL]}` : 'alpha off';
  const dest = test.DATE ? `dest-alpha ${test.DATM}` : 'dest-alpha off';
  const depth = test.ZTE ? `depth ${ZTST[test.ZTST]}` : 'depth off';
  return `${alpha}; ${dest}; ${depth}`;
}

function decodedState(draw: Draw): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const name of ['PRIM', 'FRAME', 'ZBUF', 'TEX0', 'TEX1', 'CLAMP', 'ALPHA', 'TEST', 'SCISSOR', 'XYOFFSET', 'TEXA', 'FOGCOL']) {
    out[name] = decodeRegister(name, BigInt(draw.state[name]));
  }
  return out;
}

export function parseGsDump(file: string, out: string): Summary {
  const walk = walkGsDump(file);
  if (!walk.complete) throw new Error(`${file}: ${walk.reason}`);

  const data = fs.readFileSync(file);
  const headerSize = data.readUInt32LE(4);
  const header = {
    stateVersion: data.readUInt32LE(8),
    stateSize: data.readUInt32LE(12),
    serialOffset: data.readUInt32LE(16),
    serialSize: data.readUInt32LE(20),
    crc: data.readUInt32LE(24),
    screenshotWidth: data.readUInt32LE(28),
    screenshotHeight: data.readUInt32LE(32),
  };
  const serial = data.subarray(8 + header.serialOffset, 8 + header.serialOffset + header.serialSize).toString('latin1');
  const blobAt = 8 + headerSize;
  const state = GsState.fromBlob(data.subarray(blobAt, blobAt + header.stateSize));
  const paths = state.savedPaths.map((saved) => new GifPath(saved));
  const assembler = new DrawAssembler(state);

  const summary: Summary = {
    packets: walk.packets, frames: 0, draws: 0, writes: 0, imageBytes: 0,
    unknownRegisters: {}, perFrame: [], byPrimitive: {}, alpha: {}, blendingOff: 0,
    frameTargets: {}, textures: {}, untextured: 0, tests: {}, uploads: {}, copies: {},
  };

  const lines: string[] = [];
  const emit = (record: unknown) => lines.push(JSON.stringify(record));
  emit({ type: 'header', file, bytes: data.length, serial, ...header, crc: hex(header.crc, 8) });
  emit({ type: 'state', context1: state.snapshot(0), context2: state.snapshot(1) });

  /** Draws and transfers of the frame being read, in arrival order. */
  let pending: { at: number; record: unknown }[] = [];
  let order = 0;

  const transfer = () => {
    const blit = decodeRegister('BITBLTBUF', state.get('BITBLTBUF'));
    const position = decodeRegister('TRXPOS', state.get('TRXPOS'));
    const size = decodeRegister('TRXREG', state.get('TRXREG'));
    const direction = decodeRegister('TRXDIR', state.get('TRXDIR')).XDIR;
    const names = ['host-to-local', 'local-to-host', 'local-to-local', 'off'];
    if (direction === 0) bump(summary.uploads, `DBP ${hex(blit.DBP, 4)} DBW ${blit.DBW} PSM ${hex(blit.DPSM, 2)} ${size.RRW}x${size.RRH}`);
    if (direction === 2) bump(summary.copies, `SBP ${hex(blit.SBP, 4)} -> DBP ${hex(blit.DBP, 4)} ${size.RRW}x${size.RRH}`);
    pending.push({ at: order++, record: { type: 'transfer', frame: summary.frames, direction: names[direction], bitbltbuf: blit, trxpos: position, trxreg: size } });
  };

  const record = (draw: Draw) => {
    const decoded = decodedState(draw);
    summary.draws += 1;
    bump(summary.byPrimitive, draw.primitive);
    if (decoded.PRIM.ABE) bump(summary.alpha, describeAlpha(decoded.ALPHA)); else summary.blendingOff += 1;
    bump(summary.frameTargets, `FBP ${hex(decoded.FRAME.FBP, 3)} FBW ${decoded.FRAME.FBW} PSM ${hex(decoded.FRAME.PSM, 2)}`);
    if (decoded.PRIM.TME) {
      bump(summary.textures, `TBP0 ${hex(decoded.TEX0.TBP0, 4)} TBW ${decoded.TEX0.TBW} PSM ${hex(decoded.TEX0.PSM, 2)} ${1 << decoded.TEX0.TW}x${1 << decoded.TEX0.TH}`);
    } else {
      summary.untextured += 1;
    }
    bump(summary.tests, describeTest(decoded.TEST));
    return { type: 'draw', ...draw, decoded };
  };

  let offset = blobAt + header.stateSize + REGISTERS;
  /** Draws closed since the last one recorded, keyed by the order their first primitive arrived. */
  const flushDraws = () => {
    for (const draw of assembler.take()) pending.push({ at: drawOrder.get(draw.index) ?? order++, record: record(draw) });
  };
  const drawOrder = new Map<number, number>();
  let lastSeenDraw = -1;

  while (offset < data.length) {
    const type = data[offset];
    if (type === 0) {
      const path = data[offset + 1];
      const size = data.readUInt32LE(offset + 2);
      const events = paths[path & 3].feed(data.subarray(offset + 6, offset + 6 + size));
      for (const event of events) {
        if (event.kind === 'image') {
          summary.imageBytes += event.bytes;
        } else if (event.kind === 'write') {
          summary.writes += 1;
          const name = registerName(event.reg);
          if (name.startsWith('0x')) bump(summary.unknownRegisters, name);
          assembler.apply(event.reg, event.value);
          if (event.reg === REG.TRXDIR) transfer();
          const open = assembler.openIndex();
          if (open > lastSeenDraw) { drawOrder.set(open, order++); lastSeenDraw = open; }
        }
      }
      offset += 6 + size;
    } else if (type === 1) {
      assembler.endFrame();
      flushDraws();
      pending.sort((a, b) => a.at - b.at);
      let draws = 0;
      let primitives = 0;
      for (const { record: item } of pending) {
        emit(item);
        const maybe = item as { type: string; primitives?: number };
        if (maybe.type === 'draw') { draws += 1; primitives += maybe.primitives ?? 0; }
      }
      emit({ type: 'frame', index: summary.frames, draws, primitives });
      summary.perFrame.push({ draws, primitives });
      summary.frames += 1;
      pending = [];
      offset += 2;
    } else if (type === 2) {
      offset += 5;
    } else {
      offset += 1 + REGISTERS;
    }
  }

  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  return summary;
}

function table(title: string, entries: Record<string, number>): string[] {
  const rows = Object.entries(entries).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return [`${title}: none`];
  return [`${title}:`, ...rows.map(([key, count]) => `  ${String(count).padStart(5)}  ${key}`)];
}

export function formatSummary(summary: Summary, file: string, out: string): string {
  return [
    `dump: ${file}`,
    `records: ${out}`,
    `frames: ${summary.frames}   draws: ${summary.draws}   register writes: ${summary.writes}   image data: ${summary.imageBytes} bytes`,
    `per frame (draws/primitives): ${summary.perFrame.map((f) => `${f.draws}/${f.primitives}`).join('  ')}`,
    ...table('primitives, by draw', summary.byPrimitive),
    ...table('blend equation, draws with blending on', summary.alpha),
    `blending off: ${summary.blendingOff} draws`,
    ...table('frame targets', summary.frameTargets),
    ...table('textures, draws with texturing on', summary.textures),
    `untextured: ${summary.untextured} draws`,
    ...table('tests', summary.tests),
    ...table('host uploads', summary.uploads),
    ...table('VRAM-to-VRAM copies', summary.copies),
    ...table('unknown registers', summary.unknownRegisters),
    'build: unknown',
    `verdict: FOUND ${summary.draws}  coverage ${summary.packets}/${summary.packets}`,
  ].join('\n');
}
