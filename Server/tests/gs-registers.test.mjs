import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REG, registerName, decodeRegister, hex64 } from '../dist/gs/registers.js';

test('a known address has its name and an unknown one keeps its number', () => {
  assert.equal(registerName(0x42), 'ALPHA_1');
  assert.equal(registerName(REG.FRAME_2), 'FRAME_2');
  assert.equal(registerName(0x7e), '0x7e');
});

test('ALPHA decodes its four selectors and FIX', () => {
  assert.deepEqual(decodeRegister('ALPHA_1', 0x0000008000000044n), { A: 0, B: 1, C: 0, D: 1, FIX: 128 });
});

test('PRIM decodes type and flags', () => {
  assert.deepEqual(decodeRegister('PRIM', 0x15bn), { PRIM: 3, IIP: 1, TME: 1, FGE: 0, ABE: 1, AA1: 0, FST: 1, CTXT: 0, FIX: 0 });
});

test('RGBAQ decodes colour bytes and Q as a float', () => {
  assert.deepEqual(decodeRegister('RGBAQ', 0x3f80000080402010n), { R: 0x10, G: 0x20, B: 0x40, A: 0x80, Q: 1 });
});

test('ST decodes two floats', () => {
  assert.deepEqual(decodeRegister('ST', 0x3f0000003e800000n), { S: 0.25, T: 0.5 });
});

test('TEX0 round-trips every field', () => {
  const fields = { TBP0: 0x2000, TBW: 4, PSM: 0x13, TW: 8, TH: 8, TCC: 1, TFX: 0, CBP: 0x3000, CPSM: 0, CSM: 0, CSA: 0, CLD: 1 };
  const at = { TBP0: 0n, TBW: 14n, PSM: 20n, TW: 26n, TH: 30n, TCC: 34n, TFX: 35n, CBP: 37n, CPSM: 51n, CSM: 55n, CSA: 56n, CLD: 61n };
  let value = 0n;
  for (const [name, bit] of Object.entries(at)) value |= BigInt(fields[name]) << bit;
  assert.deepEqual(decodeRegister('TEX0_1', value), fields);
  assert.deepEqual(decodeRegister('TEX0_2', value), fields);
});

test('FRAME, ZBUF, TEST, SCISSOR and XYOFFSET decode', () => {
  assert.deepEqual(decodeRegister('FRAME_1', 0x00000000000a0000n), { FBP: 0, FBW: 10, PSM: 0, FBMSK: 0 });
  assert.deepEqual(decodeRegister('ZBUF_1', 0x0000000100000096n), { ZBP: 0x96, PSM: 0, ZMSK: 1 });
  assert.deepEqual(decodeRegister('TEST_1', 0x0000000000030000n), { ATE: 0, ATST: 0, AREF: 0, AFAIL: 0, DATE: 0, DATM: 0, ZTE: 1, ZTST: 1 });
  assert.deepEqual(decodeRegister('SCISSOR_1', 0x01bf0000027f0000n), { SCAX0: 0, SCAX1: 639, SCAY0: 0, SCAY1: 447 });
  assert.deepEqual(decodeRegister('XYOFFSET_1', 0x0000800000008000n), { OFX: 0x8000, OFY: 0x8000 });
});

test('XYZ2 and XYZF2 decode position, depth and fog', () => {
  assert.deepEqual(decodeRegister('XYZ2', 0x12345678_9abc_8000n), { X: 0x8000, Y: 0x9abc, Z: 0x12345678 });
  assert.deepEqual(decodeRegister('XYZF3', 0x7f_345678_9abc_8000n), { X: 0x8000, Y: 0x9abc, Z: 0x345678, F: 0x7f });
});

test('a register with no decoder gives no fields', () => {
  assert.deepEqual(decodeRegister('SIGNAL', 1n), {});
  assert.deepEqual(decodeRegister('0x7e', 1n), {});
});

test('hex64 pads to sixteen digits', () => {
  assert.equal(hex64(0x44n), '0x0000000000000044');
  assert.equal(hex64(0xffffffffffffffffn), '0xffffffffffffffff');
});

test('TEX1.K is a signed twelve-bit value', () => {
  assert.equal(decodeRegister('TEX1_1', 0xff0n << 32n).K, -16);
  assert.equal(decodeRegister('TEX1_1', 0x010n << 32n).K, 16);
});

test('ZBUF.PSM is six bits wide', () => {
  assert.equal(decodeRegister('ZBUF_1', 0x3000008cn).PSM, 0x30);
});

test('0x11 is named RGBAQ', () => {
  assert.equal(registerName(0x11), 'RGBAQ');
});
