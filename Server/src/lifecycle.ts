import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

export interface Host {
  run(file: string, args: string[]): Promise<{ code: number; output: string }>;
  processPath(pid: number): Promise<string | null>;
  terminate(pid: number): Promise<void>;
}

export interface LaunchOptions { bios?: string; elf?: string; state?: string; }

const pidFile = (root: string) => path.join(root, 'Runtime', 'watson.pid');
const emulatorPath = (root: string) => path.join(root, 'References', 'pcsx2', 'build', 'pcsx2-qt', 'Release', 'pcsx2-qt.exe');
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export async function launch(host: Host, root: string, options: LaunchOptions): Promise<number> {
  const args = ['-NoProfile', '-File', path.join(root, 'Emulator', 'Run.ps1')];
  if (options.bios) args.push('-Bios', options.bios);
  if (options.elf) args.push('-Elf', options.elf);
  if (options.state) args.push('-State', options.state);

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

export async function kill(host: Host, root: string): Promise<string> {
  if (!fs.existsSync(pidFile(root))) throw new Error('no Watson emulator was launched from this checkout');
  const pid = Number(fs.readFileSync(pidFile(root), 'utf8').trim());
  const found = await host.processPath(pid);
  if (found === null) {
    fs.rmSync(pidFile(root));
    return `pid ${pid} had already exited`;
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
  async terminate(pid) {
    await execute('pwsh', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`]);
  },
};
