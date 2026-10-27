import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function spawnOwnedProcess(executable: string, args: string[], options: SpawnOptionsWithoutStdio) {
  if (process.platform !== 'win32') return spawn(executable, args, { ...options, detached: true, stdio: 'pipe' });
  const helper = fileURLToPath(new URL('../../runtime/windows-process-tree.ps1', import.meta.url));
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', helper, '-Executable', executable, '-ArgumentsBase64', Buffer.from(JSON.stringify(args)).toString('base64'), '-ParentPid', String(process.pid)], { ...options, windowsHide: true, stdio: 'pipe' });
}
export async function stopOwnedProcess(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', reject); killer.once('close', () => resolve());
  });
}
