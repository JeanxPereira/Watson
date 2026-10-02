import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, kill } from '../dist/lifecycle.js';

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-root-'));
  fs.mkdirSync(path.join(dir, 'Runtime'), { recursive: true });
  return dir;
}
const exeOf = (dir) => path.join(dir, 'References', 'pcsx2', 'build', 'pcsx2-qt', 'Release', 'pcsx2-qt.exe');

test('launch passes the options to Run.ps1 and records the pid', async () => {
  const dir = root();
  const seen = [];
  const host = {
    async run(file, args) { seen.push([file, ...args]); return { code: 0, output: 'pcsx2 pid 4242\n' }; },
    async processPath() { return null; },
    async isRunning() { return true; },
    async terminate() {},
  };
  const pid = await launch(host, dir, { bios: 'D:/b/rom.bin', state: 'D:/s/clock.p2s' });
  assert.equal(pid, 4242);
  assert.equal(fs.readFileSync(path.join(dir, 'Runtime', 'watson.pid'), 'utf8').trim(), '4242');
  assert.deepEqual(seen, [['pwsh', '-NoProfile', '-File', path.join(dir, 'Emulator', 'Run.ps1'), '-Bios', 'D:/b/rom.bin', '-State', 'D:/s/clock.p2s']]);
});

test('launch surfaces the reason Run.ps1 gave', async () => {
  const host = {
    async run() { return { code: 1, output: 'Run.ps1: port 21512 is already held by X (pid 7); close it first\n' }; },
    async processPath() { return null; },
    async terminate() {},
  };
  await assert.rejects(launch(host, root(), {}), /port 21512 is already held by X/);
});

test('kill terminates the recorded pid when it is the Watson emulator', async () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, 'Runtime', 'watson.pid'), '4242');
  const killed = [];
  const host = {
    async run() { return { code: 0, output: '' }; },
    async processPath(pid) { return pid === 4242 ? exeOf(dir) : null; },
    async isRunning() { return true; },
    async terminate(pid) { killed.push(pid); },
  };
  assert.match(await kill(host, dir), /4242/);
  assert.deepEqual(killed, [4242]);
  assert.equal(fs.existsSync(path.join(dir, 'Runtime', 'watson.pid')), false);
});

test('kill refuses a pid that now belongs to another program', async () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, 'Runtime', 'watson.pid'), '4242');
  const killed = [];
  const host = {
    async run() { return { code: 0, output: '' }; },
    async processPath() { return 'C:/Windows/System32/notepad.exe'; },
    async isRunning() { return true; },
    async terminate(pid) { killed.push(pid); },
  };
  await assert.rejects(kill(host, dir), /notepad\.exe/);
  assert.deepEqual(killed, []);
});

test('kill with no recorded pid says so', async () => {
  const host = { async run() { return { code: 0, output: '' }; }, async processPath() { return null; }, async terminate() {} };
  await assert.rejects(kill(host, root()), /no Watson emulator was launched/);
});

import { launchAndWait } from '../dist/lifecycle.js';

function runningHost(dir, overrides = {}) {
  const events = [];
  return {
    events,
    async run() { return { code: 0, output: 'pcsx2 pid 4242\n' }; },
    async processPath() { return exeOf(dir); },
    async isRunning() { return true; },
    async terminate(pid) { events.push(['terminate', pid]); },
    ...overrides,
  };
}

test('launchAndWait returns once the DebugServer answers with a live VM', async () => {
  const dir = root();
  let calls = 0;
  const probe = async () => { calls += 1; if (calls < 3) throw new Error('ECONNREFUSED'); return { alive: calls >= 4, frame: 12 }; };
  const result = await launchAndWait(runningHost(dir), dir, { bios: 'D:/b.bin' }, probe, { timeoutMs: 2000, intervalMs: 5, logTail: () => '' });
  assert.deepEqual(result, { pid: 4242, alive: true, frame: 12 });
  assert.equal(calls, 4);
});

test('launchAndWait waits for a VM when only a state or an ELF was given', async () => {
  const dir = root();
  for (const options of [{ state: 'D:/s.p2s' }, { elf: 'D:/e.elf' }]) {
    let calls = 0;
    const probe = async () => { calls += 1; return { alive: calls >= 3, frame: 1 }; };
    const result = await launchAndWait(runningHost(dir), dir, options, probe, { timeoutMs: 2000, intervalMs: 5, logTail: () => '' });
    assert.equal(result.alive, true);
    assert.equal(calls, 3);
  }
});

