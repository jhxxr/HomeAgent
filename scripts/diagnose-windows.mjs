import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Windows diagnostics require Windows.');
const helper = fileURLToPath(new URL('../runtime/windows-process-tree.ps1', import.meta.url));
const encoded = Buffer.from(JSON.stringify(['-e', 'console.log("HOMEAGENT_SUPERVISOR_OK")'])).toString('base64');
const filtered = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|localappdata|appdata|lang|lc_.*|term)$/i.test(key)));
const withKeys = pattern => ({ ...filtered, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => pattern.test(key))) });
const supervised = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', helper, '-Executable', process.execPath, '-ArgumentsBase64', encoded, '-ParentPid', String(process.pid)];
async function probe(label, executable, args, env, stdin = 'pipe') {
  const started = Date.now();
  const child = spawn(executable, args, { env, windowsHide: true, stdio: [stdin, 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-8192); });
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-8192); });
  child.on('error', error => { output += error.message; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
  const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
  clearTimeout(timer);
  const result = { label, code, signal, timedOut, durationMs: Date.now() - started, output };
  console.log(JSON.stringify(result));
  return result;
}
const results = await Promise.all([
  probe('powershell-startup', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::WriteLine("POWERSHELL_OK")'], filtered),
  probe('full-env-pipe', 'powershell.exe', supervised, process.env),
  probe('filtered-env-pipe', 'powershell.exe', supervised, filtered),
  probe('filtered-env-ignore', 'powershell.exe', supervised, filtered, 'ignore'),
  probe('pwsh-filtered-env', 'pwsh.exe', supervised, filtered),
  probe('module-path-env', 'powershell.exe', supervised, withKeys(/^PSModulePath$/i)),
  probe('windows-directories-env', 'powershell.exe', supervised, withKeys(/^(ProgramFiles(?:\(x86\))?|CommonProgramFiles(?:\(x86\))?|ProgramW6432|CommonProgramW6432|ProgramData|ALLUSERSPROFILE|SystemDrive)$/i)),
  probe('identity-cpu-env', 'powershell.exe', supervised, withKeys(/^(HOMEDRIVE|HOMEPATH|USERNAME|USERDOMAIN|COMPUTERNAME|NUMBER_OF_PROCESSORS|PROCESSOR_.*)$/i)),
]);
if (!results.some(result => result.label === 'filtered-env-pipe' && result.code === 0 && result.output.includes('HOMEAGENT_SUPERVISOR_OK'))) process.exitCode = 1;
