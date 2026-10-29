import { readFile, realpath, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { permissionProjectSchema } from '../shared/permissions.js';
import { runnerConfigLocationPath } from './config-location.js';

export const projectConfigSchema = permissionProjectSchema;
export const runnerConfigSchema = z.object({
  server: z.url(),
  name: z.string().min(1).max(128).default(os.hostname()),
  stateDir: z.string().default('state'),
  maxProcesses: z.number().int().min(1).max(64).default(8),
  maxOutputBytes: z.number().int().min(65536).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  maxJobHistory: z.number().int().min(10).max(10000).default(500),
}).strict().refine(config => config.maxJobHistory >= config.maxProcesses, { message: 'maxJobHistory must be at least maxProcesses', path: ['maxJobHistory'] });
export type RunnerConfig = z.infer<typeof runnerConfigSchema> & { projects: ProjectConfig[]; protectedPaths?: string[] };
export type ProjectConfig = z.infer<typeof projectConfigSchema> & { assertAccess?: () => void };
export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
export function parseRunnerSettings(input: unknown) {
  const config = runnerConfigSchema.parse(input);
  const server = new URL(config.server);
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname))) throw new Error('Runner server requires HTTPS except on loopback');
  if (server.username || server.password || server.pathname !== '/' || server.search || server.hash) throw new Error('Runner server must be a plain origin');
  return { ...config, server: server.origin };
}

/** Save connection/runtime settings only; project grants never belong here. */
export async function saveRunnerSettings(filename: string, input: unknown, create = false) {
  const config = parseRunnerSettings(input);
  await mkdir(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(config, null, 2) + '\n';
  if (create) {
    await writeFile(filename, text, { flag: 'wx', mode: 0o600 });
    return;
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

export async function loadRunnerConfig(filename: string, env = process.env): Promise<RunnerConfig> {
  const input = JSON.parse(await readFile(filename, 'utf8'));
  if (env.HOMEAGENT_SERVER) input.server = env.HOMEAGENT_SERVER;
  if (env.ALLOWED_ROOTS) throw new Error('ALLOWED_ROOTS is no longer supported. Configure project directories in the Dashboard.');
  if (Object.hasOwn(input, 'projects') || Object.hasOwn(input, 'allowRemotePermissions')) throw new Error('Local project configuration is no longer supported. Remove projects and allowRemotePermissions from this file; manage projects in the Dashboard.');
  const config = parseRunnerSettings(input);
  const configDirectory = path.dirname(path.resolve(filename));
  const configPaths = [path.resolve(filename), await realpath(filename)];
  config.stateDir = path.resolve(configDirectory, config.stateDir);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  config.stateDir = await realpath(config.stateDir);
  const protectedPaths = [...configPaths, config.stateDir, runnerConfigLocationPath()];
  return Object.assign(config, { projects: [], protectedPaths });
}
