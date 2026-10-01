import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('the server exposes exactly the 28 inherited tools, named watson_*', async () => {
  const client = new Client({ name: 'watson-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  await client.close();

  assert.equal(names.length, 28);
  assert.deepEqual(names.filter((n) => !n.startsWith('watson_')), []);
  for (const n of ['watson_connect', 'watson_status', 'watson_read_registers', 'watson_get_backtrace']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});
