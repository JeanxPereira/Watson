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
    async terminate(pid) { killed.push(pid); },
  };
  await assert.rejects(kill(host, dir), /notepad\.exe/);
  assert.deepEqual(killed, []);
});

test('kill with no recorded pid says so', async () => {
  const host = { async run() { return { code: 0, output: '' }; }, async processPath() { return null; }, async terminate() {} };
  await assert.rejects(kill(host, root()), /no Watson emulator was launched/);
});
