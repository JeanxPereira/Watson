import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DebugServerClient } from '../dist/debug-server-client.js';

const STATUS = '{"ok":true,"data":{"alive":true,"paused":false,"pc":"00100000","cycles":5}}\n';

function fakeServer(onLine) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(JSON.parse(line), socket);
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
