import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pressPad, waitForStableFile, takeSnapshot, takeGsDump } from '../dist/navigation.js';

function recorder(onQueue = () => {}) {
  const calls = [];
  let frame = 100;
  return {
    calls,
    async frameAdvance(frames) { calls.push(['frameAdvance', frames]); frame += frames; return frame; },
    async padSet(buttons, value) { calls.push(['padSet', buttons.join(','), value]); },
    async queueSnapshot(file, dumpFrames) { calls.push(['queueSnapshot', path.basename(file), dumpFrames]); onQueue(file, dumpFrames); },
  };
}

test('pressPad holds, advances, releases, then runs one more frame', async () => {
  const emulator = recorder();
  const frame = await pressPad(emulator, ['cross', 'up'], 3);
  assert.deepEqual(emulator.calls, [
    ['padSet', 'cross,up', 1],
    ['frameAdvance', 3],
    ['padSet', 'cross,up', 0],
    ['frameAdvance', 1],
  ]);
  assert.equal(frame, 104);
});

test('pressPad releases the buttons even when advancing fails', async () => {
  const emulator = recorder();
  emulator.frameAdvance = async () => { emulator.calls.push(['frameAdvance', 'boom']); throw new Error('boom'); };
  await assert.rejects(pressPad(emulator, ['start'], 2), /boom/);
  assert.deepEqual(emulator.calls.at(-1), ['padSet', 'start', 0]);
});

test('pressPad advances no frame when the buttons are refused', async () => {
  const emulator = recorder();
  emulator.padSet = async (buttons) => { throw new Error(`unknown button ${buttons[0]}`); };
  await assert.rejects(pressPad(emulator, ['turbo'], 2), /unknown button turbo/);
  assert.deepEqual(emulator.calls, []);
});

test('waitForStableFile rejects naming the path when nothing appears', async () => {
  const missing = path.join(os.tmpdir(), `watson-missing-${process.pid}.png`);
  await assert.rejects(waitForStableFile(missing, 300, Date.now()), (error) => {
    assert.match(error.message, /no file at/);
    assert.ok(error.message.includes(missing));
    assert.match(error.message, /300 ms/);
    return true;
  });
});

test('waitForStableFile ignores a stale file from an earlier capture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-'));
  const file = path.join(dir, 'old.png');
  fs.writeFileSync(file, 'old');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(file, past, past);
  await assert.rejects(waitForStableFile(file, 300, Date.now()), /no file at/);
});

test('takeSnapshot queues, runs two frames and returns the written file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-'));
  const file = path.join(dir, 'shot.png');
  const emulator = recorder((queued) => fs.writeFileSync(queued, 'png-bytes'));
  assert.equal(await takeSnapshot(emulator, file), file);
  assert.deepEqual(emulator.calls, [['queueSnapshot', 'shot.png', 0], ['frameAdvance', 2]]);
});

test('takeGsDump runs the dump frames plus two and returns both files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-'));
  const file = path.join(dir, 'clock.png');
  const emulator = recorder((queued) => {
    fs.writeFileSync(queued, 'png-bytes');
    fs.writeFileSync(queued.replace(/\.png$/, '.gs'), 'dump-bytes');
  });
  assert.deepEqual(await takeGsDump(emulator, file, 5), { png: file, dump: path.join(dir, 'clock.gs') });
  assert.deepEqual(emulator.calls, [['queueSnapshot', 'clock.png', 5], ['frameAdvance', 7]]);
});
