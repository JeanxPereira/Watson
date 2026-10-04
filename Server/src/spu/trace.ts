import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

/** One SPU2 register, as the address of a write names it. */
export interface SpuRegister { core: number | null; name: string; voice?: number }

const VOICE_PARAMS = ['VOLL', 'VOLR', 'PITCH', 'ADSR1', 'ADSR2', 'ENVX', 'VOLXL', 'VOLXR'];
const VOICE_ADDRS = ['SSAH', 'SSAL', 'LSAXH', 'LSAXL', 'NAXH', 'NAXL'];
const CORE_REGS: Record<number, string> = {
  0x180: 'PMON0', 0x182: 'PMON1', 0x184: 'NON0', 0x186: 'NON1', 0x188: 'VMIXL0', 0x18a: 'VMIXL1', 0x18c: 'VMIXEL0',
  0x18e: 'VMIXEL1', 0x190: 'VMIXR0', 0x192: 'VMIXR1', 0x194: 'VMIXER0', 0x196: 'VMIXER1', 0x198: 'MMIX', 0x19a: 'ATTR',
  0x19c: 'IRQAH', 0x19e: 'IRQAL', 0x1a0: 'KON0', 0x1a2: 'KON1', 0x1a4: 'KOFF0', 0x1a6: 'KOFF1', 0x1a8: 'TSAH', 0x1aa: 'TSAL',
  0x1ac: 'DATA', 0x1ae: 'REG_1AE', 0x1b0: 'ADMAS',
  0x2e0: 'ESAH', 0x2e2: 'ESAL', 0x33c: 'EEA', 0x33e: 'REG_33E', 0x340: 'ENDX0', 0x342: 'ENDX1', 0x344: 'STATX',
};
const REVERB_ADDRS = ['APF1_SIZE', 'APF2_SIZE', 'SAME_L_DST', 'SAME_R_DST', 'COMB1_L_SRC', 'COMB1_R_SRC', 'COMB2_L_SRC',
  'COMB2_R_SRC', 'SAME_L_SRC', 'SAME_R_SRC', 'DIFF_L_DST', 'DIFF_R_DST', 'COMB3_L_SRC', 'COMB3_R_SRC', 'COMB4_L_SRC',
  'COMB4_R_SRC', 'DIFF_L_SRC', 'DIFF_R_SRC', 'APF1_L_DST', 'APF1_R_DST', 'APF2_L_DST', 'APF2_R_DST'];
const CORE_VOLUMES = ['MVOLL', 'MVOLR', 'EVOLL', 'EVOLR', 'AVOLL', 'AVOLR', 'BVOLL', 'BVOLR', 'MVOLXL', 'MVOLXR',
  'IIR_VOL', 'COMB1_VOL', 'COMB2_VOL', 'COMB3_VOL', 'COMB4_VOL', 'WALL_VOL', 'APF1_VOL', 'APF2_VOL', 'IN_COEF_L', 'IN_COEF_R'];
const SPDIF: Record<number, string> = { 0x7c0: 'SPDIF_OUT', 0x7c2: 'SPDIF_IRQINFO', 0x7c6: 'SPDIF_MODE', 0x7c8: 'SPDIF_MEDIA', 0x7cc: 'SPDIF_PROTECT' };

/** Names an SPU2 register from the IOP address written (0x1F900000 + offset), as PCSX2's register table lays them out. */
export function spuRegister(address: number): SpuRegister {
  if (address >>> 16 === 0x1f80) return { core: 0, name: `PS1_${(address & 0xffff).toString(16)}` };
  const mem = address & 0x7ff;
  if (mem >= 0x7c0) return { core: null, name: SPDIF[mem] ?? `SPDIF_${mem.toString(16)}` };
  if (mem >= 0x760) {
    const core = mem >= 0x788 ? 1 : 0;
    const index = (mem - 0x760 - core * 0x28) >> 1;
    return { core, name: CORE_VOLUMES[index] ?? `REG_${mem.toString(16)}` };
  }
  const core = (mem >> 10) & 1;
  const off = mem & 0x3ff;
  if (off < 0x180) return { core, voice: off >> 4, name: VOICE_PARAMS[(off & 0xf) >> 1] };
  if (off >= 0x1c0 && off < 0x2e0) {
    const at = off - 0x1c0;
    return { core, voice: Math.floor(at / 12), name: VOICE_ADDRS[(at % 12) >> 1] };
  }
  if (off >= 0x2e4 && off < 0x33c) {
    const at = off - 0x2e4;
    return { core, name: `${REVERB_ADDRS[at >> 2]}${at & 2 ? 'L' : 'H'}` };
  }
  return { core, name: CORE_REGS[off] ?? `REG_${off.toString(16)}` };
}

