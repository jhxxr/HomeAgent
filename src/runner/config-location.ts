import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../shared/protocol.js';

export const defaultRunnerConfigPath = (home = os.homedir()) => path.join(home, '.homeagent', 'runner.json');
export const runnerConfigLocationPath = (home = os.homedir()) => path.join(home, '.homeagent', 'runner-location.json');

async function exists(filename: string) {
  try { await lstat(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function resolveRunnerConfigPath(
  explicit?: string,
  { home = os.homedir(), cwd = process.cwd() }: { home?: string; cwd?: string } = {},
): Promise<string> {
  if (explicit !== undefined) {
    if (!explicit.trim()) throw new Error('--config requires a file path');
    return path.resolve(cwd, explicit);
  }
  const locationFile = runnerConfigLocationPath(home);
  let saved: string | undefined;
  try { saved = await readFile(locationFile, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (saved !== undefined) {
    let recorded: unknown;
    try { recorded = JSON.parse(saved); } catch { /* Report an actionable error below. */ }
    const filename = recorded && typeof recorded === 'object' && 'config' in recorded ? recorded.config : undefined;
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')) {
      throw new Error(`Saved Runner configuration location is invalid: ${locationFile}. Use --config to select a file explicitly.`);
    }
    if (!(await exists(filename))) throw new Error(`Saved Runner configuration was moved or removed: ${filename}. Use homeagent --config <path> to select a new location.`);
    return filename;
  }
  const standard = defaultRunnerConfigPath(home);
  if (await exists(standard)) return standard;
  throw new AppError('config_not_found', 'No Runner configuration found. Run homeagent to open the interactive setup (or homeagent login for scripts), or specify --config <path>.');
}

/** Remember only the absolute configuration path; credentials remain in stateDir. */
export async function rememberRunnerConfigPath(filename: string, home = os.homedir()) {
  const locationFile = runnerConfigLocationPath(home), directory = path.dirname(locationFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `${randomUUID()}.location.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ config: path.resolve(filename) }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, locationFile);
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}
