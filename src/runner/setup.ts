import { access, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runnerConfigSchema, loadRunnerConfig, type RunnerConfig } from './config.js';
import { pair } from './credentials.js';

export interface LoginOptions {
  config?: string;
  server?: string;
  name?: string;
  projects?: string[];
  force?: boolean;
}

const defaultConfig = () => path.join(os.homedir(), '.homeagent', 'runner.json');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function exists(filename: string) {
  try { await access(filename); return true; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}

async function question(rl: Interface, label: string, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || fallback;
}

function projectId(root: string, used: Set<string>) {
  const base = (path.basename(root) || 'workspace').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  let value = base.slice(0, 64), suffix = 2;
  while (used.has(value)) {
    const tail = `-${suffix++}`;
    value = `${base.slice(0, 64 - tail.length)}${tail}`;
  }
  return value;
}

async function createConfig(filename: string, options: LoginOptions, rl: Interface) {
  const server = await question(rl, 'HomeAgent Web URL', options.server ?? 'http://localhost:3210');
  const name = await question(rl, '设备名称', options.name ?? os.hostname());
  const projectRoots = options.projects?.length
    ? options.projects
    : [await question(rl, '首个项目目录', process.cwd())];
  if (!server) throw new Error('HomeAgent Web URL 不能为空');
  if (!name) throw new Error('设备名称不能为空');
  if (projectRoots.some(root => !root)) throw new Error('项目目录不能为空');

  const used = new Set<string>();
  const projects = [];
  for (const value of projectRoots) {
    const root = path.resolve(value);
    if (!(await stat(root)).isDirectory()) throw new Error(`项目目录不存在或不是目录：${root}`);
    const id = projectId(root, used);
    used.add(id);
    projects.push({
      id, name: path.basename(root) || id, root, readOnly: false, commands: [],
      commandAliases: {}, environmentProfiles: {}, allowGitWrite: false,
      deniedNames: ['.git', '.env', '.ssh', '.aws', '.homeagent'],
    });
  }
  const value = runnerConfigSchema.parse({
    server, name, stateDir: path.join(path.dirname(filename), 'state'), projects,
    maxProcesses: 8, maxOutputBytes: 8388608, maxJobHistory: 500, allowRemotePermissions: true,
  });
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { return await loadRunnerConfig(filename); }
  catch (error) {
    await unlink(filename).catch(cleanupError => { if (!isMissing(cleanupError)) throw cleanupError; });
    throw error;
  }
}

export async function interactiveLogin(options: LoginOptions, log = console.log): Promise<{ filename: string; config: RunnerConfig }> {
  const filename = path.resolve(options.config ?? defaultConfig());
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  let config: RunnerConfig;
  if (await exists(filename)) {
    config = await loadRunnerConfig(filename);
    log(`使用现有 Runner 配置：${filename}`);
  } else {
    const rl = createInterface({ input, output });
    try {
      config = await createConfig(filename, options, rl);
      log(`已生成 Runner 配置：${filename}`);
    } finally {
      rl.close();
    }
  }
  await pair(config, options.force, log);
  log(`登录完成。配置文件：${filename}`);
  return { filename, config: await loadRunnerConfig(filename) };
}
