import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { spuRegister, registerLabel, readSpuTrace, keyEvents, summarizeSpuTrace, eventDigest, wavSamples } from '../dist/spu/trace.js';
import { takeSpuTrace, spuFiles } from '../dist/spu/capture.js';

const label = (address) => registerLabel(spuRegister(address));

test('spuRegister names voice, address, core, volume and SPDIF registers as PCSX2 lays them out', () => {
  assert.equal(label(0x1f900054), 'c0.v5.PITCH');
  assert.equal(label(0x1f900400), 'c1.v0.VOLL');
  assert.equal(label(0x1f90017e), 'c0.v23.VOLXR');
  assert.equal(label(0x1f9001a0), 'c0.KON0');
  assert.equal(label(0x1f9005a2), 'c1.KON1');
  assert.equal(label(0x1f9001a6), 'c0.KOFF1');
  assert.equal(label(0x1f9001ac), 'c0.DATA');
  assert.equal(label(0x1f9001c0), 'c0.v0.SSAH');
  assert.equal(label(0x1f9001c0 + 12 * 3 + 4), 'c0.v3.LSAXH');
  assert.equal(label(0x1f9002de), 'c0.v23.NAXL');
  assert.equal(label(0x1f9002e0), 'c0.ESAH');
  assert.equal(label(0x1f9002e4), 'c0.APF1_SIZEH');
  assert.equal(label(0x1f9002e6), 'c0.APF1_SIZEL');
  assert.equal(label(0x1f900338), 'c0.APF2_R_DSTH');
  assert.equal(label(0x1f90033c), 'c0.EEA');
  assert.equal(label(0x1f900344), 'c0.STATX');
  assert.equal(label(0x1f900760), 'c0.MVOLL');
  assert.equal(label(0x1f900786), 'c0.IN_COEF_R');
  assert.equal(label(0x1f900788), 'c1.MVOLL');
  assert.equal(label(0x1f9007ae), 'c1.IN_COEF_R');
  assert.equal(label(0x1f9007c0), 'SPDIF_OUT');
});

const when = (frame, sample) => ({ captureFrame: frame, frame: 100 + frame, cycle: 1000 + sample * 768, sample });

function traceFile(records) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watson-spu-')), 't.spu.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const sample = () => [
  { type: 'header', version: 1, frame: 100, cycle: 1000, iopRecompiler: true, eeRecompiler: false },
  { type: 'frame', ...when(0, 0), lClocks: 1000, pending: 0 },
  { type: 'write', ...when(0, 3), pc: '0x00001000', address: '0x1f9001a0', value: '0x0005' },
  { type: 'write', ...when(0, 3), pc: '0x00001000', address: '0x1f9005a2', value: '0x0081' },
  { type: 'write', ...when(1, 900), pc: '0x00001000', address: '0x1f9001a4', value: '0x0001' },
  { type: 'dma', ...when(1, 901), core: 0, tsa: '0x05010', words: 2, adma: false, iopAddress: '0x0a0000', fnv1a64: '0' },
  { type: 'ram', ...when(1, 901), core: 0, kind: 'dma', address: '0x05010', words: 2, fnv1a64: '0', hex: '01000200' },
  { type: 'probe', cpu: 'iop', ...when(1, 902), pc: '0x00012345', probe: 0, gpr: '0'.repeat(256), hi: '0x0', lo: '0x0', mem: [] },
  { type: 'end', writes: 3, dmas: 1, samples: 1600, probes: 1, ...when(2, 1600) },
];

test('readSpuTrace reads every record kind and checks the end counts', () => {
  const trace = readSpuTrace(traceFile(sample()));
  assert.equal(trace.complete, true, trace.reason);
  assert.equal(trace.writes.length, 3);
  assert.equal(trace.dmas.length, 1);
  assert.equal(trace.rams.length, 1);
  assert.equal(trace.probes.length, 1);
  assert.equal(trace.frames.length, 1);
});

test('readSpuTrace refuses a trace without its end, or whose end disagrees with it', () => {
  assert.match(readSpuTrace(traceFile(sample().slice(0, -1))).reason, /no end record/);
  const short = sample().filter((r, i) => i !== 2);
  assert.match(readSpuTrace(traceFile(short)).reason, /counts 3 writes.*holds 2/);
  assert.match(readSpuTrace(traceFile([{ type: 'nope' }])).reason, /unknown type/);
});

test('keyEvents names the voices of each key-on and key-off, KON1 being voices 16 to 23', () => {
  const events = keyEvents(readSpuTrace(traceFile(sample())));
  assert.deepEqual(events, [
    { captureFrame: 0, sample: 3, core: 0, on: true, voices: [0, 2] },
    { captureFrame: 0, sample: 3, core: 1, on: true, voices: [16, 23] },
    { captureFrame: 1, sample: 900, core: 0, on: false, voices: [0] },
  ]);
});

test('eventDigest ignores where the trace started but not what it holds', () => {
  const a = readSpuTrace(traceFile(sample()));
  const shifted = sample().map((r) => (r.type === 'end' ? r : { ...r, cycle: r.cycle + 5000, frame: r.frame + 7 }));
  assert.equal(eventDigest(readSpuTrace(traceFile(shifted))), eventDigest(a));
  const changed = sample();
  changed[2] = { ...changed[2], value: '0x0006' };
  assert.notEqual(eventDigest(readSpuTrace(traceFile(changed))), eventDigest(a));
});

