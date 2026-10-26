import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolEnvironment } from '../src/runner/processes.ts';

if (process.platform !== 'win32') throw new Error('Windows diagnostics require Windows.');
const helper = fileURLToPath(new URL('../runtime/windows-process-tree.ps1', import.meta.url));
const encoded = Buffer.from(JSON.stringify(['-e', 'console.log("HOMEAGENT_SUPERVISOR_OK")'])).toString('base64');
const supervised = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', helper, '-Executable', process.execPath, '-ArgumentsBase64', encoded, '-ParentPid', String(process.pid)];
const started = Date.now();
const child = spawn('powershell.exe', supervised, { env: toolEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '', timedOut = false;
child.stdout.on('data', bytes => { output = (output + bytes).slice(-8192); });
child.stderr.on('data', bytes => { output = (output + bytes).slice(-8192); });
child.on('error', error => { output += error.message; });
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
clearTimeout(timer);
console.log(JSON.stringify({ code, signal, timedOut, durationMs: Date.now() - started, output }));
if (code !== 0 || !output.includes('HOMEAGENT_SUPERVISOR_OK')) process.exitCode = 1;
