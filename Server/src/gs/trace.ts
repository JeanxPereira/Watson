import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { dumpPackets } from '../gsdump.js';

/**
 * A GIF trace, as written by Emulator/GifTrace.cpp: what the EE side handed to the GIF and where
 * it came from. Reading one replays each path's byte queue, so every byte of every packet is tied
 * to the data chunk that brought it.
 */
export interface StackEntry { entry: string; pc: string; sp: string }
export interface Origin {
  id: number; channel: string; frame: number;
  pc: string; ra: string; sp: string; stack: StackEntry[];
  chcr?: string; madr?: string; qwc?: number; tadr?: string;
}
export interface Source { kind: string; origin: number; space: string; address: number; size: number; vuTpc?: string }
export interface TracePacket { path: number; bytes: Buffer; sources: Source[] }
/** The EE's state when execution reached a probed program counter, before that instruction ran. */
export interface Probe {
  pc: number;
  frame: number;
  /** Low 32 bits of the 32 general registers, in register order. */
  gpr: number[];
  /** Raw bits of the 32 FPU registers. */
  fpr: number[];
  /** One entry per range asked for; `bytes` is null where the memory could not be read. */
  mem: { address: number; bytes: Buffer | null }[];
  /** Whether it came before the first vsync, and how many packets of that part came before it. */
  preroll: boolean;
  at: number;
  /** Position of the probe in the list asked for: several probes may share a program counter. */
  index?: number;
  /** Capture frame it fired in: 0 is the frame after the first vsync, -1 the part before it. */
  captureFrame?: number;
}
/** Pad buttons pressed or let go at the start of a capture frame, and the ones held after. */
export interface PadInput { type: 'pad'; captureFrame: number; frame: number; press: string[]; release: string[]; held: string[] }
/** Bytes written to EE memory at the start of a capture frame, before the EE ran it. */
export interface WriteInput { type: 'write'; captureFrame: number; frame: number; address: number; bytes: Buffer }
export type Input = PadInput | WriteInput;
export interface Trace {
  complete: boolean;
  reason?: string;
  frame: number;
  origins: Map<number, Origin>;
  /** Packets sent before the first vsync: a dump of the same capture does not hold them. */
  preroll: TracePacket[];
  packets: TracePacket[];
  /** For each vsync after the first, how many of `packets` came before it. */
  vsyncAt: number[];
  /** Packets where the byte queue disagreed with the emulator: index into `packets`, or -1 - index into `preroll`. */
  desyncs: number[];
  probes: Probe[];
  /** True for a state capture under the recompilers: packets and probes, origins without context. */
  recompiler: boolean;
  /** The probes as asked for, in the wire grammar; index i is the probe whose records carry index i. */
  probeSpec: string;
  /** The pad schedule and the memory writes as asked for, in the wire grammar. */
  padSpec: string;
  writeSpec: string;
  /** What the capture applied, in the order it applied it. */
  inputs: Input[];
}
export interface Parity { transfers: number; matched: number; vsyncs: number; mismatch?: string }

/** Spaces where an address means something, so it moves with the bytes. */
const ADDRESSED = new Set(['ee', 'scratchpad', 'vu1']);

const unknown = (size: number): Source => ({ kind: 'unknown', origin: 0, space: 'unknown', address: 0, size });

function advance(source: Source, by: number): Source {
  return { ...source, address: ADDRESSED.has(source.space) ? source.address + by : source.address, size: source.size - by };
}

/** The bytes of a trace: `<name>.trace.jsonl`, or its `.gz` when only the compressed file is kept. */
export function readTraceBytes(file: string): Buffer {
  if (!fs.existsSync(file) && fs.existsSync(`${file}.gz`)) return zlib.gunzipSync(fs.readFileSync(`${file}.gz`));
  return fs.readFileSync(file);
}

