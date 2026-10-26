import { readFile, realpath, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { projectViewSchema } from '../shared/protocol.js';

const projectSchema = projectViewSchema.extend({
  root: z.string().min(1), readOnly: z.boolean().default(false),
  commands: z.array(z.string().min(1).max(512)).max(64).default([]),
  allowGitWrite: z.boolean().default(false),
  commandAliases: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.object({ executable: z.string().min(1).max(4096), args: z.array(z.string().max(8192)).max(256).default([]) }).strict()).refine(value => Object.keys(value).length <= 64, 'At most 64 command aliases per project').default({}),
  environmentProfiles: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.object({ env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32768)).default({}), inherit: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(100).default([]) }).strict()).refine(value => Object.keys(value).length <= 64, 'At most 64 environment profiles per project').default({}),
  gitCommonDir: z.string().min(1).optional().describe('Explicit local opt-in to one linked-worktree common Git directory'),
  deniedNames: z.array(z.string().min(1)).default(['.git', '.env', '.ssh', '.aws', '.homeagent']),
});
export const runnerConfigSchema = z.object({
  server: z.url(),
  name: z.string().min(1).max(128).default(os.hostname()),
  stateDir: z.string().default(path.join(os.homedir(), '.homeagent')),
  projects: z.array(projectSchema).min(1).max(100),
  maxProcesses: z.number().int().min(1).max(64).default(8),
  maxOutputBytes: z.number().int().min(65536).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  maxJobHistory: z.number().int().min(10).max(10000).default(500),
}).strict().refine(config => config.maxJobHistory >= config.maxProcesses, { message: 'maxJobHistory must be at least maxProcesses', path: ['maxJobHistory'] });
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
export async function loadRunnerConfig(filename: string, env = process.env): Promise<RunnerConfig> {
  const input = JSON.parse(await readFile(filename, 'utf8'));
  if (env.HOMEAGENT_SERVER) input.server = env.HOMEAGENT_SERVER;
  // ALLOWED_ROOTS is a JSON array to avoid ambiguity with Windows drive letters.
  if (env.ALLOWED_ROOTS) {
    const roots = z.array(z.string()).min(1).parse(JSON.parse(env.ALLOWED_ROOTS));
    input.projects = roots.map((root, i) => ({ id: `project-${i + 1}`, name: path.basename(root), root }));
  }
  const config = runnerConfigSchema.parse(input);
  const server = new URL(config.server);
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname))) throw new Error('Runner server requires HTTPS except on loopback');
  if (server.username || server.password || server.pathname !== '/' || server.search || server.hash) throw new Error('Runner server must be a plain origin');
  config.server = server.origin;
  const configDirectory = path.dirname(path.resolve(filename));
  const configPaths = [path.resolve(filename), await realpath(filename)];
  config.stateDir = path.resolve(configDirectory, config.stateDir);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  config.stateDir = await realpath(config.stateDir);
  const ids = new Set<string>();
  for (const project of config.projects) {
    project.root = await realpath(path.resolve(configDirectory, project.root));
    if (!(await stat(project.root)).isDirectory()) throw new Error('Project root must be a directory');
    if (inside(project.root, config.stateDir) || inside(config.stateDir, project.root)) throw new Error('Runner stateDir must be separate from all project roots');
    if (configPaths.some(configPath => inside(project.root, configPath))) throw new Error('Runner config must be outside all exposed project roots; it can contain private command arguments or environment values');
    if (ids.has(project.id)) throw new Error('Duplicate project ID');
    if (project.gitCommonDir) project.gitCommonDir = await realpath(path.resolve(configDirectory, project.gitCommonDir));
    ids.add(project.id);
  }
  return config;
}
