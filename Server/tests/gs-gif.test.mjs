import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GifPath } from '../dist/gs/gif.js';
import { REG } from '../dist/gs/registers.js';

const qword = (lo, hi = 0n) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt.asUintN(64, lo), 0); b.writeBigUInt64LE(BigInt.asUintN(64, hi), 8); return b; };
const dword = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, value)); return b; };

function tag({ nloop, eop = 1, pre = 0, prim = 0, flg = 0, regs }) {
  const nreg = regs.length === 16 ? 0 : regs.length;
  const lo = BigInt(nloop) | (BigInt(eop) << 15n) | (BigInt(pre) << 46n) | (BigInt(prim) << 47n) | (BigInt(flg) << 58n) | (BigInt(nreg) << 60n);
  let hi = 0n;
  regs.forEach((r, i) => { hi |= BigInt(r) << BigInt(4 * i); });
  return qword(lo, hi);
}
const aPlusD = (address, value) => qword(value, BigInt(address));
const writes = (events) => events.filter((e) => e.kind === 'write').map((e) => [e.reg, e.value]);

test('PACKED A+D writes come out in order with address and value', () => {
  const events = new GifPath().feed(Buffer.concat([
    tag({ nloop: 2, regs: [0xe] }), aPlusD(REG.ALPHA_1, 0x44n), aPlusD(REG.FRAME_1, 0xa0000n),
  ]));
  assert.equal(events[0].kind, 'tag');
  assert.deepEqual({ nloop: events[0].nloop, flg: events[0].flg, nreg: events[0].nreg, regs: events[0].regs }, { nloop: 2, flg: 0, nreg: 1, regs: [0xe] });
  assert.deepEqual(writes(events), [[REG.ALPHA_1, 0x44n], [REG.FRAME_1, 0xa0000n]]);
});

test('PACKED ST, RGBAQ, XYZF2 land in register layout, and RGBAQ takes the packed Q', () => {
  const st = qword(0x3f0000003e800000n, 0x3f800000n);
  const rgba = qword(0x00000020_00000010n, 0x00000080_00000040n);
  const xyzf = qword((0x9abcn << 32n) | 0x8000n, (0x7fn << 36n) | (0x345678n << 4n));
  const events = new GifPath().feed(Buffer.concat([tag({ nloop: 1, regs: [2, 1, 4] }), st, rgba, xyzf]));
  assert.deepEqual(writes(events), [
    [REG.ST, 0x3f0000003e800000n],
    [REG.RGBAQ, 0x3f800000_80402010n],
    [REG.XYZF2, 0x7f_345678_9abc_8000n],
  ]);
});

test('the ADC bit turns a packed XYZF2 or XYZ2 into the no-draw register', () => {
  const adc = 1n << 47n;
  const events = new GifPath().feed(Buffer.concat([
    tag({ nloop: 1, regs: [4, 5] }),
    qword((0x9abcn << 32n) | 0x8000n, adc | (0x7fn << 36n) | (0x345678n << 4n)),
    qword((0x0002n << 32n) | 0x0001n, adc | 0x12345678n),
  ]));
  assert.deepEqual(writes(events), [[REG.XYZF3, 0x7f_345678_9abc_8000n], [REG.XYZ3, 0x12345678_0002_0001n]]);
});

test('descriptors C and D are XYZF3 and XYZ3 without the ADC bit', () => {
  const events = new GifPath().feed(Buffer.concat([
    tag({ nloop: 1, regs: [0xc, 0xd] }),
    qword((0x0004n << 32n) | 0x0003n, (0x01n << 36n) | (0x000010n << 4n)),
    qword((0x0002n << 32n) | 0x0001n, 0x00000099n),
  ]));
  assert.deepEqual(writes(events), [[REG.XYZF3, 0x01_000010_0004_0003n], [REG.XYZ3, 0x00000099_0002_0001n]]);
});

test('packed UV and FOG land in register layout', () => {
  const events = new GifPath().feed(Buffer.concat([
    tag({ nloop: 1, regs: [3, 0xa] }), qword((0x0200n << 32n) | 0x0100n), qword(0n, 0x55n << 36n),
  ]));
  assert.deepEqual(writes(events), [[REG.UV, 0x0200_0100n], [REG.FOG, 0x55n << 56n]]);
});