/** The full name of a register, e.g. `c0.v5.PITCH` or `c1.KON0`. */
export function registerLabel(register: SpuRegister): string {
  const core = register.core === null ? '' : `c${register.core}.`;
  return `${core}${register.voice !== undefined ? `v${register.voice}.` : ''}${register.name}`;
}

interface When { captureFrame: number; frame: number; cycle: number; sample: number }
export interface SpuWrite extends When { pc: string; address: string; value: string; tsa?: string }
export interface SpuDma extends When { core: number; tsa: string; words: number; adma: boolean; iopAddress?: string; fnv1a64?: string }
export interface SpuRam extends When { core: number; kind: string; address: string; words: number; fnv1a64: string; hex?: string }
export interface IopProbe extends When { pc: string; probe: number; gpr: string; hi: string; lo: string; mem: Array<{ address: number; hex?: string; error?: string }> }
export interface SpuFrame extends When { lClocks: number; pending: number }
export interface SpuPad extends When { press: string[]; release: string[]; held: string[] }

export interface SpuTrace {
  complete: boolean;
  reason?: string;
  header: any;
  writes: SpuWrite[];
  dmas: SpuDma[];
  rams: SpuRam[];
  probes: IopProbe[];
  frames: SpuFrame[];
  pads: SpuPad[];
  end?: any;
}

/** Read a trace written by spu_trace_start/stop. A trace without its end record is incomplete. */
export function readSpuTrace(file: string): SpuTrace {
  const trace: SpuTrace = { complete: false, header: null, writes: [], dmas: [], rams: [], probes: [], frames: [], pads: [] };
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.length === 0) continue;
    let record: any;
    try { record = JSON.parse(line); } catch {
      trace.reason = `line ${index + 1} is not JSON`;
      return trace;
    }
    switch (record.type) {
      case 'header': trace.header = record; break;
      case 'write': trace.writes.push(record); break;
      case 'dma': trace.dmas.push(record); break;
      case 'ram': trace.rams.push(record); break;
      case 'probe': trace.probes.push(record); break;
      case 'frame': trace.frames.push(record); break;
      case 'pad': trace.pads.push(record); break;
      case 'end': trace.end = record; break;
      default:
        trace.reason = `line ${index + 1} has an unknown type ${record.type}`;
        return trace;
    }
  }
  if (!trace.header) { trace.reason = 'no header record'; return trace; }
  if (!trace.end) { trace.reason = 'no end record: the trace was not stopped, or failed'; return trace; }
  if (trace.end.writes !== trace.writes.length || trace.end.dmas !== trace.dmas.length || trace.end.probes !== trace.probes.length) {
    trace.reason = `the end record counts ${trace.end.writes} writes, ${trace.end.dmas} DMAs, ${trace.end.probes} probes; the file holds ${trace.writes.length}, ${trace.dmas.length}, ${trace.probes.length}`;
    return trace;
  }
  trace.complete = true;
  return trace;
}

export interface KeyEvent { captureFrame: number; sample: number; core: number; on: boolean; voices: number[] }

/** Key-on and key-off writes, with the voices each one names. */
export function keyEvents(trace: SpuTrace): KeyEvent[] {
  const events: KeyEvent[] = [];
  for (const write of trace.writes) {
    const register = spuRegister(parseInt(write.address, 16));
    const match = /^K(ON|OFF)([01])$/.exec(register.name);
    if (!match || register.core === null) continue;
    const value = parseInt(write.value, 16);
    const base = match[2] === '1' ? 16 : 0;
    const voices: number[] = [];
    for (let bit = 0; bit < 16; bit++) if (value & (1 << bit)) voices.push(base + bit);
    events.push({ captureFrame: write.captureFrame, sample: write.sample, core: register.core, on: match[1] === 'ON', voices });
  }
  return events;
}

