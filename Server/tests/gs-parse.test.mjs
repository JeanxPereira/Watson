import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGsDump, formatSummary, describeAlpha } from '../dist/gs/parse.js';
import { REG } from '../dist/gs/registers.js';

const u32 = (...values) => { const b = Buffer.alloc(4 * values.length); values.forEach((v, i) => b.writeUInt32LE(v >>> 0, 4 * i)); return b; };
const qword = (lo, hi = 0n) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt.asUintN(64, lo), 0); b.writeBigUInt64LE(BigInt.asUintN(64, hi), 8); return b; };
const tag = ({ nloop, pre = 0, prim = 0, flg = 0, regs }) => {
  const lo = BigInt(nloop) | (1n << 15n) | (BigInt(pre) << 46n) | (BigInt(prim) << 47n) | (BigInt(flg) << 58n) | (BigInt(regs.length % 16) << 60n);
  let hi = 0n; regs.forEach((r, i) => { hi |= BigInt(r) << BigInt(4 * i); });
  return qword(lo, hi);
};
const aPlusD = (address, value) => qword(value, BigInt(address));
const packedXyz = (px, py) => qword((BigInt(0x8000 + py * 16) << 32n) | BigInt(0x8000 + px * 16), 0n);

const OFFSET = 0x0000800000008000n;

function stateBlob() {
  const b = Buffer.alloc(364 + 61 + 4 * 1024 * 1024 + 80 + 4);
  b.writeUInt32LE(9, 0);
  b.writeBigUInt64LE(1n, 4 + 8);                    // PRMODECONT.AC = 1
  b.writeBigUInt64LE(OFFSET, 124);                  // XYOFFSET_1
  b.writeBigUInt64LE(OFFSET, 124 + 96);             // XYOFFSET_2
  return b;
}

function dump(gif, { extraAddress } = {}) {
  const blob = stateBlob();
  const body = Buffer.concat(extraAddress === undefined ? gif : [tag({ nloop: 1, regs: [0xe] }), aPlusD(extraAddress, 1n), ...gif]);
  return Buffer.concat([
    u32(0xFFFFFFFF, 36), u32(9, blob.length, 36, 0, 0, 0, 0, 36, 0), blob, Buffer.alloc(8192),
    Buffer.from([0, 2]), u32(body.length), body,
    Buffer.from([3]), Buffer.alloc(8192), Buffer.from([1, 0]),
  ]);
}

const SCENE = [
  tag({ nloop: 3, regs: [0xe] }),
  aPlusD(REG.PRIM, 0x44n),                          // tristrip, ABE
  aPlusD(REG.ALPHA_1, 0x44n),                       // (Cs - Cd) * As + Cd
  aPlusD(REG.FRAME_1, 0xa0000n),                    // FBP 0, FBW 10
  tag({ nloop: 4, regs: [5] }),
  packedXyz(0, 0), packedXyz(10, 0), packedXyz(0, 10), packedXyz(10, 10),
];

function write(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-parse-'));
  const file = path.join(dir, 'scene.gs');
  fs.writeFileSync(file, bytes);
  return { file, out: path.join(dir, 'scene.jsonl') };
}
const lines = (out) => fs.readFileSync(out, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));