test('PRE writes the tag PRIM before the data, in PACKED mode only', () => {
  const packed = new GifPath().feed(Buffer.concat([tag({ nloop: 1, pre: 1, prim: 0x15b, regs: [0xe] }), aPlusD(REG.DTHE, 1n)]));
  assert.deepEqual(writes(packed), [[REG.PRIM, 0x15bn], [REG.DTHE, 1n]]);
  const reglist = new GifPath().feed(Buffer.concat([tag({ nloop: 1, pre: 1, prim: 0x15b, flg: 1, regs: [1, 1] }), dword(1n), dword(2n)]));
  assert.deepEqual(writes(reglist), [[REG.RGBAQ, 1n], [REG.RGBAQ, 2n]]);
});

test('REGLIST with an odd count skips its padding so the next tag decodes', () => {
  const events = new GifPath().feed(Buffer.concat([
    tag({ nloop: 1, flg: 1, regs: [1, 2, 5] }), dword(0x11n), dword(0x22n), dword(0x33n), dword(0xdeadn),
    tag({ nloop: 1, regs: [0xe] }), aPlusD(REG.PABE, 1n),
  ]));
  assert.deepEqual(writes(events), [[REG.RGBAQ, 0x11n], [REG.ST, 0x22n], [REG.XYZ2, 0x33n], [REG.PABE, 1n]]);
  assert.equal(events.filter((e) => e.kind === 'tag').length, 2);
});

test('IMAGE reports its byte count and the next tag decodes', () => {
  const events = new GifPath().feed(Buffer.concat([
    tag({ nloop: 4, flg: 2, regs: [] }), Buffer.alloc(64, 0x5a),
    tag({ nloop: 1, regs: [0xe] }), aPlusD(REG.FBA_1, 1n),
  ]));
  assert.deepEqual(events.filter((e) => e.kind === 'image'), [{ kind: 'image', bytes: 64 }]);
  assert.deepEqual(writes(events), [[REG.FBA_1, 1n]]);
});

test('a tag with NLOOP 0 carries no data', () => {
  const events = new GifPath().feed(Buffer.concat([
    tag({ nloop: 0, regs: [0xe] }), tag({ nloop: 1, regs: [0xe] }), aPlusD(REG.DTHE, 1n),
  ]));
  assert.equal(events.filter((e) => e.kind === 'tag').length, 2);
  assert.deepEqual(writes(events), [[REG.DTHE, 1n]]);
});

test('NREG 0 means sixteen registers per loop', () => {
  const regs = Array(16).fill(0xe);
  const data = regs.map((_, i) => aPlusD(REG.DTHE, BigInt(i)));
  const events = new GifPath().feed(Buffer.concat([tag({ nloop: 1, regs }), ...data]));
  assert.equal(events[0].nreg, 16);
  assert.equal(writes(events).length, 16);
});

test('a stream split at any byte gives the same events as the whole', () => {
  const stream = Buffer.concat([
    tag({ nloop: 1, pre: 1, prim: 0x15b, regs: [2, 1, 4] }),
    qword(0x3f0000003e800000n, 0x3f800000n), qword(0x00000020_00000010n, 0x00000080_00000040n),
    qword((0x9abcn << 32n) | 0x8000n, (0x7fn << 36n) | (0x345678n << 4n)),
    tag({ nloop: 1, flg: 1, regs: [1, 2, 5] }), dword(0x11n), dword(0x22n), dword(0x33n), dword(0n),
    tag({ nloop: 2, flg: 2, regs: [] }), Buffer.alloc(32, 1),
    tag({ nloop: 1, regs: [0xe] }), aPlusD(REG.ALPHA_2, 0x64n),
  ]);
  const whole = new GifPath().feed(stream);
  for (let cut = 1; cut < stream.length; cut++) {
    const path = new GifPath();
    const split = [...path.feed(stream.subarray(0, cut)), ...path.feed(stream.subarray(cut))];
    assert.deepEqual(split, whole, `cut at byte ${cut}`);
    assert.equal(path.pendingBytes, 0);
  }
});

test('a path resumed from saved state finishes the packet it was in, with no tag event', () => {
  const saved = { tag: tag({ nloop: 2, regs: [0xe, 0xe] }), reg: 1 };
  const events = new GifPath(saved).feed(Buffer.concat([
    aPlusD(REG.DTHE, 1n), aPlusD(REG.PABE, 1n), aPlusD(REG.FBA_1, 1n),
    tag({ nloop: 1, regs: [0xe] }), aPlusD(REG.COLCLAMP, 1n),
  ]));
  assert.deepEqual(events.map((e) => e.kind), ['write', 'write', 'write', 'tag', 'write']);
  assert.deepEqual(writes(events), [[REG.DTHE, 1n], [REG.PABE, 1n], [REG.FBA_1, 1n], [REG.COLCLAMP, 1n]]);
});
