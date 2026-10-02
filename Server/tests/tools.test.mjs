import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('the server exposes the inherited, lifecycle and navigation tools, all named watson_*', async () => {
  const client = new Client({ name: 'watson-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  await client.close();

  assert.equal(names.length, 38);
  assert.deepEqual(names.filter((n) => !n.startsWith('watson_')), []);
  for (const n of ['watson_connect', 'watson_status', 'watson_read_registers', 'watson_get_backtrace',
    'watson_launch', 'watson_kill', 'watson_frame_advance', 'watson_pad', 'watson_snapshot', 'watson_gs_dump',
    'watson_save_state_file', 'watson_load_state_file', 'watson_states', 'watson_state_save']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});
