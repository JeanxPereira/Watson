import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GsState } from '../dist/gs/state.js';
import { GifPath } from '../dist/gs/gif.js';
import { REG } from '../dist/gs/registers.js';

const VRAM = 4 * 1024 * 1024;
const GLOBALS = ['PRIM', 'PRMODECONT', 'TEXCLUT', 'SCANMSK', 'TEXA', 'FOGCOL', 'DIMX', 'DTHE', 'COLCLAMP', 'PABE', 'BITBLTBUF', 'TRXDIR', 'TRXPOS', 'TRXREG', 'TRXREG'];
const CONTEXT = ['XYOFFSET', 'TEX0', 'TEX1', 'CLAMP', 'MIPTBP1', 'MIPTBP2', 'SCISSOR', 'ALPHA', 'TEST', 'FBA', 'FRAME', 'ZBUF'];

/** A state blob as GSState::Freeze writes it, with a value at every register slot. */
function blob({ globals = {}, contexts = [{}, {}], paths = [] } = {}) {
  const transfer = 61;
  const b = Buffer.alloc(364 + transfer + VRAM + 80 + 4);
  b.writeUInt32LE(9, 0);
  GLOBALS.forEach((name, i) => b.writeBigUInt64LE(globals[name] ?? 0n, 4 + 8 * i));
  for (let c = 0; c < 2; c++) {
    CONTEXT.forEach((name, i) => b.writeBigUInt64LE(contexts[c][name] ?? 0n, 124 + 96 * c + 8 * i));
  }
  const pathsAt = b.length - 4 - 80;
  paths.forEach((p, i) => { p.tag.copy(b, pathsAt + 20 * i); b.writeUInt32LE(p.reg, pathsAt + 20 * i + 16); });
  return b;
}

const tagBytes = (nloop, regs) => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(BigInt(nloop) | (BigInt(regs.length) << 60n), 0);
  let hi = 0n; regs.forEach((r, i) => { hi |= BigInt(r) << BigInt(4 * i); });
  b.writeBigUInt64LE(hi, 8);
  return b;
};

test('a blob reads back through get and context', () => {
  const state = GsState.fromBlob(blob({
    globals: { PRIM: 0x15bn, TEXA: 0x80_00000000n, PRMODECONT: 1n },
    contexts: [{ ALPHA: 0x44n, FRAME: 0xa0000n, XYOFFSET: 0x0000800000008000n }, { ALPHA: 0x64n, ZBUF: 0x96n }],
  }));
  assert.equal(state.get('PRIM'), 0x15bn);
  assert.equal(state.get('TEXA'), 0x80_00000000n);
  assert.equal(state.get('ALPHA_1'), 0x44n);
  assert.equal(state.get('ALPHA_2'), 0x64n);
  assert.equal(state.get('ZBUF_2'), 0x96n);
  assert.equal(state.context(0).XYOFFSET, 0x0000800000008000n);
  assert.equal(state.vramOffset, 364 + 61);
});

test('a write to a context-2 register leaves context 1 alone', () => {
  const state = GsState.empty();
  state.write(REG.ALPHA_2, 0x64n);
  assert.equal(state.get('ALPHA_1'), 0n);
  assert.equal(state.get('ALPHA_2'), 0x64n);
});

test('a snapshot names context registers without their suffix', () => {
  const state = GsState.empty();
  state.write(REG.ALPHA_1, 0x44n);
  state.write(REG.ALPHA_2, 0x64n);
  assert.equal(state.snapshot(0).ALPHA, '0x0000000000000044');
  assert.equal(state.snapshot(1).ALPHA, '0x0000000000000064');
  assert.equal('ALPHA_1' in state.snapshot(0), false);
  for (const key of ['PRIM', 'FRAME', 'ZBUF', 'TEX0', 'TEX1', 'CLAMP', 'TEST', 'SCISSOR', 'XYOFFSET', 'FBA', 'TEXA', 'FOGCOL', 'COLCLAMP', 'DTHE', 'PABE', 'DIMX', 'TEXCLUT', 'PRMODECONT']) {
    assert.ok(key in state.snapshot(0), key);
  }
});