test('launchAndWait accepts a server with no VM when nothing was asked to boot', async () => {
  const dir = root();
  const result = await launchAndWait(runningHost(dir), dir, {}, async () => ({ alive: false, frame: 0 }), { timeoutMs: 2000, intervalMs: 5, logTail: () => '' });
  assert.equal(result.alive, false);
});

test('launchAndWait kills the emulator it started when it never becomes usable, and shows the log', async () => {
  const dir = root();
  const host = runningHost(dir);
  await assert.rejects(
    launchAndWait(host, dir, { bios: 'D:/b.bin' }, async () => { throw new Error('ECONNREFUSED'); }, { timeoutMs: 60, intervalMs: 5, logTail: () => 'BIOS not found' }),
    (error) => {
      assert.match(error.message, /pid 4242 never became usable within 60 ms/);
      assert.match(error.message, /ECONNREFUSED/);
      assert.match(error.message, /BIOS not found/);
      return true;
    });
  assert.deepEqual(host.events, [['terminate', 4242]]);
  assert.equal(fs.existsSync(path.join(dir, 'Runtime', 'watson.pid')), false);
});

test('launchAndWait stops waiting as soon as the emulator process is gone', async () => {
  const dir = root();
  const host = runningHost(dir, { async isRunning() { return false; } });
  const started = Date.now();
  await assert.rejects(
    launchAndWait(host, dir, { bios: 'D:/b.bin' }, async () => { throw new Error('ECONNREFUSED'); }, { timeoutMs: 5000, intervalMs: 5, logTail: () => 'crashed early' }),
    /pid 4242 exited before the DebugServer answered.*crashed early/s);
  assert.ok(Date.now() - started < 1000);
  assert.equal(fs.existsSync(path.join(dir, 'Runtime', 'watson.pid')), false);
});

test('launchAndWait does not mistake an unreadable process path for an exit', async () => {
  const dir = root();
  const host = runningHost(dir, { async processPath() { return null; } });
  const result = await launchAndWait(host, dir, { bios: 'D:/b.bin' }, async () => ({ alive: true, frame: 3 }), { timeoutMs: 2000, intervalMs: 5, logTail: () => '' });
  assert.deepEqual(result, { pid: 4242, alive: true, frame: 3 });
  assert.deepEqual(host.events, []);
});

test('kill refuses when the process is running but its executable cannot be read', async () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, 'Runtime', 'watson.pid'), '4242');
  const host = runningHost(dir, { async processPath() { return null; } });
  await assert.rejects(kill(host, dir), /pid 4242 is running but its executable could not be read/);
  assert.deepEqual(host.events, []);
  assert.equal(fs.existsSync(path.join(dir, 'Runtime', 'watson.pid')), true);
});

import { reusingProbe } from '../dist/lifecycle.js';

test('reusingProbe keeps one connection across polls, since the server takes a single client', async () => {
  let opened = 0;
  let polls = 0;
  const { probe, current } = reusingProbe(async () => {
    opened += 1;
    return { isConnected: () => true, disconnect() {}, async getStatus() { polls += 1; return { alive: polls >= 3, frame: polls }; } };
  });
  assert.equal((await probe()).alive, false);
  assert.equal((await probe()).alive, false);
  assert.equal((await probe()).alive, true);
  assert.equal(opened, 1);
  assert.ok(current());
});

test('reusingProbe drops a connection that failed and opens a fresh one next time', async () => {
  let opened = 0;
  const closed = [];
  const { probe, current } = reusingProbe(async () => {
    opened += 1;
    const id = opened;
    return {
      isConnected: () => true,
      disconnect() { closed.push(id); },
      async getStatus() { if (id === 1) throw new Error('reset'); return { alive: true, frame: 9 }; },
    };
  });
  await assert.rejects(probe(), /reset/);
  assert.equal(current(), null);
  assert.deepEqual(await probe(), { alive: true, frame: 9 });
  assert.equal(opened, 2);
  assert.deepEqual(closed, [1]);
});
