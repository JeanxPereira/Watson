import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkGsDump } from '../dist/gsdump.js';

const REGS = 8192;

function u32(...values) { const b = Buffer.alloc(4 * values.length); values.forEach((v, i) => b.writeUInt32LE(v >>> 0, 4 * i)); return b; }

function header(stateSize) {
  // 0xFFFFFFFF, header size, then GSDumpHeader: state_version, state_size, serial_offset,
  // serial_size, crc, screenshot_width, screenshot_height, screenshot_offset, screenshot_size.
  return Buffer.concat([u32(0xFFFFFFFF, 36), u32(9, stateSize, 36, 0, 0, 0, 0, 36, 0), Buffer.alloc(stateSize), Buffer.alloc(REGS)]);
}
const transfer = (pathId, size) => Buffer.concat([Buffer.from([0, pathId]), u32(size), Buffer.alloc(size, 0xAB)]);
const vsync = (field) => Buffer.from([1, field]);
const readFifo = (size) => Buffer.concat([Buffer.from([2]), u32(size)]);
const registers = () => Buffer.concat([Buffer.from([3]), Buffer.alloc(REGS)]);

function write(...parts) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watson-dump-')), 'x.gs');
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

test('a dump that ends exactly on a packet boundary is complete', () => {
  const file = write(header(8), transfer(2, 16), transfer(1, 32), readFifo(4), registers(), vsync(0), registers(), vsync(1));
  assert.deepEqual(walkGsDump(file), { complete: true, packets: 7, transfers: 2, vsyncs: 2, bytes: fs.statSync(file).size });
});

test('a dump cut inside a packet is not complete and says where', () => {
  const whole = Buffer.concat([header(8), transfer(2, 16), registers(), vsync(0)]);
  const cutAt = whole.length - 2 - 3000;
  const file = write(whole.subarray(0, cutAt));
  const walk = walkGsDump(file);
  assert.equal(walk.complete, false);
  assert.equal(walk.vsyncs, 0);
  assert.match(walk.reason, /registers packet at offset \d+ needs 3000 more bytes/);
});

test('a dump with no vsync is not complete', () => {
  const walk = walkGsDump(write(header(8), transfer(2, 16)));
  assert.equal(walk.complete, false);
  assert.match(walk.reason, /no vsync/);
});

test('an unknown packet type is reported with its offset', () => {
  const walk = walkGsDump(write(header(8), transfer(2, 16), Buffer.from([9])));
  assert.equal(walk.complete, false);
  assert.match(walk.reason, /unknown packet type 9 at offset \d+/);
});

test('a file that is not a current-format dump is refused', () => {
  const walk = walkGsDump(write(u32(0x12345678, 8), Buffer.alloc(64)));
  assert.equal(walk.complete, false);
  assert.match(walk.reason, /not a GS dump with the 0xFFFFFFFF header/);
});

test('a header cut short is not complete', () => {
  const walk = walkGsDump(write(header(8).subarray(0, 60)));
  assert.equal(walk.complete, false);
  assert.match(walk.reason, /header or state is cut short/);
});

test('a file that cannot be read is not complete and says why', () => {
  const walk = walkGsDump(path.join(os.tmpdir(), `watson-absent-${process.pid}.gs`));
  assert.equal(walk.complete, false);
  assert.match(walk.reason, /cannot read \(ENOENT\)/);
});