test('PRIM is one register: PRMODE merges into it only while PRMODECONT.AC is 0', () => {
  const state = GsState.empty();
  state.write(REG.PRMODECONT, 1n);
  state.write(REG.PRIM, 0x15bn);
  state.write(REG.PRMODE, 0x040n);
  assert.equal(state.effectivePrim(), 0x15bn, 'PRMODE is ignored while AC is 1');
  state.write(REG.PRMODECONT, 0n);
  assert.equal(state.effectivePrim(), 0x15bn, 'changing AC alone changes nothing');
  state.write(REG.PRMODE, 0x040n);
  assert.equal(state.effectivePrim(), 0x043n, 'PRMODE supplies the attributes, the type stays');
  state.write(REG.PRIM, 0x7fen);
  assert.equal(state.effectivePrim(), 0x046n, 'under AC 0 a PRIM write changes only the type');
  state.write(REG.PRMODECONT, 1n);
  assert.equal(state.effectivePrim(), 0x046n);
});

test('a blob with PRMODECONT.AC 0 keeps the PRIM attributes it was saved with', () => {
  const state = GsState.fromBlob(blob({ globals: { PRIM: 0x15bn, PRMODECONT: 0n } }));
  assert.equal(state.effectivePrim(), 0x15bn);
});

test('only the low eleven bits of a PRIM write count', () => {
  const state = GsState.empty();
  state.write(REG.PRIM, 0xdeadbeef00000006n);
  assert.equal(state.effectivePrim(), 0x006n);
});

test('the vertex registers are read from the blob at their real offsets', () => {
  const b = blob();
  b.writeBigUInt64LE(0x3f800000_80402010n, 316);
  b.writeBigUInt64LE(0x3f0000003e800000n, 324);
  b.writeUInt32LE(0x02000100, 332);
  b.writeUInt32LE(0x7f, 336);
  b.writeFloatLE(0.5, b.length - 4);
  const state = GsState.fromBlob(b);
  assert.equal(state.get('RGBAQ'), 0x3f800000_80402010n);
  assert.equal(state.get('ST'), 0x3f0000003e800000n);
  assert.equal(state.get('UV'), 0x02000100n);
  assert.equal(state.get('FOG'), 0x7fn << 56n);
  assert.equal(state.q, 0x3f000000n);
});

test('address 0x11 is RGBAQ too', () => {
  const state = GsState.empty();
  state.write(0x11, 0x80402010n);
  assert.equal(state.get('RGBAQ'), 0x80402010n);
});

test('a state blob of another version is refused', () => {
  const b = blob();
  b.writeUInt32LE(6, 0);
  assert.throws(() => GsState.fromBlob(b), /state version 6/);
});

test('TEX2 changes only the pixel format and CLUT fields of TEX0', () => {
  const state = GsState.empty();
  const tex0 = 0x2000n | (4n << 14n) | (0x13n << 20n) | (8n << 26n) | (8n << 30n) | (1n << 34n);
  state.write(REG.TEX0_1, tex0);
  state.write(REG.TEX2_1, (0x1bn << 20n) | (0x3000n << 37n));
  const expected = (tex0 & ~(0x3fn << 20n)) | (0x1bn << 20n) | (0x3000n << 37n);
  assert.equal(state.get('TEX0_1'), expected);
});

test('a path saved mid-packet resumes with its descriptors and no tag event', () => {
  const state = GsState.fromBlob(blob({ paths: [{ tag: tagBytes(3, [0xe]), reg: 0 }] }));
  assert.equal(state.savedPaths.length, 4);
  const aPlusD = (address, value) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(value, 0); b.writeBigUInt64LE(BigInt(address), 8); return b; };
  const events = new GifPath(state.savedPaths[0]).feed(Buffer.concat([
    aPlusD(REG.DTHE, 1n), aPlusD(REG.PABE, 1n), aPlusD(REG.FBA_1, 1n),
  ]));
  assert.deepEqual(events.map((e) => [e.kind, e.reg]), [['write', REG.DTHE], ['write', REG.PABE], ['write', REG.FBA_1]]);
  assert.deepEqual(new GifPath(state.savedPaths[1]).feed(Buffer.alloc(0)), []);
});

test('a blob too short to hold the registers is refused by length', () => {
  assert.throws(() => GsState.fromBlob(Buffer.alloc(100)), /state blob is 100 bytes/);
});
