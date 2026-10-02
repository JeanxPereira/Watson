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