export function readTrace(file: string): Trace {
  const trace: Trace = { complete: false, frame: 0, origins: new Map(), preroll: [], packets: [], vsyncAt: [], desyncs: [], probes: [], recompiler: false, probeSpec: '', padSpec: '', writeSpec: '', inputs: [] };
  const stop = (reason: string): Trace => ({ ...trace, complete: false, reason });

  let data: Buffer;
  try {
    data = readTraceBytes(file);
  } catch (error: any) {
    return stop(`cannot read (${error.code ?? error.message})`);
  }

  const queues: Source[][] = [[], [], [], []];
  let started = false;
  let ended: number | null = null;
  let seen = 0;
  let line = 0;
  let offset = 0;

  while (offset < data.length) {
    const newline = data.indexOf(0x0a, offset);
    if (newline < 0) return stop(`line ${line + 1} is cut: the file ends inside a record`);
    line += 1;
    // Lines are read one at a time: a long trace does not fit in one string.
    let record: any;
    try {
      record = JSON.parse(data.toString('latin1', offset, newline));
    } catch {
      return stop(`line ${line} is not JSON`);
    }
    offset = newline + 1;
    if (ended !== null) return stop(`line ${line} follows the end record`);

    if (record.type === 'header') {
      if (record.version !== 1) return stop(`trace version ${record.version} is not supported`);
      trace.frame = record.frame;
      trace.recompiler = record.recompiler === true;
      trace.probeSpec = typeof record.probes === 'string' ? record.probes : '';
      trace.padSpec = typeof record.pad === 'string' ? record.pad : '';
      trace.writeSpec = typeof record.writes === 'string' ? record.writes : '';
    } else if (record.type === 'origin') {
      const { type, ...origin } = record;
      trace.origins.set(origin.id, origin as Origin);
    } else if (record.type === 'data') {
      const { type, path, ...source } = record;
      if (!(path >= 1 && path <= 3)) return stop(`line ${line} names path ${path}`);
      queues[path].push(source as Source);
    } else if (record.type === 'rewind') {
      const queue = queues[record.path];
      let left: number = record.size;
      while (left > 0 && queue.length > 0) {
        const last = queue[queue.length - 1];
        if (last.size <= left) { left -= last.size; queue.pop(); }
        else { last.size -= left; left = 0; }
      }
    } else if (record.type === 'packet') {
      const bytes = Buffer.from(record.hex, 'hex');
      if (bytes.length !== record.size) return stop(`line ${line}: a packet of ${record.size} bytes carries ${bytes.length}`);
      const queue = queues[record.path];
      let sources: Source[] = [];
      let left = bytes.length;
      while (left > 0 && queue.length > 0) {
        const head = queue[0];
        const take = Math.min(left, head.size);
        sources.push({ ...head, size: take });
        if (take === head.size) queue.shift(); else queue[0] = advance(head, take);
        left -= take;
      }
      const held = queue.reduce((sum, source) => sum + source.size, 0);
      const target = started ? trace.packets : trace.preroll;
      if (left > 0 || held !== record.pending) {
        trace.desyncs.push(started ? target.length : -1 - target.length);
        // The emulator's count is the truth. The queue was wrong before this packet took its
        // bytes from it, so neither those bytes nor the ones left have a known source.
        sources = [unknown(bytes.length)];
        queues[record.path] = record.pending > 0 ? [unknown(record.pending)] : [];
      }
      target.push({ path: record.path, bytes, sources });
      seen += 1;
    } else if (record.type === 'probe') {
      const words = (text: unknown): number[] | null => {
        if (typeof text !== 'string' || text.length !== 256) return null;
        const out: number[] = [];
        for (let i = 0; i < 32; i++) out.push(parseInt(text.slice(8 * i, 8 * i + 8), 16));
        return out.some(Number.isNaN) ? null : out;
      };
      const gpr = words(record.gpr);
      const fpr = words(record.fpr);
      if (!gpr) return stop(`line ${line}: a probe's gpr is not 32 registers of 8 hex digits`);
      if (!fpr) return stop(`line ${line}: a probe's fpr is not 32 registers of 8 hex digits`);
      trace.probes.push({
        pc: parseInt(record.pc, 16), frame: record.frame, gpr, fpr,
        mem: (record.mem ?? []).map((range: any) => ({ address: range.address, bytes: typeof range.hex === 'string' ? Buffer.from(range.hex, 'hex') : null })),
        preroll: !started, at: (started ? trace.packets : trace.preroll).length,
        ...(typeof record.probe === 'number' ? { index: record.probe } : {}),
        ...(typeof record.captureFrame === 'number' ? { captureFrame: record.captureFrame } : {}),
      });
    } else if (record.type === 'pad') {
      const names = (list: unknown): string[] | null => (Array.isArray(list) && list.every((name) => typeof name === 'string') ? list : null);
      const press = names(record.press), release = names(record.release), held = names(record.held);
      if (!press || !release || !held || typeof record.captureFrame !== 'number') return stop(`line ${line}: a pad record needs captureFrame, press, release and held`);
      trace.inputs.push({ type: 'pad', captureFrame: record.captureFrame, frame: record.frame, press, release, held });
    } else if (record.type === 'write') {
      if (typeof record.hex !== 'string' || typeof record.captureFrame !== 'number') return stop(`line ${line}: a write record needs captureFrame and hex`);
      trace.inputs.push({ type: 'write', captureFrame: record.captureFrame, frame: record.frame, address: parseInt(record.address, 16), bytes: Buffer.from(record.hex, 'hex') });
    } else if (record.type === 'vsync') {
      if (started) trace.vsyncAt.push(trace.packets.length);
      started = true;
    } else if (record.type === 'end') {
      ended = record.packets;
    } else {
      return stop(`line ${line} has unknown type ${record.type}`);
    }
  }

  if (ended === null) return stop('no end record: the trace was not stopped');
  if (ended !== seen) return stop(`the end record counts ${ended} packets, the file holds ${seen}`);
  return { ...trace, complete: true };
}

