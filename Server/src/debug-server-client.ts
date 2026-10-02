/**
 * PCSX2 Debug Server Client
 * Talks to the custom C++ JSON/TCP server inside PCSX2 (port 21512)
 * 
 * This REPLACES the GDB client — gives us EVERYTHING:
 *   - Full 128-bit registers (all 7 categories)
 *   - Native PCSX2 disassembly
 *   - Expression evaluation with symbol lookup
 *   - Conditional breakpoints
 *   - Memory watchpoints (read/write/onChange)
 *   - Step and step-over (delay slot aware)
 *   - Thread list, module list
 *   - String reading, address validation
 * 
 * Protocol: newline-delimited JSON over TCP
 * Request:  {"cmd":"...", ...}\n
 * Response: {"ok":true, ...}\n
 */

import * as net from 'node:net';

export interface DebugRegister {
  name: string;
  value: string;  // 32-char hex string (128-bit)
  display: string; // PCSX2's formatted display
}

export interface RegisterCategory {
  size: number;  // bits per register
  count: number;
  regs: DebugRegister[];
}


export interface DisasmInstruction {
  address: string;
  opcode: string;
  disasm: string;
}

export interface BreakpointInfo {
  address: string;
  enabled: boolean;
  temporary: boolean;
  stepping: boolean;
  has_condition: boolean;
  condition?: string;
  description?: string;
}

export interface MemcheckInfo {
  start: string;
  end: string;
  hits: number;
  last_pc: string;
  last_addr: string;
  description?: string;
}

export interface ThreadInfo {
  id: number;
  pc: string;
  status: number;
  wait_type: number;
}

/**
 * A place to record the EE's registers, and memory, every time execution reaches it during a
 * GIF trace. A range is `[*]base[+hex]:hexlength`: base is a register name (a0, sp, ...) or a
 * hex address; `*` reads the 32-bit pointer found there and records what it points to.
 */
export interface ProbeSpec { pc: string; ranges?: string[] }
export type TraceMode = 'interpreter' | 'plain' | 'recompiler';

/** Probes in the form the DebugServer takes: `pc=range,range;pc`. */
export function probeString(probes: ProbeSpec[]): string {
  return probes.map((probe) => {
    if (!/^(0x)?[0-9a-fA-F]{1,8}$/.test(probe.pc)) throw new Error(`program counter "${probe.pc}" is not a hex number`);
    const ranges = probe.ranges ?? [];
    for (const range of ranges) {
      if (/[;,=\s]/.test(range) || range.length === 0) throw new Error(`range "${range}" of probe ${probe.pc} holds a character the grammar reserves`);
    }
    return ranges.length > 0 ? `${probe.pc}=${ranges.join(',')}` : probe.pc;
  }).join(';');
}

export interface StepResult {
  old_pc: string;
  new_pc: string;
  disasm: string;
  opcode: string;
}

export interface EvalResult {
  ok: boolean;
  result?: number;
  hex?: string;
  error?: string;
}

type CpuTarget = 'ee' | 'iop';

