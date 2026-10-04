import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { takeSpuTrace } from '../dist/spu/capture.js';
import { readSpuTrace, eventDigest, wavSamples, sha256 } from '../dist/spu/trace.js';

// Sound probes against a running emulator: WATSON_PORT names it, WATSON_EXPECT_VM=1 says a VM is
// booted (a state with sound playing makes these meaningful: the clock screen, for one).
const PORT = Number(process.env.WATSON_PORT) || 21512;
const EXPECT_VM = process.env.WATSON_EXPECT_VM === '1';

function listening() {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function session(t) {
  if (!(await listening())) { t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`); return null; }
  if (!EXPECT_VM) { t.skip('needs a running VM'); return null; }
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  await client.pause();
  return client;
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'watson-spu-live-'));
const hash = (file) => sha256(fs.readFileSync(file));

test('live: an SPU trace holds a frame record per frame, its samples in the WAV and the stage file', async (t) => {
  const client = await session(t);
  if (!client) return;
  try {
    const frames = 10;
    const files = await takeSpuTrace(client, path.join(scratch(), 'cap'), frames);
    const trace = readSpuTrace(files.trace);
    assert.equal(trace.complete, true, trace.reason);
    assert.equal(trace.frames.length, frames);
    assert.deepEqual(trace.frames.map((f) => f.captureFrame), [...Array(frames).keys()]);
    const samples = trace.end.samples;
    // 48 kHz over NTSC (59.94 Hz) or PAL (50 Hz) frames, give or take the mixer's lag.
    assert.ok(samples > frames * 700 && samples < frames * 1100, `${samples} samples in ${frames} frames`);
    assert.equal(wavSamples(files.wav).length, samples * 4);
    assert.equal(fs.statSync(files.stages).size, samples * 96);
    assert.equal(files.totals.samples, samples);
    // Every write is stamped with the sample it precedes, in order.
    for (let i = 1; i < trace.writes.length; i++) assert.ok(trace.writes[i].sample >= trace.writes[i - 1].sample);
  } finally {
    client.disconnect();
  }
});

test('live: a save state carries the SPU2: RAM, registers and voices read after loading equal those read live', async (t) => {
  const client = await session(t);
  if (!client) return;
  const dir = scratch();
  try {
    const state = path.join(dir, 'origin.p2s');
    const live = { ram: path.join(dir, 'live.ram'), regs: path.join(dir, 'live.regs'), state: path.join(dir, 'live.json') };
    const loaded = { ram: path.join(dir, 'loaded.ram'), regs: path.join(dir, 'loaded.regs'), state: path.join(dir, 'loaded.json') };
    await client.spuRead(live);
    await client.saveStateFile(state);
    await client.frameAdvance(30);
    await client.loadStateFile(state);
    await client.spuRead(loaded);
    assert.equal(fs.statSync(live.ram).size, 2 * 1024 * 1024);
    assert.equal(hash(loaded.ram), hash(live.ram));
    assert.equal(hash(loaded.regs), hash(live.regs));
    assert.deepEqual(JSON.parse(fs.readFileSync(loaded.state, 'utf8')), JSON.parse(fs.readFileSync(live.state, 'utf8')));
  } finally {
    client.disconnect();
  }
});

test('live: the same state and the same frames give the same SPU trace, output and stages', async (t) => {
  const client = await session(t);
  if (!client) return;
  const dir = scratch();
  try {
    const state = path.join(dir, 'origin.p2s');
    await client.saveStateFile(state);
    const runs = [];
    for (const name of ['a', 'b']) {
      await client.loadStateFile(state);
      const files = await takeSpuTrace(client, path.join(dir, name), 30);
      const trace = readSpuTrace(files.trace);
      assert.equal(trace.complete, true, trace.reason);
      runs.push({ events: eventDigest(trace), wav: sha256(wavSamples(files.wav)), stages: hash(files.stages), writes: trace.writes.length });
    }
    assert.deepEqual(runs[1], runs[0]);
  } finally {
    client.disconnect();
  }
});

test('live: an IOP probe records the IOP registers each time the IOP reaches its program counter', async (t) => {
  const client = await session(t);
  if (!client) return;
  try {
    // The IOP's exception vector: every interrupt (vblank, timers, SIF, DMA) enters there, a few
    // times a frame. A pc in a busy loop would fire millions of times.
    const pc = '0x80000080';
    const files = await takeSpuTrace(client, path.join(scratch(), 'probe'), 3, { probes: [{ pc, ranges: ['sp:0x10'] }], wav: false, stages: false });
    const trace = readSpuTrace(files.trace);
    assert.equal(trace.complete, true, trace.reason);
    assert.ok(trace.probes.length > 0, `no probe record at ${pc}`);
    const record = trace.probes[0];
    assert.equal(parseInt(record.pc, 16), parseInt(pc, 16));
    assert.equal(record.gpr.length, 256);
    const sp = parseInt(record.gpr.slice(29 * 8, 30 * 8), 16);
    assert.equal(record.mem[0].address, sp >>> 0);
    assert.equal(record.mem[0].hex.length, 32);
  } finally {
    client.disconnect();
  }
});
