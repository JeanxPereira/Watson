import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTrace, compareTraceToDump, sourceAt, describeSource, formatTrace } from '../dist/gs/trace.js';
import { dumpPackets } from '../dist/gsdump.js';

const u32 = (...values) => { const b = Buffer.alloc(4 * values.length); values.forEach((v, i) => b.writeUInt32LE(v >>> 0, 4 * i)); return b; };
const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (seed + i) & 0xff));

const header = { type: 'header', version: 1, frame: 500 };
const gif = { type: 'origin', id: 1, channel: 'gif', frame: 500, chcr: '0x00000105', madr: '0x00400000', qwc: 0, tadr: '0x00400000', pc: '0x00201000', ra: '0x00202000', sp: '0x01fff000', stack: [{ entry: '0x00200f00', pc: '0x00201000', sp: '0x01fff000' }] };
const vif = { ...gif, id: 2, channel: 'vif1', pc: '0x00203000', ra: '0x00204000' };
const data = (pathNo, kind, origin, space, address, size, extra = {}) => ({ type: 'data', path: pathNo, kind, origin, space, address, size, ...extra });
const packet = (pathNo, payload, pending = 0) => ({ type: 'packet', path: pathNo, size: payload.length, pending, hex: payload.toString('hex') });
const vsync = { type: 'vsync', frame: 501 };

