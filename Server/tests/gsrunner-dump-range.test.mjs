import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TREE = process.env.WATSON_PCSX2_TREE ?? path.join(ROOT, 'References', 'pcsx2');
const RUNNER = process.env.WATSON_GSRUNNER ?? path.join(TREE, 'build', 'pcsx2-gsrunner', 'Release', 'pcsx2-gsrunner.exe');
const DUMP = process.env.WATSON_GSDUMP ?? path.join(ROOT, 'Runtime', 'captures', 'hddosd-110U-opening-full.gs');
const FRAME = Number(process.env.WATSON_GSDUMP_FRAME ?? 80);
const FIRST_DRAW_OF_FRAME_BEYOND_DEFAULT_CAP = 5000;
const SETTLE_POLLS = 8;
const POLL_MS = 500;
const LIMIT_MS = 180000;

function dumpFrame(args, out) {
  const frames = `${out}.frames`;
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(frames, { recursive: true });
  const env = { ...process.env, PATH: [path.join(TREE, 'deps', 'bin'), path.join(TREE, 'bin'), process.env.PATH].join(path.delimiter) };
  const child = spawn(RUNNER, ['-renderer', 'sw', '-swthreads', '0', '-surfaceless', '-noshadercache',
    '-dumpdir', frames, '-dump', 'i', ...args, '-dumpdirsw', out, '-logfile', `${out}.log`, DUMP],
  { cwd: path.dirname(RUNNER), env, stdio: 'ignore' });
  return new Promise((resolve) => {
    let last = -1, quiet = 0;
    const started = Date.now();
    const timer = setInterval(() => {
      const count = fs.readdirSync(out).length;
      quiet = count > 0 && count === last ? quiet + 1 : 0;
      last = count;
      if (quiet >= SETTLE_POLLS || Date.now() - started > LIMIT_MS) {
        clearInterval(timer);
        child.kill();
        resolve(fs.readdirSync(out));
      }
    }, POLL_MS);
  });
}

function drawNumbers(names) {
  return names.filter((name) => name.endsWith('_context.txt')).map((name) => Number(name.slice(0, 5)));
}

test('gsrunner: -dumprangef writes a frame whose draws come after the default draw cap', async (t) => {
  if (!fs.existsSync(RUNNER)) return t.skip(`no gsrunner at ${RUNNER}; run Emulator/Build.ps1`);
  if (!fs.existsSync(DUMP)) return t.skip(`no dump at ${DUMP}`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-gsrunner-'));
  try {
    const names = await dumpFrame(['-dumprangef', `${FRAME},1`], out);
    const draws = drawNumbers(names);
    assert.ok(draws.length > 0, `frame ${FRAME} wrote no draw`);
    assert.ok(Math.max(...draws) >= FIRST_DRAW_OF_FRAME_BEYOND_DEFAULT_CAP, `frame ${FRAME} should hold draws past ${FIRST_DRAW_OF_FRAME_BEYOND_DEFAULT_CAP}, saw up to ${Math.max(...draws)}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(`${out}.frames`, { recursive: true, force: true });
    fs.rmSync(`${out}.log`, { force: true });
  }
});

test('gsrunner: an explicit -dumprange still caps the draws', async (t) => {
  if (!fs.existsSync(RUNNER)) return t.skip(`no gsrunner at ${RUNNER}; run Emulator/Build.ps1`);
  if (!fs.existsSync(DUMP)) return t.skip(`no dump at ${DUMP}`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-gsrunner-'));
  try {
    const names = await dumpFrame(['-dumprange', '4309,2'], out);
    assert.deepEqual(drawNumbers(names).sort((a, b) => a - b), [4309, 4310]);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(`${out}.frames`, { recursive: true, force: true });
    fs.rmSync(`${out}.log`, { force: true });
  }
});
