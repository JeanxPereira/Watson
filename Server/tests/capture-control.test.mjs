import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient, probeString, padString, writeString } from '../dist/debug-server-client.js';
import { takeGifTrace } from '../dist/navigation.js';
import { readTrace, compareTraceToDump, formatTrace } from '../dist/gs/trace.js';

// ---------- wire grammar ----------

test('probeString writes a probe window as @from-until, either side optional', () => {
  assert.equal(probeString([{ pc: '0x100', ranges: ['a0:0x10'], fromFrame: 30, untilFrame: 40 }]), '0x100@30-40=a0:0x10');
  assert.equal(probeString([{ pc: '0x100', fromFrame: 5 }]), '0x100@5-');
  assert.equal(probeString([{ pc: '0x100', untilFrame: 9 }]), '0x100@-9');
  assert.equal(probeString([{ pc: '0x100' }]), '0x100');
});

test('probeString refuses a window that is empty or not whole frames', () => {
  assert.throws(() => probeString([{ pc: '0x100', fromFrame: 4, untilFrame: 4 }]), /window of probe 0x100/);
  assert.throws(() => probeString([{ pc: '0x100', fromFrame: -1 }]), /window of probe 0x100/);
  assert.throws(() => probeString([{ pc: '0x100', untilFrame: 1.5 }]), /window of probe 0x100/);
});

test('padString writes frame:frames:buttons, buttons joined by +', () => {
  assert.equal(padString([{ frame: 0, press: ['cross'], frames: 6 }, { frame: 60, press: ['up', 'l1'], frames: 2 }]), '0:6:cross;60:2:up+l1');
  assert.equal(padString([]), '');
});

test('padString refuses unknown buttons, no buttons, and frames out of range', () => {
  assert.throws(() => padString([{ frame: 0, press: ['jump'], frames: 1 }]), /unknown button jump/);
  assert.throws(() => padString([{ frame: 0, press: [], frames: 1 }]), /no buttons/);
  assert.throws(() => padString([{ frame: -1, press: ['up'], frames: 1 }]), /frame/);
  assert.throws(() => padString([{ frame: 0, press: ['up'], frames: 0 }]), /frames/);
});