export const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/** The PCM bytes of a WAV written by the trace (after its 44-byte header). */
export function wavSamples(file: string): Buffer {
  const data = fs.readFileSync(file);
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 36, 40) !== 'data') throw new Error(`${file} is not a trace WAV`);
  const size = data.readUInt32LE(40);
  if (size !== data.length - 44) throw new Error(`${file}: the header holds ${size} bytes of samples, the file ${data.length - 44}`);
  return data.subarray(44);
}

export interface SpuFiles { trace: string; wav?: string; stages?: string }

/** A digest of what a trace holds, for the tool's answer and for comparisons between runs. */
export function summarizeSpuTrace(trace: SpuTrace, files: SpuFiles): string {
  const lines: string[] = [];
  lines.push(`trace: ${files.trace}`);
  if (!trace.complete) {
    lines.push(`verdict: NOT VERIFIED ${trace.reason}`);
    return lines.join('\n');
  }
  const header = trace.header;
  lines.push(`frames: ${trace.frames.length} (frame counter ${trace.frames[0]?.frame ?? '?'}..${trace.frames.at(-1)?.frame ?? '?'}); samples: ${trace.end.samples}; IOP ${header.iopRecompiler ? 'recompiler' : 'interpreter'}, EE ${header.eeRecompiler ? 'recompiler' : 'interpreter'}`);
  lines.push(`SPU2 writes: ${trace.writes.length}; DMA starts: ${trace.dmas.length}; RAM copies: ${trace.rams.length}; IOP probe records: ${trace.probes.length}; pad changes: ${trace.pads.length}`);
  const counts = new Map<string, number>();
  for (const write of trace.writes) {
    const label = registerLabel(spuRegister(parseInt(write.address, 16))).replace(/\.v\d+\./, '.v*.');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([name, count]) => `${name} ${count}`);
  if (top.length) lines.push(`writes by register: ${top.join(', ')}`);
  const keys = keyEvents(trace).filter((event) => event.voices.length > 0);
  const ons = keys.filter((event) => event.on);
  lines.push(`key-ons: ${ons.length}${ons.length ? ` — ${ons.slice(0, 12).map((e) => `f${e.captureFrame} c${e.core} [${e.voices.join(',')}]`).join('; ')}${ons.length > 12 ? '; ...' : ''}` : ''}`);
  const offs = keys.filter((event) => !event.on);
  lines.push(`key-offs: ${offs.length}${offs.length ? ` — ${offs.slice(0, 12).map((e) => `f${e.captureFrame} c${e.core} [${e.voices.join(',')}]`).join('; ')}${offs.length > 12 ? '; ...' : ''}` : ''}`);
  const byPc = new Map<string, number>();
  for (const probe of trace.probes) byPc.set(probe.pc, (byPc.get(probe.pc) ?? 0) + 1);
  if (byPc.size) lines.push(`probes by pc: ${[...byPc.entries()].map(([pc, count]) => `${pc} ${count}`).join(', ')}`);
  if (files.wav) {
    const pcm = wavSamples(files.wav);
    let peak = 0;
    for (let at = 0; at < pcm.length; at += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(at)));
    lines.push(`output: ${files.wav} (${pcm.length / 4} samples, peak ${peak}, sha256 ${sha256(pcm)})`);
  }
  if (files.stages) lines.push(`stages: ${files.stages} (${fs.statSync(files.stages).size} bytes, sha256 ${sha256(fs.readFileSync(files.stages))})`);
  lines.push(`events sha256: ${eventDigest(trace)}`);
  return lines.join('\n');
}

/** A digest of the records that do not depend on when the trace was started: writes, DMA, RAM, probes. */
export function eventDigest(trace: SpuTrace): string {
  const hash = crypto.createHash('sha256');
  const base = trace.header ? { cycle: Number(trace.header.cycle), frame: Number(trace.header.frame) } : { cycle: 0, frame: 0 };
  for (const list of [trace.writes, trace.dmas, trace.rams, trace.probes, trace.frames] as When[][]) {
    for (const record of list) hash.update(JSON.stringify({ ...record, cycle: record.cycle - base.cycle, frame: record.frame - base.frame }));
    hash.update('|');
  }
  return hash.digest('hex');
}
