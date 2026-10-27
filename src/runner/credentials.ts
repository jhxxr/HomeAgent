import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RunnerConfig } from './config.js';
import { AppError } from '../shared/protocol.js';
import { RunnerLock } from './lock.js';

const exec = promisify(execFile);
const credentialSchema = z.object({ server: z.url(), deviceId: z.string().uuid(), token: z.string().min(32) }).strict();
export type Credential = z.infer<typeof credentialSchema>;
export async function secureStateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const who = (await exec('whoami.exe', [], { windowsHide: true })).stdout.trim();
    await exec('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
  } else await chmod(directory, 0o700);
}
export async function loadCredential(config: RunnerConfig): Promise<Credential> {
  const credential = credentialSchema.parse(JSON.parse(await readFile(path.join(config.stateDir, 'device.json'), 'utf8')));
  if (credential.server !== config.server) throw new AppError('server_changed', 'Credential is pinned to another server; pair again explicitly');
  return credential;
}
async function json(url: string, body: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Pairing failed (${response.status}): ${String(value.error ?? 'unknown')}`);
  return { status: response.status, value };
}
export async function pair(config: RunnerConfig, force = false, log = console.log) {
  await secureStateDirectory(config.stateDir);
  const lock = new RunnerLock(config.stateDir);
  try {
  if (!force) {
    try { await loadCredential(config); throw new AppError('already_paired', 'Already paired. Use pair --force to replace the local credential'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const { value } = await json(`${config.server}/pair/start`, { name: config.name });
  const start = z.object({ id: z.string().uuid(), code: z.string(), pollToken: z.string(), expires: z.number(), verificationUrl: z.url() }).parse(value);
  log(`\n请在已登录 HomeAgent 的浏览器打开下面的链接：\n${start.verificationUrl}\n\n核对设备名称“${config.name}”后批准。备用配对码：${start.code}\n`);
  while (Date.now() < start.expires) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const response = await json(`${config.server}/pair/claim`, { id: start.id, pollToken: start.pollToken });
    if (response.status === 202) continue;
    const credential = credentialSchema.parse({ server: config.server, ...response.value });
    const temporary = path.join(config.stateDir, `${randomUUID()}.credential.tmp`);
    await writeFile(temporary, JSON.stringify(credential), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path.join(config.stateDir, 'device.json'));
    log(`配对完成，设备 ID：${credential.deviceId}`); return credential;
  }
  throw new Error('Pairing code expired; run pair again');
  } finally { lock.close(); }
}
