#!/usr/bin/env node
/**
 * Watson MCP server.
 *
 * Connects to the DebugServer inside a Watson-built PCSX2 (port 21512), with Pine IPC
 * (port 28011) as a fallback for memory and savestates.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DebugServerClient } from './debug-server-client.js';
import { PineClient, EmuStatus } from './pine-client.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pressPad, takeSnapshot, takeGsDump, takeGifTrace } from './navigation.js';
import { readTrace, compareTraceToDump, formatTrace } from './gs/trace.js';
import { launchAndWait, reusingProbe, kill, systemHost, claimInstance, releaseClaim, debugPort, pinePort, dataDirectory } from './lifecycle.js';
import { parseGsDump, formatSummary, TraceRefused } from './gs/parse.js';
import { walkGsDump } from './gsdump.js';
import { findConfig, loadCatalog, resolveLaunch, registerState, describeStates, Catalog } from './catalog.js';

// ===== State =====
let debugServer: DebugServerClient | null = null;
let pine: PineClient | null = null;
// The emulator instance this server launched, and whether it is one of several that may run.
let instance = 0;
let ownsEmulator = false;
const memSnapshots = new Map<string, { addr: number; data: Buffer }>();

// ===== Helpers =====
function parseAddr(s: string): number { return parseInt(s.replace(/^0x/i, ''), 16); }

function hexDump(buf: Buffer, base: number): string {
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const addr = (base + i).toString(16).padStart(8, '0');
    const hex: string[] = [];
    let ascii = '';
    for (let j = 0; j < 16; j++) {
      if (i + j < buf.length) {
        hex.push(buf[i + j].toString(16).padStart(2, '0'));
        const c = buf[i + j];
        ascii += (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : '.';
      } else { hex.push('  '); ascii += ' '; }
    }
    lines.push(`${addr}  ${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}

function hasDebug(): boolean { return debugServer?.isConnected() ?? false; }  
function hasPine(): boolean { return pine?.isConnected() ?? false; }

const WATSON_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAPTURES = path.join(WATSON_ROOT, 'Runtime', 'captures');
const STATES = path.join(WATSON_ROOT, 'Runtime', 'states');

// The consumer's watson.json: --config <file>, else WATSON_CONFIG, else the first one walking
// up from the working directory. Read on every use, so an edit takes effect without a restart.
function configFile(): string | null {
  const flag = process.argv.indexOf('--config');
  const explicit = flag >= 0 ? process.argv[flag + 1] : process.env.WATSON_CONFIG;
  return findConfig(process.cwd(), explicit);
}

function emulatorLogTail(): string {
  try {
    const lines = fs.readFileSync(path.join(dataDirectory(WATSON_ROOT, instance), 'PCSX2', 'logs', 'emulog.txt'), 'utf8').trimEnd().split(/\r?\n/);
    return lines.slice(-15).join('\n');
  } catch {
    return '';
  }
}

function catalog(): Catalog | null {
  const file = configFile();
  return file ? loadCatalog(file) : null;
}

function requireDebug(): DebugServerClient {
  if (!hasDebug()) throw new Error('No DebugServer connection — use watson_connect first');
  return debugServer!;
}

function capturePath(given: string | undefined, stem: string): string {
  const file = given ?? path.join(CAPTURES, `${stem}.png`);
  if (!/\.png$/i.test(file)) throw new Error('path must end in .png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (e: any) => ({ content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true });

async function readMem(addr: number, len: number): Promise<Buffer> {
  if (hasDebug()) return debugServer!.readMemoryBuffer('0x' + addr.toString(16), len);
  if (hasPine()) return pine!.readMemory(addr, len);
  throw new Error('No connection — use watson_connect first');
}

async function writeMem(addr: number, data: Buffer): Promise<void> {
  if (hasDebug()) { await debugServer!.writeMemory('0x' + addr.toString(16), data.toString('hex')); return; }
  if (hasPine()) { await pine!.writeMemory(addr, data); return; }
  throw new Error('No connection');
}

// ===== MCP Server =====
const server = new McpServer({ name: 'watson', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });

// ==========================================================
//  TOOL: watson_connect
// ==========================================================
server.tool('watson_connect',
  'Connect to PCSX2. Tries DebugServer (21512), then Pine (28011). DebugServer gives FULL access (128-bit regs, expressions, conditional BP, native disasm). Pine gives memory + game info.',
  { debug_port: z.number().optional().describe('DebugServer port; default 21512, or the port of the instance this server launched'), pine_port: z.number().optional().describe('Pine IPC port; default 28011, likewise'), mode: z.enum(['auto', 'debug', 'pine']).default('auto') },
  async ({ debug_port = debugPort(instance), pine_port = pinePort(instance), mode }) => {
    const results: string[] = [];
    // Try DebugServer
    if (mode === 'auto' || mode === 'debug') {
      try {
        debugServer?.disconnect();
        debugServer = new DebugServerClient('127.0.0.1', debug_port);
        await debugServer.connect();
        const st = await debugServer.getStatus();
        results.push(`✅ DebugServer: connected (PC=0x${st.pc}, paused=${st.paused})`);
        results.push('   → 128-bit registers, native disasm, expressions, conditional BP, step-over, threads');
      } catch (e: any) {
        debugServer = null;
        results.push(`❌ DebugServer (port ${debug_port}): ${e.message}`);
      }
    }
    // Try Pine
    if (mode === 'auto' || mode === 'pine') {
      try {
        pine = new PineClient('127.0.0.1', pine_port);
        await pine.connect();
        const title = await pine.getTitle();
        results.push(`✅ Pine IPC: connected (${title})`);
      } catch (e: any) {
        pine = null;
        results.push(`❌ Pine (port ${pine_port}): ${e.message}`);
      }
    }
    if (!hasDebug() && !hasPine()) {
      results.push('\n⚠️  No connections. Make sure PCSX2 is running.');
      results.push('For DebugServer: patch PCSX2 with pcsx2-plugin/DebugServer.cpp');
      results.push('For Pine: enable IPC in PCSX2 settings');
    }
    return { content: [{ type: 'text' as const, text: results.join('\n') }] };
  }
);

// ==========================================================
//  TOOL: watson_status
// ==========================================================
server.tool('watson_status', 'Get connection + emulator status.', {},
  async () => {
    const p: string[] = [];
    p.push(`DebugServer: ${hasDebug() ? '✅ connected' : '❌ not connected'}`);
    p.push(`Pine IPC:    ${hasPine() ? '✅ connected' : '❌ not connected'}`);
    if (hasDebug()) {
      try { const s = await debugServer!.getStatus(); p.push(`EE PC: ${s.pc} | Paused: ${s.paused} | Cycles: ${s.cycles}`); } catch {}
    }
    if (hasPine()) {
      try { const t = await pine!.getTitle(); const id = await pine!.getID(); p.push(`Game: ${t} (${id})`); } catch {}
    }
    return { content: [{ type: 'text' as const, text: p.join('\n') }] };
  }
);

// ==========================================================
//  TOOL: watson_read_memory
// ==========================================================
server.tool('watson_read_memory', 'Read PS2 memory. Returns hex dump.',
  { address: z.string(), length: z.number().min(1).max(4096).default(256), format: z.enum(['hexdump', 'hex', 'u32_array', 'ascii']).default('hexdump') },
  async ({ address, length, format }) => {
    try {
      const addr = parseAddr(address);
      const data = await readMem(addr, length);
      let text: string;
      if (format === 'hexdump') text = hexDump(data, addr);
      else if (format === 'hex') text = data.toString('hex');
      else if (format === 'u32_array') {
        const v: string[] = [];
        for (let i = 0; i + 3 < data.length; i += 4) v.push('0x' + data.readUInt32LE(i).toString(16).padStart(8, '0'));
        text = v.join(', ');
      } else text = data.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
      return { content: [{ type: 'text' as const, text: `Memory at 0x${addr.toString(16)} (${length}B):\n\n${text}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_write_memory
// ==========================================================
server.tool('watson_write_memory', 'Write hex data to PS2 memory. USE WITH CAUTION.',
  { address: z.string(), data: z.string().describe('Hex data e.g. "0102030405"') },
  async ({ address, data }) => {
    try {
      const addr = parseAddr(address);
      const buf = Buffer.from(data.replace(/\s/g, ''), 'hex');
      await writeMem(addr, buf);
      return { content: [{ type: 'text' as const, text: `Wrote ${buf.length} bytes to 0x${addr.toString(16)}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_read_string  
// ==========================================================
server.tool('watson_read_string', 'Read null-terminated string from PS2 memory.',
  { address: z.string(), max_length: z.number().default(256) },
  async ({ address, max_length }) => {
    try {
      if (hasDebug()) {
        const str = await debugServer!.readString(address, max_length);
        return { content: [{ type: 'text' as const, text: `"${str}" (${str.length} chars)` }] };
      }
      const addr = parseAddr(address);
      const data = await readMem(addr, max_length);
      const idx = data.indexOf(0);
      const str = data.subarray(0, idx >= 0 ? idx : data.length).toString('ascii');
      return { content: [{ type: 'text' as const, text: `"${str}" (${str.length} chars)` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_read_registers (DebugServer - FULL 128-bit!)
// ==========================================================
server.tool('watson_read_registers',
  'Read ALL EE registers — FULL 128-bit values. Categories: GPR, CP0, FPR, FCR, VU0F, VU0I, GSPRIV. Requires DebugServer.',
  { category: z.number().min(-1).max(6).default(-1).describe('-1 for all, 0=GPR, 1=CP0, 2=FPR, 3=FCR, 4=VU0F, 5=VU0I, 6=GSPRIV'), cpu: z.enum(['ee', 'iop']).default('ee') },
  async ({ category, cpu }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected. Patch PCSX2 with pcsx2-plugin/DebugServer.cpp' }], isError: true };
    try {
      const cat = category >= 0 ? category : undefined;
      const data = await debugServer!.readRegisters(cpu, cat);
      // Format nicely
      const lines: string[] = [`=== ${cpu.toUpperCase()} Registers ===`, ''];
      for (const [catName, catData] of Object.entries(data)) {
        if (catName === 'pc' || catName === 'hi' || catName === 'lo') continue;
        const cd = catData as any;
        if (!cd.regs) continue;
        lines.push(`--- ${catName} (${cd.size}-bit × ${cd.count}) ---`);
        for (const reg of cd.regs) {
          lines.push(`  ${(reg.name as string).padEnd(10)} = ${reg.display}`);
        }
        lines.push('');
      }
      if (data.pc) lines.push(`PC = ${data.pc}`);
      if (data.hi) lines.push(`HI = ${data.hi}`);
      if (data.lo) lines.push(`LO = ${data.lo}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_write_register
// ==========================================================
server.tool('watson_write_register', 'Write a register value (supports full 128-bit hex). Requires DebugServer.',
  { category: z.number().default(0).describe('0=GPR, 1=CP0, 2=FPR, etc.'), index: z.number().describe('Register index within category'), value: z.string().describe('Hex value (up to 128-bit)'), cpu: z.enum(['ee', 'iop']).default('ee') },
  async ({ category, index, value, cpu }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      await debugServer!.writeRegister(category, index, value, cpu);
      return { content: [{ type: 'text' as const, text: `Set cat=${category} reg=${index} = ${value}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_disassemble (NATIVE PCSX2!)  
// ==========================================================
server.tool('watson_disassemble', 'Disassemble MIPS instructions using PCSX2\'s NATIVE disassembler — perfect output. Requires DebugServer.',
  { address: z.string(), count: z.number().min(1).max(200).default(20), cpu: z.enum(['ee', 'iop']).default('ee') },
  async ({ address, count, cpu }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const instrs = await debugServer!.disassemble(address, count, true, cpu);
      const text = instrs.map(i => `${i.address}:  ${(i.opcode as string).padEnd(12)}  ${i.disasm}`).join('\n');
      return { content: [{ type: 'text' as const, text: `Disassembly (${count} instructions):\n\n${text}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_evaluate (EXPRESSION EVAL!)
// ==========================================================
server.tool('watson_evaluate', 'Evaluate a MIPS expression with full symbol support. Examples: "v0 + 0x100", "gp + 0x20", "sp - 4". Requires DebugServer.',
  { expression: z.string().describe('Expression to evaluate'), cpu: z.enum(['ee', 'iop']).default('ee') },
  async ({ expression, cpu }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const r = await debugServer!.evaluate(expression, cpu);
      if (r.ok) return { content: [{ type: 'text' as const, text: `"${expression}" = ${r.hex} (${r.result})` }] };
      else return { content: [{ type: 'text' as const, text: `Eval error: ${r.error}` }], isError: true };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_set_breakpoint (with CONDITIONAL!)
// ==========================================================
server.tool('watson_set_breakpoint', 'Set a breakpoint at an address. Supports conditional expressions! Requires DebugServer.',
  { address: z.string(), condition: z.string().optional().describe('Break only when expression is true, e.g. "v0 == 0x42"'), description: z.string().optional(), temporary: z.boolean().default(false) },
  async ({ address, condition, description, temporary }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      await debugServer!.setBreakpoint(address, { condition, description, temporary });
      let msg = `Breakpoint set at ${address}`;
      if (condition) msg += ` [condition: ${condition}]`;
      return { content: [{ type: 'text' as const, text: msg }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool('watson_remove_breakpoint', 'Remove a breakpoint.',
  { address: z.string() },
  async ({ address }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try { await debugServer!.removeBreakpoint(address); return { content: [{ type: 'text' as const, text: `Breakpoint removed at ${address}` }] }; }
    catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool('watson_list_breakpoints', 'List all breakpoints with their conditions and hit status.',
  {},
  async () => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const bps = await debugServer!.listBreakpoints();
      if (bps.length === 0) return { content: [{ type: 'text' as const, text: 'No breakpoints set.' }] };
      const lines = bps.map(bp => {
        let s = `${bp.address} ${bp.enabled ? '✅' : '❌'}`;
        if (bp.has_condition) s += ` [cond: ${bp.condition}]`;
        if (bp.description) s += ` — ${bp.description}`;
        if (bp.temporary) s += ' (temp)';
        return s;
      });
      return { content: [{ type: 'text' as const, text: `${bps.length} breakpoint(s):\n${lines.join('\n')}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_set_watchpoint (with onChange!)
// ==========================================================
server.tool('watson_set_watchpoint', 'Set a memory watchpoint. Supports read/write/access/onchange + optional condition expression!',
  { address: z.string(), end: z.string().optional().describe('End address (default: address+4)'), type: z.enum(['read', 'write', 'readwrite', 'onchange']).default('write'), action: z.enum(['break', 'log', 'both']).default('break'), condition: z.string().optional(), description: z.string().optional() },
  async ({ address, end, type, action, condition, description }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const endAddr = end || '0x' + (parseAddr(address) + 4).toString(16);
      await debugServer!.setMemcheck(address, endAddr, { type, action, condition, description });
      return { content: [{ type: 'text' as const, text: `Watchpoint (${type}/${action}) set at ${address}-${endAddr}${condition ? ` [cond: ${condition}]` : ''}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool('watson_remove_watchpoint', 'Remove a memory watchpoint.',
  { address: z.string(), end: z.string().optional() },
  async ({ address, end }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const endAddr = end || '0x' + (parseAddr(address) + 4).toString(16);
      await debugServer!.removeMemcheck(address, endAddr);
      return { content: [{ type: 'text' as const, text: `Watchpoint removed at ${address}-${endAddr}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool('watson_list_watchpoints', 'List all memory watchpoints with hit counts.',
  {},
  async () => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const mcs = await debugServer!.listMemchecks();
      if (mcs.length === 0) return { content: [{ type: 'text' as const, text: 'No watchpoints set.' }] };
      const lines = mcs.map(mc => `${mc.start}-${mc.end} | ${mc.hits} hits | last_PC=${mc.last_pc}${mc.description ? ` — ${mc.description}` : ''}`);
      return { content: [{ type: 'text' as const, text: `${mcs.length} watchpoint(s):\n${lines.join('\n')}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_step / step_over / continue / pause
// ==========================================================
server.tool('watson_step', 'Execute one MIPS instruction. Returns new PC + native disasm. Requires DebugServer.',
  { count: z.number().min(1).max(100).default(1), show_registers: z.boolean().default(false) },
  async ({ count, show_registers }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const results: string[] = [];
      for (let i = 0; i < count; i++) {
        const r = await debugServer!.step();
        results.push(`Step ${i + 1}: PC=${r.new_pc}  ${r.opcode}  ${r.disasm}`);
      }
      if (show_registers) {
        const regs = await debugServer!.readRegisters('ee', 0); // GPR only
        results.push('', '--- GPR ---');
        for (const reg of (regs as any).GPR?.regs || [])
          results.push(`  ${(reg.name as string).padEnd(6)} = ${reg.display}`);
      }
      return { content: [{ type: 'text' as const, text: results.join('\n') }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool('watson_step_over', 'Step OVER a JAL/JALR call — like "next" in a debugger. Requires DebugServer.',
  {},
  async () => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const r = await debugServer!.stepOver();
      return { content: [{ type: 'text' as const, text: `Stepped over: ${r.old_pc} → ${r.new_pc}\n${r.disasm}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool('watson_continue', 'Resume execution until breakpoint or halt.',
  {},
  async () => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try { await debugServer!.resume(); return { content: [{ type: 'text' as const, text: 'Resumed. Use watson_pause to stop.' }] }; }
    catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool('watson_pause', 'Pause/halt the emulator. Returns current PC.',
  {},
  async () => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try { const pc = await debugServer!.pause(); return { content: [{ type: 'text' as const, text: `Paused at PC=${pc}` }] }; }
    catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_get_threads / watson_get_modules
// ==========================================================
server.tool('watson_get_threads', 'List EE/IOP BIOS threads with their status.',
  { cpu: z.enum(['ee', 'iop']).default('ee') },
  async ({ cpu }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const threads = await debugServer!.getThreads(cpu);
      if (threads.length === 0) return { content: [{ type: 'text' as const, text: 'No threads.' }] };
      const lines = threads.map(t => `TID ${t.id}: PC=${t.pc} status=${t.status} waitType=${t.wait_type}`);
      return { content: [{ type: 'text' as const, text: `${threads.length} threads:\n${lines.join('\n')}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool('watson_get_modules', 'List loaded IOP modules.',
  {},
  async () => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const mods = await debugServer!.getModules('iop');
      const lines = mods.map(m => `${m.name} (v${m.version})`);
      return { content: [{ type: 'text' as const, text: `${mods.length} modules:\n${lines.join('\n')}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_get_backtrace
// ==========================================================
server.tool('watson_get_backtrace', 'Get call stack backtrace (stack walk). Shows function entry points, PCs, stack pointers, and disassembly for each frame. Requires DebugServer + paused state.',
  { cpu: z.enum(['ee', 'iop']).default('ee'), max_frames: z.number().min(1).max(128).default(32) },
  async ({ cpu, max_frames }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const frames = await debugServer!.getBacktrace(cpu, max_frames);
      if (frames.length === 0) return { content: [{ type: 'text' as const, text: 'No stack frames (may not be paused, or no thread running).' }] };
      const lines = frames.map((f, i) => `#${i} entry=${f.entry} pc=${f.pc} sp=${f.sp} size=${f.stack_size}  ${f.disasm}`);
      return { content: [{ type: 'text' as const, text: `Call stack (${frames.length} frames):\n${lines.join('\n')}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_game_info / save_state / load_state (Pine)
// ==========================================================
server.tool('watson_game_info', 'Get game title, ID, version from PCSX2. Requires Pine.',
  {},
  async () => {
    if (!hasPine()) return { content: [{ type: 'text' as const, text: 'Error: Pine not connected.' }], isError: true };
    try {
      const [t, id, uuid, gv, ev, st] = await Promise.all([pine!.getTitle(), pine!.getID(), pine!.getUUID(), pine!.getGameVersion(), pine!.getVersion(), pine!.getStatus()]);
      return { content: [{ type: 'text' as const, text: `Title: ${t}\nID: ${id}\nUUID: ${uuid}\nGame: ${gv}\nPCSX2: ${ev}\nStatus: ${st === EmuStatus.Running ? 'Running' : st === EmuStatus.Paused ? 'Paused' : 'Shutdown'}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool('watson_save_state', 'Save emulator state. Requires Pine.', { slot: z.number().min(0).max(9) },
  async ({ slot }) => {
    if (!hasPine()) return { content: [{ type: 'text' as const, text: 'Pine not connected.' }], isError: true };
    try { await pine!.saveState(slot); return { content: [{ type: 'text' as const, text: `Saved to slot ${slot}` }] }; }
    catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool('watson_load_state', 'Load emulator state. Requires Pine.', { slot: z.number().min(0).max(9) },
  async ({ slot }) => {
    if (!hasPine()) return { content: [{ type: 'text' as const, text: 'Pine not connected.' }], isError: true };
    try { await pine!.loadState(slot); return { content: [{ type: 'text' as const, text: `Loaded from slot ${slot}` }] }; }
    catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_find_pattern
// ==========================================================
server.tool('watson_find_pattern', 'Search PS2 memory for a hex pattern. Use ?? for wildcards.',
  { pattern: z.string(), start: z.string().default('0x00100000'), end: z.string().default('0x02000000'), max_results: z.number().default(20) },
  async ({ pattern, start, end, max_results }) => {
    try {
      const startAddr = parseAddr(start);
      const endAddr = parseAddr(end);
      const parts = pattern.replace(/\s/g, '').match(/.{2}/g) || [];
      const pat = parts.map(p => p === '??' ? null : parseInt(p, 16));
      if (pat.length === 0) return { content: [{ type: 'text' as const, text: 'Empty pattern' }], isError: true };
      const results: number[] = [];
      const chunk = 4096;
      for (let a = startAddr; a < endAddr && results.length < max_results; a += chunk) {
        let data: Buffer;
        try { data = await readMem(a, Math.min(chunk + pat.length, endAddr - a)); } catch { continue; }
        for (let i = 0; i <= data.length - pat.length && results.length < max_results; i++) {
          let ok = true;
          for (let j = 0; j < pat.length; j++) { if (pat[j] !== null && data[i + j] !== pat[j]) { ok = false; break; } }
          if (ok) results.push(a + i);
        }
      }
      if (results.length === 0) return { content: [{ type: 'text' as const, text: `No matches for "${pattern}"` }] };
      return { content: [{ type: 'text' as const, text: `${results.length} match(es):\n${results.map(a => '0x' + a.toString(16).padStart(8, '0')).join('\n')}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_memory_diff
// ==========================================================
server.tool('watson_memory_diff', 'Snapshot-and-compare memory. First call = snapshot, second = diff.',
  { address: z.string(), length: z.number().default(256), name: z.string().default('default') },
  async ({ address, length, name }) => {
    try {
      const addr = parseAddr(address);
      const data = await readMem(addr, length);
      const key = `${name}_${addr}_${length}`;
      if (!memSnapshots.has(key)) {
        memSnapshots.set(key, { addr, data });
        return { content: [{ type: 'text' as const, text: `Snapshot "${name}" saved. Call again to diff.` }] };
      }
      const prev = memSnapshots.get(key)!;
      memSnapshots.delete(key);
      const changes: string[] = [];
      for (let i = 0; i < Math.min(prev.data.length, data.length); i++) {
        if (prev.data[i] !== data[i]) changes.push(`  +0x${i.toString(16).padStart(4, '0')} (0x${(addr + i).toString(16)}): ${prev.data[i].toString(16).padStart(2, '0')} → ${data[i].toString(16).padStart(2, '0')}`);
      }
      if (changes.length === 0) return { content: [{ type: 'text' as const, text: 'No changes.' }] };
      return { content: [{ type: 'text' as const, text: `${changes.length} byte(s) changed:\n${changes.join('\n')}` }] };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  TOOL: watson_clear_all_breakpoints
// ==========================================================
server.tool('watson_clear_all_breakpoints', 'Clear ALL breakpoints and watchpoints.',
  {},
  async () => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try { await debugServer!.clearAllBreakpoints(); return { content: [{ type: 'text' as const, text: 'All breakpoints and watchpoints cleared.' }] }; }
    catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ==========================================================
//  Lifecycle
// ==========================================================
server.tool('watson_launch',
  'Start the Watson PCSX2 and connect to it. Prefer build + state by name from watson.json (see watson_states), e.g. build "rom-0230A", state "clock". Files can be given instead: bios, elf, and state as a .p2s path. Set interpreter to trace GIF packets.',
  {
    build: z.string().optional().describe('Build id from watson.json'),
    state: z.string().optional().describe('State name within the build, or a .p2s file path'),
    bios: z.string().optional(),
    elf: z.string().optional(),
    interpreter: z.boolean().default(false).describe('Run the EE and VU interpreters instead of the recompilers. Slow; needed by watson_gif_trace.'),
    visible: z.boolean().default(false).describe('Show the emulator window. By default it starts minimized.'),
    args: z.string().optional().describe('Arguments handed to the program that boots, space separated, e.g. "BootClock"'),
  },
  async (request) => {
    try {
      const { bios, elf, state } = resolveLaunch(catalog(), request);
      if (state && !fs.existsSync(state)) throw new Error(`state file not found: ${state}`);
      const pool = catalog()?.instances ?? 1;
      if (ownsEmulator) throw new Error(`this server already launched instance ${instance}; use watson_kill first`);
      instance = await claimInstance(systemHost, WATSON_ROOT, pool);
      const port = debugPort(instance);
      const { probe, current } = reusingProbe(async () => {
        const client = new DebugServerClient('127.0.0.1', port);
        try { await client.connect(); return client; } catch (error) { client.disconnect(); throw error; }
      });
      debugServer?.disconnect();
      debugServer = null;
      let started;
      try {
        started = await launchAndWait(systemHost, WATSON_ROOT, { bios, elf, state, interpreter: request.interpreter, visible: request.visible, gameArgs: request.args, instance }, probe,
          { timeoutMs: 60000, intervalMs: 500, logTail: emulatorLogTail });
      } catch (error) {
        current()?.disconnect();
        releaseClaim(WATSON_ROOT, instance);
        throw error;
      }
      debugServer = current();
      ownsEmulator = pool > 1;
      return text(`launched pid ${started.pid}${pool > 1 ? ` as instance ${instance} (port ${port})` : ''}; connected; alive=${started.alive} frame=${started.frame}`);
    } catch (e: any) { return failure(e); }
  }
);

server.tool('watson_kill', 'Terminate the PCSX2 that watson_launch started. Never touches another PCSX2.', {},
  async () => {
    try {
      debugServer?.disconnect();
      // With several instances, instance 0 may be another server's: only kill what this one launched.
      if ((catalog()?.instances ?? 1) > 1 && !ownsEmulator) throw new Error('this server launched no emulator');
      debugServer = null;
      const result = await kill(systemHost, WATSON_ROOT, instance);
      ownsEmulator = false;
      return text(result);
    } catch (e: any) { return failure(e); }
  }
);

server.tool('watson_states', 'List the save states named in watson.json, per build, with their files.', {},
  async () => {
    try {
      const known = catalog();
      if (!known) return text('no watson.json was found; pass --config <file> to the server or run it inside the project');
      return text(`${known.file}\n${describeStates(known).join('\n')}`);
    } catch (e: any) { return failure(e); }
  }
);

server.tool('watson_state_save',
  'Save the current emulator state under a name for a build and record it in watson.json, so watson_launch can load it by name later.',
  { build: z.string(), name: z.string().describe('Lowercase letters, digits and hyphens, e.g. "clock"') },
  async ({ build, name }) => {
    try {
      const known = catalog();
      if (!known) throw new Error('no watson.json was found, so there is nowhere to record the name');
      if (!known.builds.some((candidate) => candidate.id === build)) {
        throw new Error(`unknown build ${build}; known: ${known.builds.map((b) => b.id).join(', ')}`);
      }
      const file = path.join(STATES, `${build}-${name}.p2s`);
      registerState(known.file, build, name, file);
      fs.mkdirSync(STATES, { recursive: true });
      await requireDebug().saveStateFile(file);
      return text(`saved ${build} / ${name} -> ${file}`);
    } catch (e: any) { return failure(e); }
  }
);

// ==========================================================
//  Navigation: time, input, capture, state
// ==========================================================
server.tool('watson_frame_advance', 'Run exactly N frames, then pause. Returns the frame counter.',
  { frames: z.number().int().min(1).max(3600).default(1) },
  async ({ frames }) => {
    try { return text(`frame ${await requireDebug().frameAdvance(frames)} (paused)`); }
    catch (e: any) { return failure(e); }
  }
);

server.tool('watson_pad',
  'Hold pad buttons on port 1 for N frames, release, run one more frame. Leaves the VM paused. Buttons: up, right, down, left, triangle, circle, cross, square, select, start, l1, l2, r1, r2, l3, r3.',
  { buttons: z.array(z.string()).min(1), frames: z.number().int().min(1).max(600).default(4) },
  async ({ buttons, frames }) => {
    try { return text(`pressed ${buttons.join('+')} for ${frames} frames; frame ${await pressPad(requireDebug(), buttons, frames)} (paused)`); }
    catch (e: any) { return failure(e); }
  }
);

server.tool('watson_snapshot', 'Write a PNG of the current frame from the software renderer. Advances 2 frames and leaves the VM paused.',
  { path: z.string().optional().describe('Absolute .png path; default Runtime/captures/frame-<n>.png') },
  async ({ path: given }) => {
    try {
      const client = requireDebug();
      const frame = (await client.getStatus()).frame;
      return text(await takeSnapshot(client, capturePath(given, `frame-${frame}`)));
    } catch (e: any) { return failure(e); }
  }
);

server.tool('watson_gs_dump', 'Capture N frames to an uncompressed GS dump (.gs) with a PNG beside it. Leaves the VM paused.',
  { frames: z.number().int().min(1).max(600).default(1), path: z.string().optional().describe('Absolute .png path; the dump takes the same name with .gs') },
  async ({ frames, path: given }) => {
    try {
      const client = requireDebug();
      const frame = (await client.getStatus()).frame;
      const files = await takeGsDump(client, capturePath(given, `dump-${frame}`), frames);
      return text(`dump: ${files.dump}\npng: ${files.png}`);
    } catch (e: any) { return failure(e); }
  }
);

// Capture frame 0 is the frame that starts at the first vsync after the capture is armed: the
// first frame the dump holds. Everything below is applied by the emulator on the CPU thread at
// that frame boundary, and recorded in the trace.
const FRAME_NOTE = 'Frames count from 0, the first frame the dump holds (it starts at the first vsync after the capture is armed); each must be below `frames`.';
const padSchedule = z.array(z.object({
  frame: z.number().int().min(0).describe('Capture frame the buttons go down at, before the EE runs it'),
  press: z.array(z.string()).min(1).describe('Buttons: up, right, down, left, triangle, circle, cross, square, select, start, l1, l2, r1, r2, l3, r3'),
  frames: z.number().int().min(1).describe('Frames they stay down; they come up at the start of frame + frames (or when the capture stops)'),
})).default([]).describe(`Pad buttons on port 1, pressed and let go on exact frame boundaries inside the capture; each change is recorded in the trace as a "pad" record. ${FRAME_NOTE} A button may not also be in hold.`);
const memoryWrites = z.array(z.object({
  frame: z.number().int().min(0).describe('Capture frame whose start the write lands at, before the EE runs that frame'),
  address: z.string().describe('EE address, hex: main RAM (any segment) or the scratchpad (0x70000000)'),
  hex: z.string().describe('Bytes to write, in memory order, e.g. "74000000" for the word 0x00000074. Up to 0x10000 bytes.'),
})).default([]).describe(`Writes to EE memory at the start of a capture frame, in the order given, each recorded in the trace as a "write" record. ${FRAME_NOTE} A write to code is a patch: compiled blocks there are thrown away, under either CPU mode. A patch written before the program's code is loaded is overwritten by the load, as is any write the program itself later overwrites.`);
const probeWindow = {
  fromFrame: z.number().int().min(0).optional().describe('First capture frame the probe records in; without it, it records from the moment the capture is armed'),
  untilFrame: z.number().int().min(1).optional().describe('First capture frame the probe no longer records in; without it, until the capture stops'),
};

server.tool('watson_gif_trace',
  'Record, for N frames, every packet the EE side sends to the GS with where it came from: GIF path, source address, the EE instruction and call stack that started the DMA, the VU1 program counter. Captures a GS dump and a PNG of the same frames and checks the trace against the dump byte for byte. Needs watson_launch with interpreter: true. Leaves the VM paused. Feed the trace to watson_gsdump_parse to tie each draw to its origin.',
  {
    frames: z.number().int().min(1).max(600).default(1),
    path: z.string().optional().describe('Absolute .png path; the dump and the trace take the same name with .gs and .trace.jsonl'),
    probes: z.array(z.object({
      pc: z.string().describe('Program counter, hex. The probe fires before the instruction there executes.'),
      ranges: z.array(z.string()).default([]).describe('Memory to record, each `[*]base[+hex]:hexlength`: base is a register name (a0, sp, ...) or a hex address; `*` follows the 32-bit pointer found there. Example: "a0:0x160", "*a1+0x60:0x40". Up to 64, 0x10000 bytes each.'),
      ...probeWindow,
    })).max(1024).default([]).describe('Record the EE registers and these memory ranges into the trace every time execution reaches a program counter: the real inputs of a function, in order with the packets it sends'),
    hold: z.array(z.string()).default([]).describe('Pad buttons held on port 1 through the traced frames, pressed after the trace is armed and released before it stops: records what a press sets off from its first frame'),
    pad: padSchedule,
    writes: memoryWrites,
  },
  async ({ frames, path: given, probes, hold, pad, writes }) => {
    try {
      const client = requireDebug();
      const frame = (await client.getStatus()).frame;
      const files = await takeGifTrace(client, capturePath(given, `trace-${frame}`), frames, probes, hold, 'interpreter', { pad, writes });
      const trace = readTrace(files.trace);
      if (!trace.complete) {
        return { content: [{ type: 'text' as const, text: `trace: ${files.trace}\nbuild: unknown\nverdict: NOT VERIFIED ${trace.reason}  coverage 0/?` }], isError: true };
      }
      const parity = compareTraceToDump(trace, fs.readFileSync(files.dump));
      const failed = Boolean(parity.mismatch) || trace.desyncs.length > 0;
      return { content: [{ type: 'text' as const, text: formatTrace(trace, parity, files, probes) }], ...(failed ? { isError: true } : {}) };
    } catch (e: any) { return failure(e); }
  }
);

server.tool('watson_frame_capture',
  'Record, for N frames, every packet sent to the GS and the EE registers and memory ranges at each probe, into the same trace format as watson_gif_trace, with a GS dump of the same frames, but without the instruction and call stack behind each packet: that stack walk is most of the cost of a traced frame. cpu "interpreter" (default; needs watson_launch with interpreter: true, or watson_set_cpu_mode) gives the interpreters\' arithmetic, the one every verifier was checked against, at a fraction of the cost of watson_gif_trace. cpu "recompiler" (launch without the interpreter option) runs at full speed, probes firing from breakpoint checks the recompiler compiles at their addresses; its float results differ from the interpreters\' in the last bits (the library\'s sine and cosine, FPU sums), so use it for structure, not for bit-for-bit checks. Several probes may share a program counter; each record carries the index of its probe. Leaves the VM paused.',
  {
    frames: z.number().int().min(1).max(3600).default(1),
    path: z.string().optional().describe('Absolute .png path; the dump and the trace take the same name with .gs and .trace.jsonl'),
    cpu: z.enum(['interpreter', 'recompiler']).default('interpreter'),
    probes: z.array(z.object({
      pc: z.string().describe('Program counter, hex. The probe fires before the instruction there executes.'),
      ranges: z.array(z.string()).default([]).describe('Memory to record, as for watson_gif_trace. Up to 64, 0x10000 bytes each.'),
      ...probeWindow,
    })).max(1024).default([]),
    hold: z.array(z.string()).default([]).describe('Pad buttons held on port 1 through the captured frames'),
    pad: padSchedule,
    writes: memoryWrites,
  },
  async ({ frames, path: given, cpu, probes, hold, pad, writes }) => {
    try {
      const client = requireDebug();
      const frame = (await client.getStatus()).frame;
      const started = Date.now();
      const files = await takeGifTrace(client, capturePath(given, `capture-${frame}`), frames, probes, hold, cpu === 'recompiler' ? 'recompiler' : 'plain', { pad, writes });
      const seconds = (Date.now() - started) / 1000;
      const trace = readTrace(files.trace);
      if (!trace.complete) {
        return { content: [{ type: 'text' as const, text: `trace: ${files.trace}\nverdict: NOT VERIFIED ${trace.reason}  coverage 0/?` }], isError: true };
      }
      const parity = compareTraceToDump(trace, fs.readFileSync(files.dump));
      const failed = Boolean(parity.mismatch) || trace.desyncs.length > 0;
      return { content: [{ type: 'text' as const, text: `${formatTrace(trace, parity, files, probes)}\ntime: ${seconds.toFixed(1)} s for ${frames} frames` }], ...(failed ? { isError: true } : {}) };
    } catch (e: any) { return failure(e); }
  }
);

server.tool('watson_set_cpu_mode',
  'Switch the EE and VUs between the interpreters and the recompilers while the VM runs or is paused; the machine state is kept and the switch happens at the next execution slice. Navigate or boot under the recompilers (fast), then switch to the interpreters for watson_gif_trace or watson_frame_capture. Refused while a trace is recording.',
  { mode: z.enum(['interpreter', 'recompiler']) },
  async ({ mode }) => {
    try {
      const interpreter = await requireDebug().setCpuMode(mode);
      return text(`cpu mode: ${interpreter ? 'interpreters' : 'recompilers'}`);
    } catch (e: any) { return failure(e); }
  }
);

server.tool('watson_gs_read',
  'Write GS local memory (4 MB, or a part) to a file, after the GS thread has drawn everything sent so far. Pause the VM where you want to look (e.g. a breakpoint after an emitter sends its packet, under the recompilers) and read the buffers between sends. The software renderer (the default of the launch of Watson) keeps this memory current; a hardware renderer does not. The file is raw GS memory, swizzled as the GS stores it.',
  {
    path: z.string().describe('Absolute path of the file to write'),
    offset: z.number().int().min(0).default(0).describe('Byte offset; a block (as TBP/FBP count them in 256-byte units) is offset / 256'),
    length: z.number().int().min(1).max(4 * 1024 * 1024).default(4 * 1024 * 1024),
  },
  async ({ path: file, offset, length }) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const done = await requireDebug().gsRead(file, offset, length);
      const renderer = done.renderer === 13 ? 'software' : `renderer ${done.renderer} (not the software one: the memory may be stale)`;
      return text(`wrote ${done.bytes} bytes of GS memory from offset 0x${offset.toString(16)} to ${file}; ${renderer}`);
    } catch (e: any) { return failure(e); }
  }
);

server.tool('watson_save_state_file', 'Save the emulator state to a file.', { path: z.string() },
  async ({ path: file }) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await requireDebug().saveStateFile(file);
      return text(`saved ${file}`);
    } catch (e: any) { return failure(e); }
  }
);

server.tool('watson_load_state_file', 'Load the emulator state from a file.', { path: z.string() },
  async ({ path: file }) => {
    try {
      if (!fs.existsSync(file)) throw new Error(`no state file at ${file}`);
      await requireDebug().loadStateFile(file);
      return text(`loaded ${file}; frame ${(await requireDebug().getStatus()).frame}`);
    } catch (e: any) { return failure(e); }
  }
);

// ==========================================================
//  GS dumps, offline
// ==========================================================
server.tool('watson_gsdump_parse',
  'Parse a GS dump (.gs) offline into JSON Lines: every draw with its primitive, vertices and register state, every upload and VRAM copy, per frame. Returns a summary: draws per frame, blend equations, frame targets, textures, tests. Needs no running emulator.',
  {
    path: z.string().describe('Absolute path of an uncompressed .gs dump'),
    out: z.string().optional().describe('Where to write the JSON Lines; default is the dump path with .jsonl'),
    writes: z.boolean().default(false).describe('Also record every GIF tag and register write, in arrival order (about 1 MB more per frame)'),
    trace: z.string().optional().describe('A GIF trace of the same capture (from watson_gif_trace): each draw then names the path, source address and EE origin of its data'),
  },
  async ({ path: file, out, writes, trace }) => {
    const target = out ?? file.replace(/\.gs$/i, '') + '.jsonl';
    const walk = walkGsDump(file);
    if (!walk.complete) {
      return { content: [{ type: 'text' as const, text: `dump: ${file}\nbuild: unknown\nverdict: NOT VERIFIED ${walk.reason}  coverage ${walk.packets}/?` }], isError: true };
    }
    try {
      return text(formatSummary(parseGsDump(file, target, { writes, trace }), file, target));
    } catch (e: any) {
      if (e instanceof TraceRefused) {
        return { content: [{ type: 'text' as const, text: `dump: ${file}\nbuild: unknown\nverdict: NOT VERIFIED ${e.message}  coverage 0/${walk.packets}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `dump: ${file}\nbuild: unknown\nverdict: PARTIAL ${e.message}  coverage ?/${walk.packets}` }], isError: true };
    }
  }
);

// ==========================================================
//  MCP Resources
// ==========================================================
server.resource('ps2_memory_map', 'ps2://memory_map', async () => ({
  contents: [{ uri: 'ps2://memory_map', mimeType: 'text/plain', text: `PS2 EE Memory Map\n0x00000000-0x01FFFFFF  RDRAM (32MB)\n0x10000000-0x1000FFFF  EE Registers\n0x11000000-0x11FFFFFF  VU0/VU1\n0x12000000-0x12FFFFFF  GS Registers\n0x1C000000-0x1C3FFFFF  IOP RAM (2MB)\n0x1FC00000-0x1FFFFFFF  BIOS ROM (4MB)\n0x70000000-0x70003FFF  Scratchpad (16KB)` }]
}));

server.resource('debug_protocol', 'ps2://debug_protocol', async () => ({
  contents: [{ uri: 'ps2://debug_protocol', mimeType: 'text/plain', text: `PCSX2 Debug Server Protocol (port 21512)\nNewline-delimited JSON over TCP\n\nCommands: status, read_registers, write_register, set_pc, read_memory, write_memory, read_string, disassemble, evaluate, set_breakpoint, remove_breakpoint, list_breakpoints, set_memcheck, remove_memcheck, list_memchecks, pause, resume, step, step_over, get_threads, get_modules, is_valid_address, clear_breakpoints\n\nRequest:  {"cmd":"read_registers","cpu":"ee","category":0}\\n\nResponse: {"ok":true,"data":{...}}\\n` }]
}));

// ===== MAIN =====
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // With several instances a session that ends without watson_kill would keep one taken for good.
  const leave = async () => {
    if (ownsEmulator) { ownsEmulator = false; try { await kill(systemHost, WATSON_ROOT, instance); } catch { /* already gone */ } }
    process.exit(0);
  };
  transport.onclose = leave;
  process.stdin.on('end', leave);
  console.error('Watson MCP server running');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
