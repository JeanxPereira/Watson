import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseGsDump, formatSummary, describeAlpha } from '../dist/gs/parse.js';
import { REG } from '../dist/gs/registers.js';
import { dumpPackets } from '../dist/gsdump.js';

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
  assert.deepEqual(records[3], { type: 'frame', index: 0, field: 0, draws: 1, primitives: 2 });
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

test('the output is never the dump itself', () => {
  const bytes = dump(SCENE);
  const { file } = write(bytes);
  assert.throws(() => parseGsDump(file, file), /would overwrite the dump/);
  assert.equal(fs.readFileSync(file).length, bytes.length);
});

test('a refused parse removes an output left by an earlier run and leaves no temporary file', () => {
  const whole = dump(SCENE);
  const { file, out } = write(whole.subarray(0, whole.length - 3000));
  fs.writeFileSync(out, 'stale');
  assert.throws(() => parseGsDump(file, out));
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(out + '.tmp'), false);
});

test('a draw, a transfer and a draw come out in that order', () => {
  const sprite = [tag({ nloop: 2, regs: [5] }), packedXyz(0, 0), packedXyz(8, 8)];
  const gif = [
    tag({ nloop: 1, regs: [0xe] }), aPlusD(REG.PRIM, 0x6n), ...sprite,
    tag({ nloop: 1, regs: [0xe] }), aPlusD(REG.TRXDIR, 2n), ...sprite,
  ];
  const { file, out } = write(dump(gif));
  parseGsDump(file, out);
  assert.deepEqual(lines(out).map((r) => r.type), ['header', 'state', 'draw', 'transfer', 'draw', 'frame']);
});

test('with writes on, tags and register writes are recorded in arrival order', () => {
  const { file, out } = write(dump(SCENE));
  parseGsDump(file, out, { writes: true });
  const records = lines(out);
  assert.deepEqual(records.filter((r) => r.type === 'tag').map((r) => [r.path, r.nloop, r.flg]), [[2, 3, 0], [2, 4, 0]]);
  const written = records.filter((r) => r.type === 'write');
  assert.equal(written.length, 7);
  assert.deepEqual(written.slice(0, 3).map((r) => [r.reg, r.value]), [
    ['PRIM', '0x0000000000000044'], ['ALPHA_1', '0x0000000000000044'], ['FRAME_1', '0x00000000000a0000'],
  ]);
  assert.equal(records.findIndex((r) => r.type === 'write'), records.findIndex((r) => r.type === 'tag') + 1);
});

test('the frame record carries the vsync field', () => {
  const { file, out } = write(dump(SCENE));
  parseGsDump(file, out);
  assert.equal(lines(out).at(-1).field, 0);
});

test('many frames parse and leave no temporary file', () => {
  const blob = stateBlob();
  const body = Buffer.concat(SCENE);
  const frame = Buffer.concat([Buffer.from([0, 2]), u32(body.length), body, Buffer.from([3]), Buffer.alloc(8192), Buffer.from([1, 0])]);
  const many = Buffer.concat([u32(0xFFFFFFFF, 36), u32(9, blob.length, 36, 0, 0, 0, 0, 36, 0), blob, Buffer.alloc(8192), ...Array(300).fill(frame)]);
  const { file, out } = write(many);
  const summary = parseGsDump(file, out);
  assert.equal(summary.frames, 300);
  assert.equal(lines(out).filter((r) => r.type === 'frame').length, 300);
  assert.equal(fs.existsSync(out + '.tmp'), false);
});

test('a summary with no draws says EMPTY', () => {
  const { file, out } = write(dump([tag({ nloop: 1, regs: [0xe] }), aPlusD(REG.DTHE, 1n)]));
  const text = formatSummary(parseGsDump(file, out), file, out).trimEnd().split(String.fromCharCode(10));
  assert.match(text.at(-1), /^verdict: EMPTY {2}coverage/);
});

const CLI = path.resolve('dist', 'cli.js');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('the CLI refuses --out with no value and writes nothing', () => {
  const { file, out } = write(dump(SCENE));
  const result = run('parse', file, '--out');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--out needs a file/);
  assert.equal(fs.existsSync(out), false);
});

test('the CLI answers a truncated dump with NOT VERIFIED and exit 2', () => {
  const whole = dump(SCENE);
  const { file } = write(whole.subarray(0, whole.length - 3000));
  const result = run('parse', file);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /build: unknown/);
  assert.match(result.stdout, /verdict: NOT VERIFIED .*more bytes/);
});

