import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DebugServerClient, probeString } from '../dist/debug-server-client.js';

const STATUS = '{"ok":true,"data":{"alive":true,"paused":false,"pc":"00100000","cycles":5}}\n';

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
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('status round trip', async () => {
  const seen = [];
  const server = await fakeServer((req, socket) => { seen.push(req); socket.write(STATUS); });
  const client = new DebugServerClient('127.0.0.1', server.address().port);
  await client.connect();
  const st = await client.getStatus();
  assert.equal(st.pc, '00100000');
  assert.equal(st.alive, true);
  assert.deepEqual(seen, [{ cmd: 'status', cpu: 'ee' }]);
  client.disconnect();
  server.close();
});

test('a response split across two chunks parses as one reply', async () => {
  const server = await fakeServer((_req, socket) => {
    socket.write(STATUS.slice(0, 20));
    setTimeout(() => socket.write(STATUS.slice(20)), 30);
  });
  const client = new DebugServerClient('127.0.0.1', server.address().port);
  await client.connect();
  const st = await client.getStatus();
  assert.equal(st.cycles, 5);
  client.disconnect();
  server.close();
});

test('a socket closed with a request pending rejects promptly', async () => {
  const server = await fakeServer((_req, socket) => socket.destroy());
  const client = new DebugServerClient('127.0.0.1', server.address().port);
  await client.connect();
  const started = Date.now();
  try {
    await assert.rejects(client.getStatus(), /closed/i);
    assert.ok(Date.now() - started < 2000, 'must not wait for the 10 s command timeout');
    assert.equal(client.isConnected(), false);
  } finally {
    server.close();
  }
});

test('two concurrent requests each get their own reply', async () => {
  let count = 0;
  const server = await fakeServer((_req, socket) => {
    count += 1;
    const id = count;
    const reply = JSON.stringify({ ok: true, data: { alive: true, paused: false, pc: '0x0', cycles: id } });
    setTimeout(() => socket.write(reply + String.fromCharCode(10)), id === 1 ? 60 : 5);
  });
  const client = new DebugServerClient('127.0.0.1', server.address().port);
  await client.connect();
  const unsettled = new Promise((_, reject) => setTimeout(() => reject(new Error('a request never settled')), 2000));
  try {
    const [first, second] = await Promise.race([Promise.all([client.getStatus(), client.getStatus()]), unsettled]);
    assert.equal(first.cycles, 1);
    assert.equal(second.cycles, 2);
  } finally {
    client.disconnect();
    server.close();
  }
});

test('probeString writes points and ranges in the wire grammar', () => {
  assert.equal(probeString([{ pc: '0x232da0', ranges: ['a0:0x160', '*a1+0x60:0x40'] }, { pc: '0x232aa4' }]),
    '0x232da0=a0:0x160,*a1+0x60:0x40;0x232aa4');
  assert.equal(probeString([]), '');
});

test('probeString refuses what would break the grammar, naming it', () => {
  assert.throws(() => probeString([{ pc: 'main' }]), /program counter "main"/);
  assert.throws(() => probeString([{ pc: '0x100', ranges: ['a0:0x10;0x200'] }]), /range "a0:0x10;0x200"/);
  assert.throws(() => probeString([{ pc: '0x100', ranges: ['a0=1:0x10'] }]), /range "a0=1:0x10"/);
});

test('gifTraceStart sends probes only when there are some', async () => {
  const seen = [];
  const server = await fakeServer((req, socket) => { seen.push(req); socket.write('{"ok":true}\n'); });
  const client = new DebugServerClient('127.0.0.1', server.address().port);
  await client.connect();
  try {
    await client.gifTraceStart('D:\\a\\t.jsonl');
    await client.gifTraceStart('D:\\a\\t.jsonl', [{ pc: '0x232da0', ranges: ['a0:0x160'] }]);
    assert.deepEqual(seen, [
      { cmd: 'gif_trace_start', path: 'D:/a/t.jsonl' },
      { cmd: 'gif_trace_start', path: 'D:/a/t.jsonl', probes: '0x232da0=a0:0x160' },
    ]);
  } finally {
    client.disconnect();
    server.close();
  }
});
