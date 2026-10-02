import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PORT = 21512;
const EXPECT_VM = process.env.WATSON_EXPECT_VM === '1';

function listening() {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

test('live: the DebugServer answers status', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  const st = await client.getStatus();
  client.disconnect();
  assert.equal(typeof st.alive, 'boolean');
  assert.equal(st.alive, EXPECT_VM, EXPECT_VM ? 'a VM should be running' : 'no VM should be running');
});

test('live: EE registers are readable through MCP', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('set WATSON_EXPECT_VM=1 and launch with -Bios to read registers of a running VM');
  const client = new Client({ name: 'watson-live', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
  const connect = await client.callTool({ name: 'watson_connect', arguments: { mode: 'debug' } });
  assert.match(connect.content[0].text, /DebugServer: connected/);
  const regs = await client.callTool({ name: 'watson_read_registers', arguments: {} });
  await client.close();
  assert.ok(!regs.isError, regs.content[0].text);
  assert.match(regs.content[0].text, /\bgp\b/i);
  assert.match(regs.content[0].text, /\bsp\b/i);
});

test('live: a memory read with no VM is refused, and PCSX2 survives it', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (EXPECT_VM) return t.skip('a VM is running; this checks the no-VM state');
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  try {
    await assert.rejects(client.readMemory('0x00100004', 16), /no VM/i);
    const st = await client.getStatus();
    assert.equal(st.alive, false);
  } finally {
    client.disconnect();
  }
});

test('live: a log watchpoint is refused instead of silently never counting', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('needs a running VM');
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  try {
    await assert.rejects(client.setMemcheck('0x00100000', '0x00100004', { action: 'log' }), /log/i);
    assert.deepEqual(await client.listMemchecks(), []);
  } finally {
    client.disconnect();
  }
});

test('live: the DebugServer port cannot be shared by a second listener', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  const script = [
    'import socket, sys',
    's = socket.socket()',
    's.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
    'try:',
    `    s.bind(("127.0.0.1", ${PORT})); s.listen(1); print("BOUND")`,
    'except OSError as error:',
    '    print("REFUSED", error.winerror)',
  ].join(String.fromCharCode(10));
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('python', ['-c', script], { encoding: 'utf8' });
  assert.match(out, /^REFUSED/, `a second listener bound the port: ${out}`);
});

test('live: Pine IPC is enabled in the Watson runtime', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('needs a running VM');
  const client = new Client({ name: 'watson-live', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
  try {
    const connect = await client.callTool({ name: 'watson_connect', arguments: { mode: 'auto' } });
    assert.match(connect.content[0].text, /Pine IPC: connected/);
  } finally {
    await client.close();
  }
});

test('live: a second client is refused while the first keeps working', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  const first = new DebugServerClient('127.0.0.1', PORT);
  await first.connect();
  const second = new DebugServerClient('127.0.0.1', PORT);
  try {
    await first.getStatus();
    await second.connect();
    await assert.rejects(second.getStatus(), /another client|closed|ECONNRESET/i);
    const st = await first.getStatus();
    assert.equal(typeof st.alive, 'boolean');
  } finally {
    first.disconnect();
    second.disconnect();
  }
});

test('live: frame_advance runs exactly N frames and leaves the VM paused', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('needs a running VM');
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  try {
    await client.pause();
    const before = (await client.getStatus()).frame;
    const after = await client.frameAdvance(5);
    const st = await client.getStatus();
    assert.equal(after - before, 5);
    assert.equal(st.frame, after);
    assert.equal(st.paused, true);
  } finally {
    await client.resume();
    client.disconnect();
  }
});

test('live: an unknown pad button is refused and names the valid ones', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('needs a running VM');
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  try {
    await assert.rejects(client.padSet(['cross', 'turbo'], 1), /turbo.*triangle.*cross/is);
    await client.padSet(['cross'], 1);
    await client.padSet(['cross'], 0);
  } finally {
    client.disconnect();
  }
});

test('live: a state saved to a file loads back to the same frame', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('needs a running VM');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watson-')), 'probe.p2s');
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  try {
    await client.pause();
    const saved = (await client.getStatus()).frame;
    await client.saveStateFile(file);
    assert.ok(fs.statSync(file).size > 0);
    await client.frameAdvance(10);
    await client.loadStateFile(file);
    assert.equal((await client.getStatus()).frame, saved);
  } finally {
    await client.resume();
    client.disconnect();
  }
});

test('live: from one saved state, the same frames give the same snapshot bytes', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('needs a running VM');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { takeSnapshot } = await import('../dist/navigation.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-'));
  const state = path.join(dir, 'origin.p2s');
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  try {
    await client.pause();
    await client.saveStateFile(state);
    const shots = [];
    for (const name of ['a.png', 'b.png']) {
      await client.loadStateFile(state);
      await client.frameAdvance(30);
      shots.push(hash(await takeSnapshot(client, path.join(dir, name))));
    }
    assert.equal(shots[0], shots[1]);
  } finally {
    await client.resume();
    client.disconnect();
  }
});

test('live: a GS dump is complete on disk when returned and does not grow afterwards', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('needs a running VM');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { takeGsDump } = await import('../dist/navigation.js');
  const { walkGsDump } = await import('../dist/gsdump.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-'));
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  try {
    await client.pause();
    for (const frames of [1, 2]) {
      const { dump } = await takeGsDump(client, path.join(dir, `d${frames}.png`), frames);
      const walk = walkGsDump(dump);
      assert.equal(walk.complete, true, `${frames}-frame dump: ${walk.reason}`);
      assert.ok(walk.vsyncs >= frames, `${frames}-frame dump holds ${walk.vsyncs} vsyncs`);
      await client.frameAdvance(10);
      assert.equal(fs.statSync(dump).size, walk.bytes, 'the dump grew after it was returned');
    }
  } finally {
    await client.resume();
    client.disconnect();
  }
});

test('live: frame_advance stopped by a breakpoint reports how far it got', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('needs a running VM');
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  try {
    await client.pause();
    // The EE kernel idle loop on ROM 2.30: reached within the first frame of any advance.
    await client.setBreakpoint('0x00081fc0');
    await assert.rejects(client.frameAdvance(30), /stopped after \d+ of 30 frames/);
  } finally {
    await client.clearAllBreakpoints();
    await client.resume();
    client.disconnect();
  }
});

test('live: loading a state file that does not exist is refused without resetting the VM', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('needs a running VM');
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  try {
    await client.pause();
    const before = (await client.getStatus()).frame;
    await assert.rejects(client.loadStateFile('D:/does/not/exist.p2s'), /no state file at/);
    const after = await client.getStatus();
    assert.equal(after.alive, true);
    assert.ok(after.frame >= before, `frame went from ${before} to ${after.frame}: the VM was reset`);
  } finally {
    await client.resume();
    client.disconnect();
  }
});

test('live: a client that disconnects can reconnect at once, many times', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  for (let i = 0; i < 40; i++) {
    const client = new DebugServerClient('127.0.0.1', PORT);
    await client.connect();
    const st = await client.getStatus();
    assert.equal(typeof st.alive, 'boolean', `attempt ${i}`);
    client.disconnect();
  }
});