test('a dump parses into a header, the initial state, its draws and a frame record', () => {
  const { file, out } = write(dump(SCENE));
  const summary = parseGsDump(file, out);
  assert.equal(summary.frames, 1);
  assert.equal(summary.draws, 1);
  assert.equal(summary.writes, 7);
  assert.deepEqual(summary.byPrimitive, { tristrip: 1 });
  assert.deepEqual(summary.perFrame, [{ draws: 1, primitives: 2 }]);
  assert.deepEqual(summary.alpha, { '(Cs - Cd) * As >> 7 + Cd': 1 });
  assert.deepEqual(summary.frameTargets, { 'FBP 0x000 FBW 10 PSM 0x00': 1 });

  const records = lines(out);
  assert.deepEqual(records.map((r) => r.type), ['header', 'state', 'draw', 'frame']);
  assert.equal(records[0].stateVersion, 9);
  assert.equal(records[1].context1.XYOFFSET, '0x0000800000008000');
  assert.equal(records[2].primitives, 2);
  assert.equal(records[2].vertices.length, 4);
  assert.deepEqual(records[2].bbox, [0, 0, 10, 10]);
  assert.equal(records[2].state.ALPHA, '0x0000000000000044');
  assert.deepEqual(records[2].decoded.ALPHA, { A: 0, B: 1, C: 0, D: 1, FIX: 0 });
  assert.deepEqual(records[3], { type: 'frame', index: 0, draws: 1, primitives: 2 });
});

test('a write to an unknown register is counted by number and parsing goes on', () => {
  const { file, out } = write(dump(SCENE, { extraAddress: 0x7e }));
  const summary = parseGsDump(file, out);
  assert.deepEqual(summary.unknownRegisters, { '0x7e': 1 });
  assert.equal(summary.draws, 1);
});

test('host uploads and VRAM-to-VRAM copies are recorded with where they go', () => {
  const upload = [
    tag({ nloop: 4, regs: [0xe] }),
    aPlusD(REG.BITBLTBUF, (0x2000n << 32n) | (4n << 48n) | (0x13n << 56n)),
    aPlusD(REG.TRXPOS, 0n), aPlusD(REG.TRXREG, (16n << 32n) | 16n), aPlusD(REG.TRXDIR, 0n),
    tag({ nloop: 16, flg: 2, regs: [] }), Buffer.alloc(256),
    tag({ nloop: 4, regs: [0xe] }),
    aPlusD(REG.BITBLTBUF, 0x0n | (10n << 16n) | (0x3000n << 32n) | (4n << 48n)),
    aPlusD(REG.TRXPOS, 0n), aPlusD(REG.TRXREG, (64n << 32n) | 128n), aPlusD(REG.TRXDIR, 2n),
  ];
  const { file, out } = write(dump([...upload, ...SCENE]));
  const summary = parseGsDump(file, out);
  assert.equal(summary.imageBytes, 256);
  assert.deepEqual(summary.uploads, { 'DBP 0x2000 DBW 4 PSM 0x13 16x16': 1 });
  assert.deepEqual(summary.copies, { 'SBP 0x0000 -> DBP 0x3000 128x64': 1 });
  assert.deepEqual(lines(out).filter((r) => r.type === 'transfer').map((r) => r.direction), ['host-to-local', 'local-to-local']);
});

test('a truncated dump is refused with the reason and leaves no output file', () => {
  const whole = dump(SCENE);
  const { file, out } = write(whole.subarray(0, whole.length - 3000));
  assert.throws(() => parseGsDump(file, out), /registers packet at offset \d+ needs \d+ more bytes/);
  assert.equal(fs.existsSync(out), false);
});

test('the alpha text follows the GS blend formula', () => {
  assert.equal(describeAlpha({ A: 0, B: 1, C: 0, D: 1, FIX: 0 }), '(Cs - Cd) * As >> 7 + Cd');
  assert.equal(describeAlpha({ A: 0, B: 2, C: 2, D: 1, FIX: 128 }), '(Cs - 0) * FIX(128) >> 7 + Cd');
  assert.equal(describeAlpha({ A: 1, B: 0, C: 1, D: 0, FIX: 0 }), '(Cd - Cs) * Ad >> 7 + Cs');
});

test('the summary text ends with the build and verdict lines', () => {
  const { file, out } = write(dump(SCENE));
  const text = formatSummary(parseGsDump(file, out), file, out).trimEnd().split('\n');
  assert.equal(text.at(-2), 'build: unknown');
  assert.match(text.at(-1), /^verdict: FOUND 1 {2}coverage \d+\/\d+$/);
});
