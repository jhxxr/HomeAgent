import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolEnvironment } from '../src/runner/processes.ts';

if (process.platform !== 'win32') throw new Error('Windows diagnostics require Windows.');
const helper = fileURLToPath(new URL('../runtime/windows-process-tree.ps1', import.meta.url));
const encoded = Buffer.from(JSON.stringify(['-e', 'console.log("HOMEAGENT_SUPERVISOR_OK")'])).toString('base64');
const supervised = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', helper, '-Executable', process.execPath, '-ArgumentsBase64', encoded, '-ParentPid', String(process.pid)];
const environment = toolEnvironment();
async function probe(label, args, env) {
  const started = Date.now();
  const child = spawn('powershell.exe', args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', timedOut = false;
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-8192); });
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-8192); });
  child.on('error', error => { output += error.message; });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
  const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
  clearTimeout(timer);
  const result = { label, code, signal, timedOut, durationMs: Date.now() - started, output };
  console.log(JSON.stringify(result));
  return result;
}
const source = fileURLToPath(new URL('../runtime/windows-process-tree.cs', import.meta.url)).replace(/'/g, "''");
const result = await probe('production', supervised, environment);
if (result.code !== 0 || !result.output.includes('HOMEAGENT_SUPERVISOR_OK')) {
  const inspect = `$ErrorActionPreference='Stop';[Console]::WriteLine('VERSION='+$PSVersionTable.PSVersion.ToString());[Console]::WriteLine('BEFORE_IMPORT');Import-Module -Name ([System.IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop;[Console]::WriteLine('AFTER_IMPORT');Add-Type -Path '${source}';[Console]::WriteLine('AFTER_ADD_TYPE');`;
  await probe('module-bootstrap', ['-NoProfile', '-NonInteractive', '-Command', inspect], environment);
  process.exitCode = 1;
}
