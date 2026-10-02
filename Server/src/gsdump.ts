import * as fs from 'node:fs';

/**
 * A PCSX2 GS dump, as written by pcsx2/GS/GSDump.cpp at the pinned tag:
 *   u32 0xFFFFFFFF, u32 header_size, header (header_size bytes; state_size is its second u32),
 *   state (state_size bytes), privileged registers (8192 bytes), then packets:
 *     0 transfer  : u8 path, u32 size, data
 *     1 vsync     : u8 field
 *     2 read FIFO : u32 size
 *     3 registers : 8192 bytes
 */
export interface DumpWalk {
  complete: boolean;
  reason?: string;
  packets: number;
  transfers: number;
  vsyncs: number;
  bytes: number;
}

const REGISTERS = 8192;
const NAMES = ['transfer', 'vsync', 'read FIFO', 'registers'];

/**
 * Walk a dump packet by packet. It is complete only when the walk ends exactly at the end of
 * the file and saw at least one vsync: PCSX2 keeps a dump open for some frames after the last
 * one asked for, and a file read before it is closed ends inside a packet.
 */
export function walkGsDump(file: string): DumpWalk {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch (error: any) {
    // PCSX2 holds a dump it is still writing; on Windows that read fails with EBUSY.
    return { complete: false, packets: 0, transfers: 0, vsyncs: 0, bytes: 0, reason: `cannot read (${error.code ?? error.message})` };
  }
  const walk: DumpWalk = { complete: false, packets: 0, transfers: 0, vsyncs: 0, bytes: data.length };
  const stop = (reason: string): DumpWalk => ({ ...walk, reason });

  if (data.length < 8 || data.readUInt32LE(0) !== 0xFFFFFFFF) {
    return stop('not a GS dump with the 0xFFFFFFFF header');
  }
  const headerSize = data.readUInt32LE(4);
  if (data.length < 16) return stop('header or state is cut short');
  const stateSize = data.readUInt32LE(12);
  let offset = 8 + headerSize + stateSize + REGISTERS;
  if (offset > data.length) return stop('header or state is cut short');

  while (offset < data.length) {
    const start = offset;
    const type = data[offset];
    let end: number;
    if (type === 0) {
      if (offset + 6 > data.length) return stop(`transfer packet at offset ${start} is cut inside its header`);
      end = offset + 6 + data.readUInt32LE(offset + 2);
    } else if (type === 1) {
      end = offset + 2;
    } else if (type === 2) {
      end = offset + 5;
    } else if (type === 3) {
      end = offset + 1 + REGISTERS;
    } else {
      return stop(`unknown packet type ${type} at offset ${start}`);
    }
    if (end > data.length) {
      return stop(`${NAMES[type]} packet at offset ${start} needs ${end - data.length} more bytes`);
    }
    offset = end;
    walk.packets += 1;
    if (type === 0) walk.transfers += 1;
    if (type === 1) walk.vsyncs += 1;
  }

  if (walk.vsyncs === 0) return stop('no vsync packet: the dump holds no finished frame');
  return { complete: true, packets: walk.packets, transfers: walk.transfers, vsyncs: walk.vsyncs, bytes: walk.bytes };
}