export class DebugServerClient {
  private host: string;
  private port: number;
  private socket: net.Socket | null = null;
  private connected = false;
  private responseBuffer = '';
  private pendingResolve: ((data: any) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(host = '127.0.0.1', port = 21512) {
    this.host = host;
    this.port = port;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.setEncoding('utf8');

      const timeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error(`Connection timeout to DebugServer at ${this.host}:${this.port}`));
      }, 3000);

      this.socket.connect(this.port, this.host, () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve();
      });

      this.socket.on('data', (data: string) => {
        this.responseBuffer += data;
        this.processBuffer();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        this.connected = false;
        if (this.pendingReject) {
          this.pendingReject(err);
          this.pendingResolve = null;
          this.pendingReject = null;
        } else {
          reject(err);
        }
      });

      this.socket.on('close', () => {
        this.connected = false;
        if (this.pendingReject) {
          const reject = this.pendingReject;
          this.pendingResolve = null;
          this.pendingReject = null;
          reject(new Error('DebugServer connection closed'));
        }
      });
    });
  }

  private processBuffer(): void {
    for (let newlineIdx = this.responseBuffer.indexOf('\n'); newlineIdx >= 0; newlineIdx = this.responseBuffer.indexOf('\n')) {
      const line = this.responseBuffer.substring(0, newlineIdx);
      this.responseBuffer = this.responseBuffer.substring(newlineIdx + 1);

      const resolve = this.pendingResolve;
      const reject = this.pendingReject;
      this.pendingResolve = null;
      this.pendingReject = null;
      if (!resolve || !reject) continue;
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`Invalid JSON: ${line}`));
      }
    }
  }

  // The protocol carries no request id, so replies are matched by order: one request on the
  // wire at a time, and a request that times out takes the connection down with it, because
  // its late reply would otherwise be handed to the next request.
  private send(cmd: Record<string, any>): Promise<any> {
    const result = this.queue.then(() => this.exchange(cmd));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private exchange(cmd: Record<string, any>): Promise<any> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('Not connected to PCSX2 Debug Server'));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingReject !== settleReject) return;
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(new Error(`Command timeout: ${cmd.cmd}`));
        this.socket?.destroy();
      }, cmd.cmd === 'frame_advance' ? 10000 + cmd.frames * 20000
        // The emulator waits up to 60 s for the CPU thread to take these.
        : ['pause', 'resume', 'gs_read', 'set_cpu_mode'].includes(cmd.cmd) ? 70000 : 10000);
      const settleResolve = (data: any) => { clearTimeout(timer); resolve(data); };
      const settleReject = (err: Error) => { clearTimeout(timer); reject(err); };

      this.pendingResolve = settleResolve;
      this.pendingReject = settleReject;
      this.socket!.write(JSON.stringify(cmd) + '\n');
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  isConnected(): boolean { return this.connected; }

  // ===== Status =====

  async getStatus(cpu: CpuTarget = 'ee'): Promise<{ alive: boolean; paused: boolean; pc: string; cycles: number; frame: number; interpreter: boolean }> {
    const resp = await this.send({ cmd: 'status', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.data;
  }

  // ===== Time, input, capture, state =====

  private static wirePath(path: string): string { return path.replace(/\\/g, '/'); }

  /** Run exactly `frames` frames, then pause. Returns the frame counter. */
  async frameAdvance(frames: number): Promise<number> {
    const resp = await this.send({ cmd: 'frame_advance', frames });
    if (!resp.ok) throw new Error(resp.error);
    return resp.frame;
  }

  /** Hold (1) or release (0) pad buttons on port 1. The state persists until changed. */
  async padSet(buttons: string[], value: 0 | 1): Promise<void> {
    const resp = await this.send({ cmd: 'pad_set', buttons: buttons.join(','), value });
    if (!resp.ok) throw new Error(resp.error);
  }

  /** Ask the GS for a PNG at `path` and, when dumpFrames > 0, a GS dump beside it. */
  async queueSnapshot(path: string, dumpFrames: number): Promise<void> {
    const resp = await this.send({ cmd: 'queue_snapshot', path: DebugServerClient.wirePath(path), dump_frames: dumpFrames });
    if (!resp.ok) throw new Error(resp.error);
  }

  /**
   * Start recording GIF packets to `path`. 'interpreter' (needs the interpreters) also records the
   * instruction and call stack behind each packet; 'plain' (interpreters) leaves that out, which is
   * most of a traced frame's cost; 'recompiler' (recompilers) records packets and probes at full
   * speed, with arithmetic that is not the interpreters' to the last bit.
   */
  async gifTraceStart(path: string, probes: ProbeSpec[] = [], mode: TraceMode = 'interpreter'): Promise<void> {
    const wire = probeString(probes);
    const resp = await this.send({ cmd: 'gif_trace_start', path: DebugServerClient.wirePath(path), ...(wire ? { probes: wire } : {}), ...(mode !== 'interpreter' ? { mode } : {}) });
    if (!resp.ok) throw new Error(resp.error);
  }

  /** Stop the trace and close its file. Returns the packets recorded. */
  async gifTraceStop(): Promise<number> {
    const resp = await this.send({ cmd: 'gif_trace_stop' });
    if (!resp.ok) throw new Error(resp.error);
    return resp.packets;
  }

  async saveStateFile(path: string): Promise<void> {
    const resp = await this.send({ cmd: 'save_state_file', path: DebugServerClient.wirePath(path) });
    if (!resp.ok) throw new Error(resp.error);
  }

  async loadStateFile(path: string): Promise<void> {
    const resp = await this.send({ cmd: 'load_state_file', path: DebugServerClient.wirePath(path) });
    if (!resp.ok) throw new Error(resp.error);
  }

  // ===== Registers =====

  /** Read all registers (all categories or specific one) */
  async readRegisters(cpu: CpuTarget = 'ee', category?: number): Promise<any> {
    const cmd: any = { cmd: 'read_registers', cpu };
    if (category !== undefined) cmd.category = category;
    const resp = await this.send(cmd);
    if (!resp.ok) throw new Error(resp.error);
    return resp.data;
  }

  /** Write a 128-bit register */
  async writeRegister(category: number, index: number, value: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'write_register', cpu, category, index, value });
    if (!resp.ok) throw new Error(resp.error);
  }

  /** Set the Program Counter */
  async setPC(value: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'set_pc', cpu, value });
    if (!resp.ok) throw new Error(resp.error);
  }

  // ===== Memory =====

  /** Read memory as hex string */
  async readMemory(address: string, length: number, cpu: CpuTarget = 'ee'): Promise<string> {
    const resp = await this.send({ cmd: 'read_memory', cpu, address, length });
    if (!resp.ok) throw new Error(resp.error);
    return resp.hex;
  }

  /** Read memory as Buffer */
  async readMemoryBuffer(address: string, length: number, cpu: CpuTarget = 'ee'): Promise<Buffer> {
    const hex = await this.readMemory(address, length, cpu);
    return Buffer.from(hex, 'hex');
  }

  /** Write memory from hex string */
  async writeMemory(address: string, data: string, cpu: CpuTarget = 'ee'): Promise<number> {
    const resp = await this.send({ cmd: 'write_memory', cpu, address, data });
    if (!resp.ok) throw new Error(resp.error);
    return resp.written;
  }

  /** Read a null-terminated string */
  async readString(address: string, maxLength = 256, cpu: CpuTarget = 'ee'): Promise<string> {
    const resp = await this.send({ cmd: 'read_string', cpu, address, max_length: maxLength });
    if (!resp.ok) throw new Error(resp.error);
    return resp.string;
  }

  /** Check if an address is valid */
  async isValidAddress(address: string, cpu: CpuTarget = 'ee'): Promise<boolean> {
    const resp = await this.send({ cmd: 'is_valid_address', cpu, address });
    if (!resp.ok) throw new Error(resp.error);
    return resp.valid;
  }

  // ===== Disassembly (NATIVE PCSX2!) =====

  /** Disassemble using PCSX2's own disassembler — perfect output */
  async disassemble(address: string, count = 20, simplify = true, cpu: CpuTarget = 'ee'): Promise<DisasmInstruction[]> {
    const resp = await this.send({ cmd: 'disassemble', cpu, address, count, simplify });
    if (!resp.ok) throw new Error(resp.error);
    return resp.instructions;
  }

  // ===== Expression Evaluation =====

  /** Evaluate a MIPS expression (e.g., "v0 + 0x100", "gp + 0x20") with symbol support */
  async evaluate(expression: string, cpu: CpuTarget = 'ee'): Promise<EvalResult> {
    const resp = await this.send({ cmd: 'evaluate', cpu, expression });
    return resp;
  }

  // ===== Breakpoints =====

  /** Set a breakpoint (optionally with condition expression and description) */
  async setBreakpoint(address: string, options?: { condition?: string; description?: string; temporary?: boolean; cpu?: CpuTarget }): Promise<void> {
    const resp = await this.send({
      cmd: 'set_breakpoint',
      cpu: options?.cpu || 'ee',
      address,
      condition: options?.condition,
      description: options?.description,
      temporary: options?.temporary ?? false,
    });
    if (!resp.ok) throw new Error(resp.error);
  }

  async removeBreakpoint(address: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'remove_breakpoint', cpu, address });
    if (!resp.ok) throw new Error(resp.error);
  }

  async listBreakpoints(cpu: CpuTarget = 'ee'): Promise<BreakpointInfo[]> {
    const resp = await this.send({ cmd: 'list_breakpoints', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.breakpoints;
  }

  // ===== Memory Watchpoints =====

  /** Set a memory watchpoint (read/write/access/onchange) with optional condition */
  async setMemcheck(address: string, end: string, options?: {
    type?: 'read' | 'write' | 'readwrite' | 'onchange';
    action?: 'break' | 'log' | 'both';
    condition?: string;
    description?: string;
    cpu?: CpuTarget;
  }): Promise<void> {
    const resp = await this.send({
      cmd: 'set_memcheck',
      cpu: options?.cpu || 'ee',
      address,
      end,
      type: options?.type || 'write',
      action: options?.action || 'break',
      condition: options?.condition,
      description: options?.description,
    });
    if (!resp.ok) throw new Error(resp.error);
  }

  async removeMemcheck(address: string, end: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'remove_memcheck', cpu, address, end });
    if (!resp.ok) throw new Error(resp.error);
  }

  async listMemchecks(cpu: CpuTarget = 'ee'): Promise<MemcheckInfo[]> {
    const resp = await this.send({ cmd: 'list_memchecks', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.memchecks;
  }

  // ===== Execution Control =====

  async pause(cpu: CpuTarget = 'ee'): Promise<string> {
    const resp = await this.send({ cmd: 'pause', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.pc;
  }

  /** Switch the EE and VU between interpreters and recompilers while the VM runs; the state is kept. */
  async setCpuMode(mode: 'interpreter' | 'recompiler'): Promise<boolean> {
    const resp = await this.send({ cmd: 'set_cpu_mode', mode });
    if (!resp.ok) throw new Error(resp.error);
    return resp.interpreter;
  }

  /** Write `length` bytes of GS local memory from byte `offset` to `path`, after the GS thread drains. */
  async gsRead(path: string, offset = 0, length = 4 * 1024 * 1024): Promise<{ renderer: number; bytes: number }> {
    const resp = await this.send({ cmd: 'gs_read', path: DebugServerClient.wirePath(path), offset, length });
    if (!resp.ok) throw new Error(resp.error);
    return { renderer: resp.renderer, bytes: resp.bytes };
  }

  async resume(cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'resume', cpu });
    if (!resp.ok) throw new Error(resp.error);
  }

  /** Single-step one instruction (delay slot aware) */
  async step(cpu: CpuTarget = 'ee'): Promise<StepResult> {
    const resp = await this.send({ cmd: 'step', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  /** Step over a JAL/JALR — effectively "next" */
  async stepOver(cpu: CpuTarget = 'ee'): Promise<StepResult> {
    const resp = await this.send({ cmd: 'step_over', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  // ===== Thread/Module Info =====

  async getThreads(cpu: CpuTarget = 'ee'): Promise<ThreadInfo[]> {
    const resp = await this.send({ cmd: 'get_threads', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.threads;
  }

  async getModules(cpu: CpuTarget = 'iop'): Promise<Array<{ name: string; version: number }>> {
    const resp = await this.send({ cmd: 'get_modules', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.modules;
  }

  /** Get call stack backtrace using PCSX2's MipsStackWalk */
  async getBacktrace(cpu: CpuTarget = 'ee', maxFrames = 32): Promise<Array<{ entry: string; pc: string; sp: string; stack_size: number; disasm: string }>> {
    const resp = await this.send({ cmd: 'get_backtrace', cpu, max_frames: maxFrames });
    if (!resp.ok) throw new Error(resp.error);
    return resp.frames;
  }

  // ===== Bulk Operations =====

  async clearAllBreakpoints(): Promise<void> {
    const resp = await this.send({ cmd: 'clear_breakpoints' });
    if (!resp.ok) throw new Error(resp.error);
  }
}
