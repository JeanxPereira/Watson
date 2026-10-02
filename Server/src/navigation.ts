import * as fs from 'node:fs';

export interface Emulator {
  frameAdvance(frames: number): Promise<number>;
  padSet(buttons: string[], value: 0 | 1): Promise<void>;
  queueSnapshot(path: string, dumpFrames: number): Promise<void>;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Hold buttons for `frames` frames, release, run one more frame. Leaves the VM paused. */
export async function pressPad(emulator: Emulator, buttons: string[], frames: number): Promise<number> {
  await emulator.padSet(buttons, 1);
  try {
    await emulator.frameAdvance(frames);
  } finally {
    await emulator.padSet(buttons, 0);
  }
  return emulator.frameAdvance(1);
}

/**
 * Resolve with the size of `path` once it exists, was modified at or after `notBefore`, and
 * kept the same non-zero size across two checks. A file left by an earlier capture is not
 * evidence that this one worked.
 */
export async function waitForStableFile(path: string, timeoutMs: number, notBefore: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const stat = fs.statSync(path, { throwIfNoEntry: false });
    if (stat && stat.size > 0 && stat.mtimeMs >= notBefore - 1000) {
      if (stat.size === last) return stat.size;
      last = stat.size;
    } else {
      last = -1;
    }
    await delay(100);
  }
  throw new Error(`no file at ${path} after ${timeoutMs} ms`);
}

/** Queue a PNG, run the two frames the GS needs to present and write it, return its path. */
export async function takeSnapshot(emulator: Emulator, path: string): Promise<string> {
  const started = Date.now();
  await emulator.queueSnapshot(path, 0);
  await emulator.frameAdvance(2);
  await waitForStableFile(path, 5000, started);
  return path;
}

/** Queue a GS dump of `frames` frames beside a PNG and return both paths. */
export async function takeGsDump(emulator: Emulator, path: string, frames: number): Promise<{ png: string; dump: string }> {
  const dump = path.replace(/\.png$/i, '.gs');
  const started = Date.now();
  await emulator.queueSnapshot(path, frames);
  await emulator.frameAdvance(frames + 2);
  await waitForStableFile(dump, 10000, started);
  await waitForStableFile(path, 5000, started);
  return { png: path, dump };
}
