import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Windows diagnostics require Windows.');
const helper = fileURLToPath(new URL('../runtime/windows-process-tree.ps1', import.meta.url));
const encoded = Buffer.from(JSON.stringify(['-e', 'console.log("HOMEAGENT_SUPERVISOR_OK")'])).toString('base64');
const filtered = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|localappdata|appdata|lang|lc_.*|term)$/i.test(key)));
const supervised = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', helper, '-Executable', process.execPath, '-ArgumentsBase64', encoded, '-ParentPid', String(process.pid)];
async function probe(label, executable, args, env, stdin = 'pipe') {
  const started = Date.now();
  const child = spawn(executable, args, { env, windowsHide: true, stdio: [stdin, 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-8192); });
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-8192); });
  child.on('error', error => { output += error.message; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
  const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
  clearTimeout(timer);
  console.log(JSON.stringify({ label, code, signal, timedOut, durationMs: Date.now() - started, output }));
}
await Promise.all([
  probe('powershell-startup', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::WriteLine("POWERSHELL_OK")'], filtered),
  probe('full-env-pipe', 'powershell.exe', supervised, process.env),
  probe('filtered-env-pipe', 'powershell.exe', supervised, filtered),
  probe('filtered-env-ignore', 'powershell.exe', supervised, filtered, 'ignore'),
  probe('pwsh-filtered-env', 'pwsh.exe', supervised, filtered),
]);
