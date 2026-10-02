import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

export interface Host {
  run(file: string, args: string[]): Promise<{ code: number; output: string }>;
  processPath(pid: number): Promise<string | null>;
  isRunning(pid: number): Promise<boolean>;
  terminate(pid: number): Promise<void>;
}

export interface LaunchOptions { bios?: string; elf?: string; state?: string; interpreter?: boolean; visible?: boolean; gameArgs?: string; }

const pidFile = (root: string) => path.join(root, 'Runtime', 'watson.pid');
const emulatorPath = (root: string) => path.join(root, 'References', 'pcsx2', 'build', 'pcsx2-qt', 'Release', 'pcsx2-qt.exe');
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export async function launch(host: Host, root: string, options: LaunchOptions): Promise<number> {
  const args = ['-NoProfile', '-File', path.join(root, 'Emulator', 'Run.ps1')];
  if (options.bios) args.push('-Bios', options.bios);
  if (options.elf) args.push('-Elf', options.elf);
  if (options.state) args.push('-State', options.state);
  if (options.interpreter) args.push('-Interpreter');
  if (options.visible) args.push('-Visible');
  if (options.gameArgs) args.push('-GameArgs', options.gameArgs);

  const { code, output } = await host.run('pwsh', args);
  const started = /pcsx2 pid (\d+)/.exec(output);
  if (code !== 0 || !started) {
    const reason = /Run\.ps1: (.+)/.exec(output);
    throw new Error(reason ? reason[1].trim() : `Run.ps1 exited ${code}: ${output.trim()}`);
  }
  const pid = Number(started[1]);
  fs.mkdirSync(path.dirname(pidFile(root)), { recursive: true });
  fs.writeFileSync(pidFile(root), String(pid));
  return pid;
}

export interface Probe { (): Promise<{ alive: boolean; frame: number }>; }
export interface StatusSource {
  isConnected(): boolean;
  disconnect(): void;
  getStatus(): Promise<{ alive: boolean; frame: number }>;
}

/**
 * A probe that holds one connection and asks it again on each poll. The DebugServer serves a
 * single client, so opening a new connection per poll while an earlier one is still up would be
 * refused every time.
 */
export function reusingProbe<T extends StatusSource>(open: () => Promise<T>): { probe: Probe; current: () => T | null } {
  let held: T | null = null;
  const probe = async () => {
    if (!held || !held.isConnected()) held = await open();
    try {
      return await held.getStatus();
    } catch (error) {
      held.disconnect();
      held = null;
      throw error;
    }
  };
  return { probe, current: () => held };
}

export interface WaitOptions { timeoutMs: number; intervalMs: number; logTail: () => string; }

/**
 * Launch, then wait until the DebugServer answers, and until a VM is alive when something was
 * asked to boot. An emulator that never becomes usable is killed here: left running it would
 * hold the debug port, and the next launch would start a second one that kill cannot reach.
 */
export async function launchAndWait(host: Host, root: string, options: LaunchOptions, probe: Probe, wait: WaitOptions): Promise<{ pid: number; alive: boolean; frame: number }> {
  const pid = await launch(host, root, options);
  const expectVm = Boolean(options.bios || options.elf || options.state);
  const deadline = Date.now() + wait.timeoutMs;
  const log = () => { const tail = wait.logTail().trim(); return tail ? `\nPCSX2 log:\n${tail}` : ''; };
  let last = 'never tried';

  while (Date.now() < deadline) {
    if (!(await host.isRunning(pid))) {
      fs.rmSync(pidFile(root), { force: true });
      throw new Error(`pid ${pid} exited before the DebugServer answered (last: ${last})${log()}`);
    }
    try {
      const status = await probe();
      if (!expectVm || status.alive) return { pid, alive: status.alive, frame: status.frame };
      last = 'the DebugServer answers but the VM has not booted yet';
    } catch (error: any) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, wait.intervalMs));
  }

  await host.terminate(pid);
  fs.rmSync(pidFile(root), { force: true });
  throw new Error(`pid ${pid} never became usable within ${wait.timeoutMs} ms and was terminated (last: ${last})${log()}`);
}

export async function kill(host: Host, root: string): Promise<string> {
  if (!fs.existsSync(pidFile(root))) throw new Error('no Watson emulator was launched from this checkout');
  const pid = Number(fs.readFileSync(pidFile(root), 'utf8').trim());
  if (!(await host.isRunning(pid))) {
    fs.rmSync(pidFile(root));
    return `pid ${pid} had already exited`;
  }
  const found = await host.processPath(pid);
  if (found === null) {
    throw new Error(`pid ${pid} is running but its executable could not be read; not killing it`);
  }
  if (!same(found, emulatorPath(root))) {
    throw new Error(`pid ${pid} now belongs to ${found}, not the Watson emulator; not killing it`);
  }
  await host.terminate(pid);
  fs.rmSync(pidFile(root));
  return `terminated pid ${pid}`;
}

function execute(file: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

export const systemHost: Host = {
  run: execute,
  async processPath(pid) {
    const { output } = await execute('pwsh', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`]);
    const found = output.trim();
    return found.length > 0 ? found : null;
  },
  // Signal 0 only asks whether the process exists. A just-started process can report no
  // executable path for a moment, so the path is not used to decide whether it is alive.
  async isRunning(pid) {
    try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; }
  },
  async terminate(pid) {
    await execute('pwsh', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`]);
  },
};