test('the CLI parses a dump and exits 0', () => {
  const { file, out } = write(dump(SCENE));
  const result = run('parse', file);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /verdict: FOUND 1/);
  assert.equal(fs.existsSync(out), true);
});

function traceFor(file, sources, { corrupt = false } = {}) {
  const records = [{ type: 'header', version: 1, frame: 0 },
    { type: 'origin', id: 1, channel: 'vif1', frame: 0, chcr: '0x00000145', madr: '0x00300000', qwc: 0, tadr: '0x00300000', pc: '0x00220000', ra: '0x00221000', sp: '0x01ff0000', stack: [] },
    { type: 'vsync', frame: 0 }];
  let packets = 0;
  for (const packet of dumpPackets(fs.readFileSync(file))) {
    if (packet.type === 'vsync') records.push({ type: 'vsync', frame: 1 });
    if (packet.type !== 'transfer') continue;
    const data = Buffer.from(packet.data);
    if (corrupt) data[0] ^= 0xff;
    for (const source of sources(data.length)) records.push({ type: 'data', path: 1, ...source });
    records.push({ type: 'packet', path: 1, size: data.length, pending: 0, hex: data.toString('hex') });
    packets += 1;
  }
  records.push({ type: 'end', packets });
  const trace = file.replace(/\.gs$/, '.trace.jsonl');
  fs.writeFileSync(trace, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return trace;
}

test('every draw says which packet and byte drew its first primitive', () => {
  const { file, out } = write(dump(SCENE));
  parseGsDump(file, out);
  const draw = lines(out).find((r) => r.type === 'draw');
  assert.equal(draw.packet, 0);
  assert.equal(draw.at, 112);   // tag, three A+D, tag, two vertices: the third vertex completes the first triangle
});

test('with a trace, a draw names the chunk and origin its first primitive came from', () => {
  const { file, out } = write(dump(SCENE));
  const trace = traceFor(file, (size) => [
    { kind: 'xgkick', origin: 1, space: 'vu1', address: 0x100, size: 64, vuTpc: '0x0120' },
    { kind: 'xgkick', origin: 1, space: 'vu1', address: 0x800, size: size - 64, vuTpc: '0x0340' }]);
  const summary = parseGsDump(file, out, { trace });
  const records = lines(out);
  assert.deepEqual(records.map((r) => r.type), ['header', 'state', 'origin', 'draw', 'frame']);
  assert.deepEqual(records[3].source, { path: 1, kind: 'xgkick', origin: 1, space: 'vu1', address: 0x800 + 112 - 64, vuTpc: '0x0340' });
  assert.deepEqual(summary.sources, { 'PATH1 xgkick vuTpc 0x0340, DMA started at pc 0x00220000 ra 0x00221000': 1 });
  assert.match(formatSummary(summary, file, out), /draw sources:\n\s+1  PATH1 xgkick vuTpc 0x0340/);
});

test('a trace of another capture is refused and no output is left', () => {
  const { file, out } = write(dump(SCENE));
  const trace = traceFor(file, (size) => [{ kind: 'dma', origin: 0, space: 'host', address: 0, size }], { corrupt: true });
  assert.throws(() => parseGsDump(file, out, { trace }), /is not a trace of this dump: packet 0 differs at byte 0/);
  assert.equal(fs.existsSync(out), false);
});

test('a trace that was never stopped is refused', () => {
  const { file, out } = write(dump(SCENE));
  const trace = traceFor(file, (size) => [{ kind: 'dma', origin: 0, space: 'host', address: 0, size }]);
  fs.writeFileSync(trace, fs.readFileSync(trace, 'utf8').split('\n').slice(0, -2).join('\n') + '\n');
  assert.throws(() => parseGsDump(file, out, { trace }), /no end record/);
});

test('the CLI takes --trace and refuses it with no value', () => {
  const { file } = write(dump(SCENE));
  const trace = traceFor(file, (size) => [{ kind: 'dma', origin: 0, space: 'host', address: 0, size }]);
  const good = spawnSync(process.execPath, ['dist/cli.js', 'parse', file, '--trace', trace], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /draw sources:/);
  const bad = spawnSync(process.execPath, ['dist/cli.js', 'parse', file, '--trace'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--trace needs a file/);
});
