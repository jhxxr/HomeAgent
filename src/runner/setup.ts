import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runnerConfigSchema, loadRunnerConfig, type RunnerConfig } from './config.js';
import { pair } from './credentials.js';
import { defaultRunnerConfigPath, rememberRunnerConfigPath, resolveRunnerConfigPath } from './config-location.js';
import { AppError } from '../shared/protocol.js';

export interface LoginOptions {
  config?: string;
  server?: string;
  name?: string;
  force?: boolean;
}

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

async function createConfig(filename: string, options: LoginOptions, rl: Interface) {
  const server = options.server ?? await question(rl, 'HomeAgent Web URL', 'http://localhost:3210');
  const name = options.name ?? await question(rl, '设备名称', os.hostname());
  if (!server) throw new Error('HomeAgent Web URL 不能为空');
  if (!name) throw new Error('设备名称不能为空');
  const value = runnerConfigSchema.parse({
    server, name, stateDir: path.join(path.dirname(filename), 'state'),
    maxProcesses: 8, maxOutputBytes: 8388608, maxJobHistory: 500,
  });
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { return await loadRunnerConfig(filename); }
  catch (error) {
    await unlink(filename).catch(cleanupError => { if (!isMissing(cleanupError)) throw cleanupError; });
    throw error;
  }
}

export async function interactiveLogin(options: LoginOptions, log = console.log): Promise<{ filename: string; config: RunnerConfig }> {
  const filename = options.config !== undefined
    ? await resolveRunnerConfigPath(options.config)
    : await resolveRunnerConfigPath().catch(error => {
      if (error instanceof AppError && error.code === 'config_not_found') return defaultRunnerConfigPath();
      throw error;
    });
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
  await rememberRunnerConfigPath(filename).catch(() => log('无法记录配置位置，下次启动请通过 --config 指定路径。'));
  log(`登录完成。配置文件：${filename}`);
  log('项目目录和权限由 Server 保存；请在网页中配置。');
  log('运行 homeagent 进入交互界面；安装自启动可使用 homeagent service-install。');
  return { filename, config: await loadRunnerConfig(filename) };
}
