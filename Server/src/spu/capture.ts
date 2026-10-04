import * as fs from 'node:fs';
import type { PadStep, ProbeSpec, SpuTotals, SpuTraceOptions } from '../debug-server-client.js';
import type { SpuFiles } from './trace.js';

export interface SpuTracer {
  pause(): Promise<unknown>;
  frameAdvance(frames: number): Promise<number>;
  spuTraceStart(path: string, options?: SpuTraceOptions): Promise<{ iopRecompiler: boolean }>;
  spuTraceStop(): Promise<SpuTotals>;
}

export interface SpuCaptureOptions {
  probes?: ProbeSpec[];
  pad?: PadStep[];
  wav?: boolean;
  stages?: boolean;
  dmaData?: boolean;
}

/** The files a capture named `stem` writes. */
export function spuFiles(stem: string, options: SpuCaptureOptions = {}): SpuFiles {
  return {
    trace: `${stem}.spu.jsonl`,
    ...(options.wav ?? true ? { wav: `${stem}.wav` } : {}),
    ...(options.stages ?? true ? { stages: `${stem}.stages.bin` } : {}),
  };
}

/** Refuse a schedule or a probe window that would act outside the traced frames. */
function checkSchedule(frames: number, options: SpuCaptureOptions): void {
  const after = `the trace holds ${frames} frames (0 to ${frames - 1})`;
  for (const step of options.pad ?? []) {
    if (step.frame >= frames) throw new Error(`pad entry at frame ${step.frame} falls outside it: ${after}`);
  }
  for (const probe of options.probes ?? []) {
    if (probe.fromFrame !== undefined && probe.fromFrame >= frames) throw new Error(`probe ${probe.pc} opens at frame ${probe.fromFrame}, outside it: ${after}`);
  }
}

/**
 * Record `frames` frames of SPU2 activity from where the VM stands. The VM is paused first, so
 * capture frame 0 is the frame that starts at the first vsync after the trace is armed. The pad
 * schedule is applied by the emulator at each of those vsyncs, before the EE runs the frame.
 */
export async function takeSpuTrace(emulator: SpuTracer, stem: string, frames: number, options: SpuCaptureOptions = {}): Promise<SpuFiles & { totals: SpuTotals; iopRecompiler: boolean }> {
  checkSchedule(frames, options);
  const files = spuFiles(stem, options);
  for (const file of [files.trace, files.wav, files.stages]) if (file) fs.rmSync(file, { force: true });
  await emulator.pause();
  const { iopRecompiler } = await emulator.spuTraceStart(files.trace, {
    wav: files.wav, stages: files.stages, probes: options.probes, pad: options.pad, dmaData: options.dmaData,
  });
  try {
    await emulator.frameAdvance(frames);
  } catch (error) {
    await emulator.spuTraceStop().catch(() => undefined);
    throw error;
  }
  const totals = await emulator.spuTraceStop();
  return { ...files, totals, iopRecompiler };
}