function traceFile(records, { end = true, cut = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-trace-'));
  const file = path.join(dir, 'a.trace.jsonl');
  const packets = records.filter((r) => r.type === 'packet').length;
  let text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  if (end) text += `${JSON.stringify({ type: 'end', packets })}\n`;
  if (cut) text = text.slice(0, -10);
  fs.writeFileSync(file, text);
  return file;
}

/** A dump holding these transfers and vsyncs, in order; every transfer carries path id 3. */
function dumpOf(items) {
  const parts = [u32(0xFFFFFFFF, 36), u32(9, 4, 36, 0, 0, 0, 0, 36, 0), Buffer.alloc(4), Buffer.alloc(8192)];
  for (const item of items) {
    if (item === 'vsync') parts.push(Buffer.from([3]), Buffer.alloc(8192), Buffer.from([1, 0]));
    else parts.push(Buffer.from([0, 3]), u32(item.length), item);
  }
  return Buffer.concat(parts);
}

const A = bytes(32, 1), B = bytes(48, 100), C = bytes(16, 200);

test('dumpPackets yields transfers with their bytes and vsyncs, in file order', () => {
  const kinds = [...dumpPackets(dumpOf([A, 'vsync', B]))].map((p) => (p.type === 'transfer' ? `t${p.path}:${p.data.length}` : p.type));
  assert.deepEqual(kinds, ['t3:32', 'registers', 'vsync', 't3:48']);
});

test('a trace reads into origins, packets after the first vsync, and where each later vsync falls', () => {
  const trace = readTrace(traceFile([header, gif, data(3, 'dma', 1, 'ee', 0x400000, 16), packet(3, C), vsync,
    data(3, 'dma', 1, 'ee', 0x400010, 32), packet(3, A), vsync, data(3, 'dma', 1, 'ee', 0x400030, 48), packet(3, B)]));
  assert.equal(trace.complete, true);
  assert.equal(trace.frame, 500);
  assert.equal(trace.origins.get(1).pc, '0x00201000');
  assert.equal(trace.preroll.length, 1);
  assert.deepEqual(trace.packets.map((p) => p.bytes.length), [32, 48]);
  assert.deepEqual(trace.vsyncAt, [1]);
  assert.deepEqual(trace.packets[0].sources, [{ kind: 'dma', origin: 1, space: 'ee', address: 0x400010, size: 32 }]);
  assert.deepEqual(trace.desyncs, []);
});

test('a packet fed by two chunks names both, each with its own bytes', () => {
  const trace = readTrace(traceFile([header, vif, vsync,
    data(1, 'xgkick', 2, 'vu1', 0x100, 16, { vuTpc: '0x0120' }), data(1, 'xgkick', 2, 'vu1', 0x200, 32, { vuTpc: '0x0340' }),
    packet(1, B)]));
  assert.deepEqual(trace.packets[0].sources.map((s) => [s.address, s.size, s.vuTpc]), [[0x100, 16, '0x0120'], [0x200, 32, '0x0340']]);
  assert.equal(sourceAt(trace.packets[0], 0).address, 0x100);
  assert.equal(sourceAt(trace.packets[0], 24).address, 0x208);
  assert.equal(sourceAt(trace.packets[0], 24).vuTpc, '0x0340');
});

test('one chunk split across two packets keeps its address moving', () => {
  const trace = readTrace(traceFile([header, gif, vsync, data(3, 'dma', 1, 'ee', 0x400000, 80), packet(3, A, 48), packet(3, B, 0)]));
  assert.deepEqual(trace.packets.map((p) => p.sources.map((s) => [s.address, s.size])), [[[0x400000, 32]], [[0x400020, 48]]]);
  assert.deepEqual(trace.desyncs, []);
});

test('bytes a path took back are not attributed', () => {
  const trace = readTrace(traceFile([header, gif, vsync, data(3, 'dma', 1, 'ee', 0x400000, 48), { type: 'rewind', path: 3, size: 16 },
    packet(3, A, 0), data(3, 'dma', 1, 'ee', 0x400020, 16), packet(3, C, 0)]));
  assert.deepEqual(trace.packets.map((p) => p.sources.map((s) => [s.address, s.size])), [[[0x400000, 32]], [[0x400020, 16]]]);
  assert.deepEqual(trace.desyncs, []);
});

test('bytes that were in a path before the trace began have no origin', () => {
  const trace = readTrace(traceFile([header, data(2, 'pending', 0, 'unknown', 0, 16), vsync, vif, data(2, 'direct', 2, 'ee', 0x500000, 16), packet(2, A, 0)]));
  assert.deepEqual(trace.packets[0].sources.map((s) => [s.kind, s.origin, s.size]), [['pending', 0, 16], ['direct', 2, 16]]);
  assert.equal(describeSource(trace, 2, trace.packets[0].sources[0]), 'PATH2 pending, origin unknown');
});

test('a queue that disagrees with the emulator is counted and restarted from its count', () => {
  const trace = readTrace(traceFile([header, gif, vsync, data(3, 'dma', 1, 'ee', 0x400000, 32), packet(3, A, 16),
    data(3, 'dma', 1, 'ee', 0x400100, 16), packet(3, C, 16)]));
  assert.deepEqual(trace.desyncs, [0]);
  assert.deepEqual(trace.packets[1].sources.map((s) => [s.kind, s.size]), [['unknown', 16]]);
});

test('a packet with more bytes than the queue holds gets an unknown remainder', () => {
  const trace = readTrace(traceFile([header, gif, vsync, data(3, 'dma', 1, 'ee', 0x400000, 16), packet(3, A, 0)]));
  assert.deepEqual(trace.packets[0].sources.map((s) => [s.kind, s.size]), [['dma', 16], ['unknown', 16]]);
  assert.deepEqual(trace.desyncs, [0]);
});

test('a trace that was never stopped is not complete, and says so', () => {
  const trace = readTrace(traceFile([header, vsync, data(3, 'dma', 0, 'host', 0, 32), packet(3, A)], { end: false }));
  assert.equal(trace.complete, false);
  assert.match(trace.reason, /no end record/);
});

test('a trace cut inside a line is not complete', () => {
  const trace = readTrace(traceFile([header, vsync, data(3, 'dma', 0, 'host', 0, 32), packet(3, A)], { cut: true }));
  assert.equal(trace.complete, false);
  assert.match(trace.reason, /cut|no end record/);
});

test('a trace whose end record counts other packets than it holds is not complete', () => {
  const file = traceFile([header, vsync, data(3, 'dma', 0, 'host', 0, 32), packet(3, A)], { end: false });
  fs.appendFileSync(file, `${JSON.stringify({ type: 'end', packets: 9 })}\n`);
  assert.match(readTrace(file).reason, /9 packets.*holds 1/);
});

test('a file that is not there is not complete', () => {
  assert.match(readTrace(path.join(os.tmpdir(), 'watson-no-such-trace.jsonl')).reason, /cannot read/);
});

test('a trace equals the dump of the same frames: same packets, same vsync positions', () => {
  const trace = readTrace(traceFile([header, gif, data(3, 'dma', 1, 'ee', 0, 16), packet(3, C), vsync,
    data(3, 'dma', 1, 'ee', 0, 32), packet(3, A), vsync, data(3, 'dma', 1, 'ee', 0, 48), packet(3, B), vsync,
    data(3, 'dma', 1, 'ee', 0, 16), packet(3, C)]));
  assert.deepEqual(compareTraceToDump(trace, dumpOf([A, 'vsync', B, 'vsync'])), { transfers: 2, matched: 2, vsyncs: 2 });
});

test('a dump from another capture is refused at the first packet that differs', () => {
  const trace = readTrace(traceFile([header, vsync, data(3, 'dma', 0, 'host', 0, 32), packet(3, A), data(3, 'dma', 0, 'host', 0, 48), packet(3, B), vsync]));
  const other = Buffer.from(B); other[5] ^= 0xff;
  const parity = compareTraceToDump(trace, dumpOf([A, other, 'vsync']));
  assert.equal(parity.matched, 1);
  assert.match(parity.mismatch, /packet 1.*byte 5/);
});

test('a dump with more packets than the trace, or a vsync elsewhere, is a mismatch', () => {
  const trace = readTrace(traceFile([header, vsync, data(3, 'dma', 0, 'host', 0, 32), packet(3, A), vsync]));
  assert.match(compareTraceToDump(trace, dumpOf([A, B, 'vsync'])).mismatch, /packet 1.*trace holds 1/);
  assert.match(compareTraceToDump(trace, dumpOf(['vsync', A])).mismatch, /vsync 0/);
});

test('the summary names paths, origins and ends with the build and verdict lines', () => {
  const trace = readTrace(traceFile([header, gif, vif, vsync, data(3, 'dma', 1, 'ee', 0x400000, 32), packet(3, A),
    data(1, 'xgkick', 2, 'vu1', 0x100, 48, { vuTpc: '0x0120' }), packet(1, B), vsync]));
  const parity = compareTraceToDump(trace, dumpOf([A, B, 'vsync']));
  const text = formatTrace(trace, parity, { trace: 'a.trace.jsonl', dump: 'a.gs' });
  assert.match(text, /PATH3 dma, DMA started at pc 0x00201000 ra 0x00202000/);
  assert.match(text, /PATH1 xgkick vuTpc 0x0120, DMA started at pc 0x00203000 ra 0x00204000/);
  assert.match(text, /build: unknown\nverdict: FOUND 2 packets  coverage 2\/2$/);
});

test('the summary of a mismatch or a lost queue is PARTIAL', () => {
  const trace = readTrace(traceFile([header, vsync, data(3, 'dma', 0, 'host', 0, 32), packet(3, A), vsync]));
  const text = formatTrace(trace, compareTraceToDump(trace, dumpOf([B, 'vsync'])), { trace: 't', dump: 'd' });
  assert.match(text, /verdict: PARTIAL the trace and the dump differ: .*coverage 0\/1$/);
});
