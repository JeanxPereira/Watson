import * as fs from 'node:fs';
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
}
export interface Parity { transfers: number; matched: number; vsyncs: number; mismatch?: string }

/** Spaces where an address means something, so it moves with the bytes. */
const ADDRESSED = new Set(['ee', 'scratchpad', 'vu1']);

const unknown = (size: number): Source => ({ kind: 'unknown', origin: 0, space: 'unknown', address: 0, size });

function advance(source: Source, by: number): Source {
  return { ...source, address: ADDRESSED.has(source.space) ? source.address + by : source.address, size: source.size - by };
}

export function readTrace(file: string): Trace {
  const trace: Trace = { complete: false, frame: 0, origins: new Map(), preroll: [], packets: [], vsyncAt: [], desyncs: [] };
  const stop = (reason: string): Trace => ({ ...trace, complete: false, reason });

  let data: Buffer;
  try {
    data = fs.readFileSync(file);
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
      const sources: Source[] = [];
      let left = bytes.length;
      while (left > 0 && queue.length > 0) {
        const head = queue[0];
        const take = Math.min(left, head.size);
        sources.push({ ...head, size: take });
        if (take === head.size) queue.shift(); else queue[0] = advance(head, take);
        left -= take;
      }
      const short = left > 0;
      if (short) sources.push(unknown(left));
      const held = queue.reduce((sum, source) => sum + source.size, 0);
      const target = started ? trace.packets : trace.preroll;
      if (short || held !== record.pending) {
        trace.desyncs.push(started ? target.length : -1 - target.length);
        // The emulator's count is the truth; what those bytes are is no longer known.
        queues[record.path] = record.pending > 0 ? [unknown(record.pending)] : [];
      }
      target.push({ path: record.path, bytes, sources });
      seen += 1;
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

export function formatTrace(trace: Trace, parity: Parity, files: { trace: string; dump: string; png?: string }): string {
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
  const rows = [...groups.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  const bytes = trace.packets.reduce((sum, packet) => sum + packet.bytes.length, 0);

  let verdict = `FOUND ${trace.packets.length} packets`;
  if (parity.mismatch) verdict = `PARTIAL the trace and the dump differ: ${parity.mismatch}`;
  else if (trace.desyncs.length > 0) verdict = `PARTIAL the origin of ${trace.desyncs.length} packets was lost`;
  else if (trace.packets.length === 0) verdict = 'EMPTY';

  return [
    `trace: ${files.trace}`,
    `dump: ${files.dump}`,
    ...(files.png ? [`png: ${files.png}`] : []),
    `frames: ${trace.vsyncAt.length}   packets: ${trace.packets.length}   bytes: ${bytes}   before the first vsync: ${trace.preroll.length} packets`,
    `origins recorded: ${trace.origins.size}`,
    'sources, by bytes (packets they begin, bytes, function entries of the stack):',
    ...rows.map(([key, group]) => `  ${String(group.packets).padStart(5)}  ${String(group.bytes).padStart(8)}  ${key}${group.stack ? `\n${' '.repeat(19)}stack ${group.stack}` : ''}`),
    'build: unknown',
    `verdict: ${verdict}  coverage ${parity.matched}/${parity.transfers}`,
  ].join('\n');
}
