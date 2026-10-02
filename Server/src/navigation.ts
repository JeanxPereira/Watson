import * as fs from 'node:fs';
import { walkGsDump } from './gsdump.js';
import type { ProbeSpec } from './debug-server-client.js';

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
  } catch (error) {
    // Still try to let go, but the reason the advance failed is the one worth reporting.
    await emulator.padSet(buttons, 0).catch(() => undefined);
    throw error;
  }
  await emulator.padSet(buttons, 0);
  return emulator.frameAdvance(1);
}

/**
 * Resolve with the size of `path` once it exists and kept the same non-zero size across two
 * checks. Callers remove the target first, so a file found here was written by this capture.
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
  fs.rmSync(path, { force: true });
  const started = Date.now();
  await emulator.queueSnapshot(path, 0);
  await emulator.frameAdvance(2);
  await waitForStableFile(path, 5000, started);
  return path;
}

// PCSX2 keeps a dump open after the last frame asked for: it closes it only on an even vsync
// once two extra frames have passed, which is frames + 4 for an odd count and frames + 5 for an
// even one. Until then the file on disk ends inside a packet.
const DUMP_CLOSE_FRAMES = 5;
const DUMP_EXTRA_TRIES = 8;

/**
 * Queue a GS dump of `frames` frames beside a PNG and return both paths, only once the dump
 * walks packet by packet to its exact end, holds the frames asked for, and has stopped growing.
 */
export async function takeGsDump(emulator: Emulator, path: string, frames: number): Promise<{ png: string; dump: string }> {
  const dump = path.replace(/\.png$/i, '.gs');
  fs.rmSync(path, { force: true });
  fs.rmSync(dump, { force: true });

  await emulator.queueSnapshot(path, frames);
  await emulator.frameAdvance(frames + DUMP_CLOSE_FRAMES);

  let ran = frames + DUMP_CLOSE_FRAMES;
  let settled = -1;
  let reason = 'never walked';
  for (let attempt = 0; attempt <= DUMP_EXTRA_TRIES; attempt++) {
    const walk = walkGsDump(dump);
    if (walk.complete && walk.vsyncs >= frames) {
      if (walk.bytes === settled) {
        if (!fs.existsSync(path)) throw new Error(`the dump at ${dump} is complete but no PNG was written at ${path}`);
        return { png: path, dump };
      }
      settled = walk.bytes;
      reason = 'complete, waiting to see that it stopped growing';
    } else {
      settled = -1;
      reason = walk.complete ? `holds ${walk.vsyncs} of ${frames} frames` : walk.reason ?? 'incomplete';
    }
    if (attempt === DUMP_EXTRA_TRIES) break;
    await emulator.frameAdvance(1);
    ran += 1;
  }
  throw new Error(`the dump at ${dump} is not complete after ${ran} frames: ${reason}`);
}

export interface Tracer extends Emulator {
  gifTraceStart(path: string, probes?: ProbeSpec[]): Promise<void>;
  gifTraceStop(): Promise<number>;
  pause(): Promise<unknown>;
}

/**
 * Trace and dump the same frames. The VM is paused and the trace armed before the dump is
 * queued, so both instruments see the same vsync first: a VM left running would run a frame
 * between the two requests and the dump would begin one vsync late. The trace is stopped only
 * after the dump is closed, so it covers every packet the dump holds.
 */
export async function takeGifTrace(emulator: Tracer, path: string, frames: number, probes: ProbeSpec[] = []): Promise<{ png: string; dump: string; trace: string }> {
  const trace = path.replace(/\.png$/i, '.trace.jsonl');
  fs.rmSync(trace, { force: true });
  await emulator.pause();
  await emulator.gifTraceStart(trace, probes);
  let files: { png: string; dump: string };
  try {
    files = await takeGsDump(emulator, path, frames);
  } catch (error) {
    // The reason the dump failed is the one worth reporting.
    await emulator.gifTraceStop().catch(() => undefined);
    throw error;
  }
  await emulator.gifTraceStop();
  return { ...files, trace };
}