/**
 * Compare the packets after the trace's first vsync with the dump's transfer packets: same order,
 * same bytes, vsyncs in the same places. The dump's path id is not compared: PCSX2 sends every
 * path to the GS through one function and the dump records 3 for all of them.
 */
export function compareTraceToDump(trace: Trace, dump: Buffer): Parity {
  const parity: Parity = { transfers: 0, matched: 0, vsyncs: 0 };
  for (const packet of dumpPackets(dump)) {
    if (packet.type === 'transfer') parity.transfers += 1;
    if (packet.type === 'vsync') parity.vsyncs += 1;
  }

  let index = 0;
  let vsync = 0;
  for (const packet of dumpPackets(dump)) {
    if (packet.type === 'transfer') {
      const mine = trace.packets[index];
      if (!mine) return { ...parity, mismatch: `the dump has packet ${index}, the trace holds ${trace.packets.length}` };
      if (mine.bytes.length !== packet.data.length) {
        return { ...parity, mismatch: `packet ${index} is ${packet.data.length} bytes in the dump and ${mine.bytes.length} in the trace` };
      }
      if (!mine.bytes.equals(packet.data)) {
        let at = 0;
        while (mine.bytes[at] === packet.data[at]) at += 1;
        return { ...parity, mismatch: `packet ${index} differs at byte ${at}` };
      }
      index += 1;
      parity.matched = index;
    } else if (packet.type === 'vsync') {
      if (trace.vsyncAt[vsync] !== index) {
        return { ...parity, mismatch: `vsync ${vsync} follows packet ${index} in the dump and packet ${trace.vsyncAt[vsync] ?? 'none'} in the trace` };
      }
      vsync += 1;
    }
  }
  return parity;
}

/** The chunk that brought the byte at `at` of a packet, with its address moved to that byte. */
export function sourceAt(packet: TracePacket, at: number): Source {
  let start = 0;
  for (const source of packet.sources) {
    if (at < start + source.size) return { ...advance(source, at - start), size: source.size - (at - start) };
    start += source.size;
  }
  return unknown(0);
}

export function describeSource(trace: Trace, path: number, source: Source): string {
  const what = `PATH${path} ${source.kind}${source.vuTpc ? ` vuTpc ${source.vuTpc}` : ''}`;
  const origin = trace.origins.get(source.origin);
  if (!origin) return `${what}, origin unknown`;
  const verb = origin.channel === 'fifo' ? 'FIFO written' : 'DMA started';
  return `${what}, ${verb} at pc ${origin.pc} ra ${origin.ra}`;
}