test('summarizeSpuTrace reports key-ons, the output and its hash, and refuses an incomplete trace', () => {
  const file = traceFile(sample());
  const wav = file.replace(/\.spu\.jsonl$/, '.wav');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.write('WAVEfmt ', 8, 'ascii'); header.write('data', 36, 'ascii');
  const pcm = Buffer.alloc(8); pcm.writeInt16LE(-300, 0); pcm.writeInt16LE(200, 6);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(wav, Buffer.concat([header, pcm]));
  assert.equal(wavSamples(wav).length, 8);
  const text = summarizeSpuTrace(readSpuTrace(file), { trace: file, wav });
  assert.match(text, /key-ons: 2 — f0 c0 \[0,2\]; f0 c1 \[16,23\]/);
  assert.match(text, /2 samples, peak 300, sha256 [0-9a-f]{64}/);
  assert.match(summarizeSpuTrace(readSpuTrace(traceFile(sample().slice(0, -1))), { trace: file }), /NOT VERIFIED/);
});

function tracer({ failAdvance = false } = {}) {
  const calls = [];
  return {
    calls,
    async pause() { calls.push(['pause']); },
    async spuTraceStart(file, options) { calls.push(['start', file, options]); return { iopRecompiler: true }; },
    async spuTraceStop() { calls.push(['stop']); return { writes: 0, dmas: 0, samples: 0, probes: 0 }; },
    async frameAdvance(frames) { calls.push(['advance', frames]); if (failAdvance) throw new Error('stopped'); return 0; },
  };
}

test('takeSpuTrace pauses, arms the trace with its files and schedule, runs the frames, stops', async () => {
  const stem = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watson-spu-')), 'cap');
  const emulator = tracer();
  const pad = [{ frame: 1, press: ['square'], frames: 6 }];
  const probes = [{ pc: '0x1234', ranges: ['a1:0x18'] }];
  const files = await takeSpuTrace(emulator, stem, 10, { pad, probes });
  assert.deepEqual(emulator.calls.map((c) => c[0]), ['pause', 'start', 'advance', 'stop']);
  assert.deepEqual(emulator.calls[1], ['start', `${stem}.spu.jsonl`, { wav: `${stem}.wav`, stages: `${stem}.stages.bin`, probes, pad, dmaData: undefined }]);
  assert.deepEqual(emulator.calls[2], ['advance', 10]);
  assert.equal(files.iopRecompiler, true);
  assert.deepEqual(spuFiles(stem, { wav: false, stages: false }), { trace: `${stem}.spu.jsonl` });
});

test('takeSpuTrace refuses a pad entry or probe window outside the frames, before touching the VM', async () => {
  const emulator = tracer();
  await assert.rejects(takeSpuTrace(emulator, 'x', 5, { pad: [{ frame: 5, press: ['square'], frames: 1 }] }), /frame 5 falls outside/);
  await assert.rejects(takeSpuTrace(emulator, 'x', 5, { probes: [{ pc: '0x10', fromFrame: 9 }] }), /opens at frame 9/);
  assert.deepEqual(emulator.calls, []);
});

test('takeSpuTrace stops the trace when the frames fail, and reports the failure', async () => {
  const stem = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watson-spu-')), 'cap');
  const emulator = tracer({ failAdvance: true });
  await assert.rejects(takeSpuTrace(emulator, stem, 3), /stopped/);
  assert.deepEqual(emulator.calls.map((c) => c[0]), ['pause', 'start', 'advance', 'stop']);
});

function fakeServer(onLine) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (d) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          onLine(JSON.parse(line), socket);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('spuTraceStart sends forward-slash paths, the IOP probes and the pad in the EE grammar; spuRead only the files asked for', async () => {
  const seen = [];
  const server = await fakeServer((req, socket) => { seen.push(req); socket.write('{"ok":true,"iop_recompiler":true,"frame":7}\n'); });
  const client = new DebugServerClient('127.0.0.1', server.address().port);
  await client.connect();
  try {
    await client.spuTraceStart('D:\\a\\t.spu.jsonl', { wav: 'D:\\a\\t.wav', probes: [{ pc: '0x738', ranges: ['a1:0x18'], fromFrame: 1 }], pad: [{ frame: 2, press: ['square'], frames: 6 }] });
    await client.spuTraceStart('D:/a/u.spu.jsonl', { dmaData: false });
    assert.equal(await client.spuRead({ ram: 'D:\\a\\r.bin' }), 7);
    assert.deepEqual(seen, [
      { cmd: 'spu_trace_start', path: 'D:/a/t.spu.jsonl', wav: 'D:/a/t.wav', probes: '0x738@1-=a1:0x18', pad: '2:6:square', dma_data: true },
      { cmd: 'spu_trace_start', path: 'D:/a/u.spu.jsonl', dma_data: false },
      { cmd: 'spu_read', ram: 'D:/a/r.bin', regs: '', state: '' },
    ]);
  } finally {
    client.disconnect();
    server.close();
  }
});