test('writeString writes frame:address:hex and refuses what is not hex bytes', () => {
  assert.equal(writeString([{ frame: 30, address: '0x1F000C', hex: '74000000' }, { frame: 0, address: '100', hex: 'ab' }]), '30:0x1f000c:74000000;0:0x100:ab');
  assert.equal(writeString([]), '');
  assert.throws(() => writeString([{ frame: 0, address: 'main', hex: '00' }]), /address "main"/);
  assert.throws(() => writeString([{ frame: 0, address: '0x10', hex: 'abc' }]), /whole bytes/);
  assert.throws(() => writeString([{ frame: 0, address: '0x10', hex: '' }]), /whole bytes/);
  assert.throws(() => writeString([{ frame: 0, address: '0x10', hex: 'zz' }]), /whole bytes/);
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

test('gifTraceStart sends the pad and write schedules only when there are some', async () => {
  const seen = [];
  const server = await fakeServer((req, socket) => { seen.push(req); socket.write('{"ok":true}\n'); });
  const client = new DebugServerClient('127.0.0.1', server.address().port);
  await client.connect();
  try {
    await client.gifTraceStart('D:/a/t.jsonl', [], 'plain', {});
    await client.gifTraceStart('D:/a/t.jsonl', [], 'plain', { pad: [{ frame: 1, press: ['cross'], frames: 2 }], writes: [{ frame: 3, address: '0x10', hex: '01' }] });
    assert.deepEqual(seen, [
      { cmd: 'gif_trace_start', path: 'D:/a/t.jsonl', mode: 'plain' },
      { cmd: 'gif_trace_start', path: 'D:/a/t.jsonl', mode: 'plain', pad: '1:2:cross', writes: '3:0x10:01' },
    ]);
  } finally {
    client.disconnect();
    server.close();
  }
});

// ---------- navigation ----------

function tracer() {
  const calls = [];
  return {
    calls,
    async pause() { calls.push(['pause']); },
    async gifTraceStart(_file, probes, mode, schedule) { calls.push(['gifTraceStart', probes, mode, schedule]); },
    async gifTraceStop() { calls.push(['gifTraceStop']); return 0; },
    async padSet(buttons, value) { calls.push(['padSet', buttons.join(','), value]); },
    async frameAdvance(frames) { calls.push(['frameAdvance', frames]); return 0; },
    async queueSnapshot(file) { fs.writeFileSync(file, 'png'); fs.writeFileSync(file.replace(/\.png$/, '.gs'), dumpOf(Array(8).fill('vsync'))); },
  };
}
const shot = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watson-control-')), 'shot.png');

test('takeGifTrace hands the pad and write schedules to the trace, which applies them on the CPU thread', async () => {
  const emulator = tracer();
  const schedule = { pad: [{ frame: 0, press: ['cross'], frames: 6 }], writes: [{ frame: 2, address: '0x1f000c', hex: '74000000' }] };
  await takeGifTrace(emulator, shot(), 3, [], [], 'plain', schedule);
  assert.deepEqual(emulator.calls[1], ['gifTraceStart', [], 'plain', schedule]);
  // The schedule is the emulator's: the server presses nothing itself.
  assert.equal(emulator.calls.filter((call) => call[0] === 'padSet').length, 0);
});

test('takeGifTrace refuses a schedule entry at or past the last captured frame, before touching the VM', async () => {
  const emulator = tracer();
  await assert.rejects(takeGifTrace(emulator, shot(), 3, [], [], 'plain', { pad: [{ frame: 3, press: ['up'], frames: 1 }] }), /pad entry at frame 3.*3 frames/);
  await assert.rejects(takeGifTrace(emulator, shot(), 3, [], [], 'plain', { writes: [{ frame: 5, address: '0x10', hex: '00' }] }), /write at frame 5.*3 frames/);
  await assert.rejects(takeGifTrace(emulator, shot(), 3, [{ pc: '0x100', fromFrame: 3 }]), /probe 0x100 opens at frame 3.*3 frames/);
  assert.deepEqual(emulator.calls, []);
});

test('takeGifTrace refuses a button both held for the whole capture and scheduled', async () => {
  const emulator = tracer();
  await assert.rejects(takeGifTrace(emulator, shot(), 3, [], ['cross'], 'plain', { pad: [{ frame: 0, press: ['cross'], frames: 1 }] }), /cross is both held and scheduled/);
  assert.deepEqual(emulator.calls, []);
});

test('takeGifTrace without a schedule sends the trace what it always did', async () => {
  const emulator = tracer();
  await takeGifTrace(emulator, shot(), 1);
  assert.deepEqual(emulator.calls[1], ['gifTraceStart', [], 'interpreter', {}]);
});

// ---------- the capture file ----------

const u32 = (...values) => { const b = Buffer.alloc(4 * values.length); values.forEach((v, i) => b.writeUInt32LE(v >>> 0, 4 * i)); return b; };
function dumpOf(items) {
  const parts = [u32(0xFFFFFFFF, 36), u32(9, 4, 36, 0, 0, 0, 0, 36, 0), Buffer.alloc(4), Buffer.alloc(8192)];
  for (const item of items) {
    if (item === 'vsync') parts.push(Buffer.from([3]), Buffer.alloc(8192), Buffer.from([1, 0]));
    else parts.push(Buffer.from([0, 3]), u32(item.length), item);
  }
  return Buffer.concat(parts);
}
function traceFile(records) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watson-control-')), 'a.trace.jsonl');
  fs.writeFileSync(file, `${[...records, { type: 'end', packets: 0 }].map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}
const hex8 = (values) => values.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
const probe = (captureFrame) => ({ type: 'probe', pc: '0x00000100', probe: 0, frame: 10, captureFrame, gpr: hex8(Array(32).fill(0)), fpr: hex8(Array(32).fill(0)), mem: [] });

test('a capture names the frame each input was applied at, and each probe record its capture frame', () => {
  const trace = readTrace(traceFile([
    { type: 'header', version: 1, frame: 10, probes: '0x100@1-2', pad: '0:2:cross', writes: '1:0x1f000c:74000000' },
    { type: 'vsync', frame: 10 },
    { type: 'pad', captureFrame: 0, frame: 10, press: ['cross'], release: [], held: ['cross'] },
    { type: 'vsync', frame: 11 },
    { type: 'write', captureFrame: 1, frame: 11, address: '0x001f000c', hex: '74000000' },
    probe(1),
    { type: 'vsync', frame: 12 },
    { type: 'pad', captureFrame: 2, frame: 12, press: [], release: ['cross'], held: [] },
  ]));
  assert.equal(trace.complete, true, trace.reason);
  assert.equal(trace.padSpec, '0:2:cross');
  assert.equal(trace.writeSpec, '1:0x1f000c:74000000');
  assert.deepEqual(trace.inputs, [
    { type: 'pad', captureFrame: 0, frame: 10, press: ['cross'], release: [], held: ['cross'] },
    { type: 'write', captureFrame: 1, frame: 11, address: 0x1f000c, bytes: Buffer.from('74000000', 'hex') },
    { type: 'pad', captureFrame: 2, frame: 12, press: [], release: ['cross'], held: [] },
  ]);
  assert.equal(trace.probes[0].captureFrame, 1);
});

test('the summary lists the inputs by capture frame', () => {
  const trace = readTrace(traceFile([
    { type: 'header', version: 1, frame: 10 },
    { type: 'vsync', frame: 10 },
    { type: 'pad', captureFrame: 0, frame: 10, press: ['cross'], release: [], held: ['cross'] },
    { type: 'write', captureFrame: 0, frame: 10, address: '0x001f000c', hex: '74000000' },
    { type: 'vsync', frame: 11 },
  ]));
  const text = formatTrace(trace, compareTraceToDump(trace, dumpOf(['vsync'])), { trace: 't', dump: 'd' });
  assert.match(text, /inputs: 2\n\s+frame 0: press cross\n\s+frame 0: write 4 bytes at 0x001f000c/);
});

test('an older capture reads with no inputs and probes without a capture frame', () => {
  const trace = readTrace(traceFile([{ type: 'header', version: 1, frame: 10 }, { type: 'vsync', frame: 10 }, { ...probe(0), captureFrame: undefined }]));
  assert.equal(trace.complete, true, trace.reason);
  assert.deepEqual(trace.inputs, []);
  assert.equal(trace.padSpec, '');
  assert.equal(trace.probes[0].captureFrame, undefined);
});

// ---------- the tools ----------

test('both capture tools take pad, writes and probe windows, and say a patch can be overwritten by loading code', async () => {
  const client = new Client({ name: 'watson-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
  const { tools } = await client.listTools();
  await client.close();
  for (const name of ['watson_gif_trace', 'watson_frame_capture']) {
    const tool = tools.find((t) => t.name === name);
    const props = tool.inputSchema.properties;
    assert.ok(props.pad, `${name} has no pad`);
    assert.ok(props.writes, `${name} has no writes`);
    assert.ok(props.probes.items.properties.fromFrame, `${name} has no fromFrame`);
    assert.ok(props.probes.items.properties.untilFrame, `${name} has no untilFrame`);
    assert.match(props.writes.description, /overwritten/);
  }
});