/** Sources listed in a summary; a busy screen has a hundred. */
const SHOWN = 12;

export function formatTrace(trace: Trace, parity: Parity, files: { trace: string; dump: string; png?: string }, probed: { pc: string }[] = []): string {
  const groups = new Map<string, { packets: number; bytes: number; stack: string }>();
  for (const packet of trace.packets) {
    for (const [index, source] of packet.sources.entries()) {
      const key = describeSource(trace, packet.path, source);
      const group = groups.get(key) ?? { packets: 0, bytes: 0, stack: (trace.origins.get(source.origin)?.stack ?? []).map((f) => f.entry).join(' < ') };
      if (index === 0) group.packets += 1;
      group.bytes += source.size;
      groups.set(key, group);
    }
  }
  const hits = new Map<number, number>();
  for (const asked of probed) hits.set(parseInt(asked.pc, 16), 0);
  for (const probe of trace.probes) hits.set(probe.pc, (hits.get(probe.pc) ?? 0) + 1);
  const probeLines = hits.size === 0 ? [] : [
    `probes: ${trace.probes.length} records`,
    ...[...hits.entries()].sort((a, b) => b[1] - a[1]).map(([pc, count]) => `  ${String(count).padStart(5)}  0x${pc.toString(16).padStart(8, '0')}`),
  ];
  const inputLines = trace.inputs.length === 0 ? [] : [
    `inputs: ${trace.inputs.length}`,
    ...trace.inputs.slice(0, SHOWN).map((input) => `  frame ${input.captureFrame}: ${input.type === 'write'
      ? `write ${input.bytes.length} bytes at 0x${input.address.toString(16).padStart(8, '0')}`
      : [input.press.length ? `press ${input.press.join('+')}` : '', input.release.length ? `release ${input.release.join('+')}` : ''].filter(Boolean).join(', ')}`),
    ...(trace.inputs.length > SHOWN ? [`  and ${trace.inputs.length - SHOWN} more; every one is in the trace file`] : []),
  ];
  const rows = [...groups.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  const shown = rows.slice(0, SHOWN);
  const hidden = rows.slice(SHOWN);
  const bytes = trace.packets.reduce((sum, packet) => sum + packet.bytes.length, 0);

  // Only packets the dump also holds were checked; the trace runs on until the dump is closed.
  const unchecked = trace.packets.length - parity.matched;
  let verdict = `FOUND ${parity.matched} packets`;
  if (parity.mismatch) verdict = `PARTIAL the trace and the dump differ: ${parity.mismatch}`;
  else if (trace.desyncs.length > 0) verdict = `PARTIAL the origin of ${trace.desyncs.length} packets was lost`;
  else if (parity.matched === 0) verdict = 'EMPTY';

  return [
    `trace: ${files.trace}`,
    `dump: ${files.dump}`,
    ...(files.png ? [`png: ${files.png}`] : []),
    `frames: ${trace.vsyncAt.length}   packets: ${trace.packets.length}${!parity.mismatch && unchecked > 0 ? ` (${unchecked} after the dump's last, not checked)` : ''}   bytes: ${bytes}   before the first vsync: ${trace.preroll.length} packets`,
    `origins recorded: ${trace.origins.size}`,
    ...probeLines,
    ...inputLines,
    'sources, by bytes (packets they begin, bytes, function entries of the stack):',
    ...shown.map(([key, group]) => `  ${String(group.packets).padStart(5)}  ${String(group.bytes).padStart(8)}  ${key}${group.stack ? `\n${' '.repeat(19)}stack ${group.stack}` : ''}`),
    ...(hidden.length > 0 ? [`  and ${hidden.length} more sources, ${hidden.reduce((sum, [, group]) => sum + group.bytes, 0)} bytes; every one is in the trace file`] : []),
    'build: unknown',
    `verdict: ${verdict}  coverage ${parity.matched}/${parity.transfers}`,
  ].join('\n');
}
