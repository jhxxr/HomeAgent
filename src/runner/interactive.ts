import os from 'node:os';
import path from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareAssist } from './assist.js';
import { Agent } from './agent.js';
import { loadRunnerConfig, parseRunnerSettings, saveRunnerSettings, type RunnerConfig } from './config.js';
import { defaultRunnerConfigPath, rememberRunnerConfigPath, resolveRunnerConfigPath } from './config-location.js';
import { loadCredential, pair, secureStateDirectory, type Credential } from './credentials.js';
import { service } from './service.js';
import { RunnerLock } from './lock.js';
import { RunnerTui, TuiCancelError, TuiExitError, type RunnerState } from './tui.js';
import { AppError, VERSION } from '../shared/protocol.js';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const exec = promisify(execFile);

export async function openRunnerWeb(url: string) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('无效的网页地址');
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href]] as const
    : process.platform === 'darwin' ? ['open', [parsed.href]] as const : ['xdg-open', [parsed.href]] as const;
  await exec(command, [...args], { windowsHide: true, timeout: 10000 });
}

export interface InteractiveOptions {
  config?: string;
  server?: string;
  name?: string;
  login?: boolean;
  force?: boolean;
}
type InteractiveUi = Pick<RunnerTui, 'start' | 'stop' | 'setState' | 'updateInfo' | 'log' | 'select' | 'ask' | 'waitForAction' | 'showProgress' | 'progress' | 'requestExit' | 'activity'>;
interface RunningAgent { start(): void; close(): Promise<void> }
export interface InteractiveDependencies {
  home?: string;
  ui?: InteractiveUi;
  createAgent?: (config: RunnerConfig, credential: Credential, log: (text: string) => void, onState: (state: RunnerState, detail?: string) => void) => RunningAgent;
  pair?: typeof pair;
  service?: typeof service;
  openWeb?: typeof openRunnerWeb;
  secureState?: typeof secureStateDirectory;
}

/** One session owns the terminal, login flow, and at most one live Runner. */
export async function runInteractiveApplication(options: InteractiveOptions = {}, dependencies: InteractiveDependencies = {}) {
  const home = dependencies.home ?? os.homedir();
  let filename = options.config ? path.resolve(options.config) : defaultRunnerConfigPath(home);
  let config: RunnerConfig | undefined;
  let credential: Credential | undefined;
  let configError: string | undefined;
  let agent: RunningAgent | undefined;
  let running = false;
  let connectionGeneration = 0;
  const ui = dependencies.ui ?? new RunnerTui({
    version: VERSION, node: process.version, platform: process.platform, arch: process.arch,
    device: options.name ?? os.hostname(), server: '尚未设置服务地址', config: filename,
  }, { interactive: true, keepOpenOnStop: true });
  const createAgent = dependencies.createAgent ?? ((settings, identity, log, state) => new Agent(settings, identity, log, state));
  const pairDevice = dependencies.pair ?? pair;
  const manageService = dependencies.service ?? service;
  const openWeb = dependencies.openWeb ?? openRunnerWeb;
  const secureState = dependencies.secureState ?? secureStateDirectory;
  const notice = (title: string, description: string[]) => ui.select(title, [{ value: 'back', label: '返回' }], description);
  const confirm = async (title: string, description: string[], label = '确认') =>
    await ui.select(title, [{ value: 'back', label: '取消' }, { value: 'confirm', label }], description) === 'confirm';
  const remember = () => rememberRunnerConfigPath(filename, home).catch(() => ui.log('无法记录配置位置；可在设置中选择配置文件。'));
  const syncInfo = () => {
    ui.updateInfo({ config: filename, device: config?.name ?? options.name ?? os.hostname(), server: config?.server ?? '尚未设置服务地址' });
    ui.setState(credential ? 'stopped' : 'unpaired');
  };
  const load = async () => {
    config = undefined; credential = undefined; configError = undefined;
    try { config = await loadRunnerConfig(filename); }
    catch (error) { if (!missing(error)) configError = message(error); }
    if (config) {
      try { credential = await loadCredential(config); }
      catch (error) { if (!missing(error)) ui.log(`登录凭据不可用：${message(error)}`); }
    }
    syncInfo();
  };
  const stopRunner = async () => {
    const previous = agent;
    agent = undefined; running = false;
    connectionGeneration++;
    await previous?.close();
    if (previous) ui.setState(credential ? 'stopped' : 'unpaired');
  };
  const startRunner = async () => {
    if (!config || !credential || agent) return;
    await secureState(config.stateDir);
    const generation = ++connectionGeneration;
    agent = createAgent(config, credential, text => {
      if (generation === connectionGeneration) ui.log(text);
    }, (state, detail) => {
      if (generation !== connectionGeneration) return;
      if (state === 'stopped') running = false;
      ui.setState(state, detail);
    });
    running = true;
    try { agent.start(); await remember(); }
    catch (error) { await stopRunner(); throw error; }
  };
  const chooseConfig = async () => {
    const selected = await ui.ask('选择配置文件', filename, ['输入配置文件的完整路径。新路径会通过登录流程创建。'], value => value ? undefined : '请输入文件路径');
    if (selected === undefined) return;
    const next = path.resolve(selected);
    try { await loadRunnerConfig(next); } catch (error) { if (!missing(error)) throw error; }
    await stopRunner();
    filename = next;
    await load();
    if (credential) await startRunner();
  };
  const login = async () => {
    if (configError) {
      await notice('配置需要处理', [configError, '按返回后，在设置中选择有效的配置文件；现有文件不会被覆盖。']);
      return;
    }
    const server = await ui.ask('登录 · 服务地址', options.server ?? config?.server ?? 'http://localhost:3210', [
      '填写你的 HomeAgent 网页地址，例如 https://homeagent.example.com',
    ], value => {
      try { parseRunnerSettings({ server: value }); return undefined; }
      catch { return '请输入 HTTPS 服务地址；本机 localhost / 127.0.0.1 可使用 HTTP。'; }
    });
    if (server === undefined) return;
    const name = await ui.ask('登录 · 设备名称', options.name ?? config?.name ?? os.hostname(), [
      '这个名称会显示在网页控制台，方便识别当前机器。',
    ], value => value.length > 0 && value.length <= 128 ? undefined : '请输入 1–128 个字符的设备名称');
    if (name === undefined) return;
    const normalized = parseRunnerSettings({ server, name });
    const changedServer = config && normalized.server !== config.server;
    const stateDir = changedServer
      ? path.join(path.dirname(filename), `state-${createHash('sha256').update(normalized.server).digest('hex').slice(0, 12)}`)
      : config?.stateDir ?? path.join(path.dirname(filename), 'state');
    let replacesCredential = false;
    try { await readFile(path.join(stateDir, 'device.json')); replacesCredential = true; } catch (error) { if (!missing(error)) throw error; }
    if ((replacesCredential || changedServer) && !await confirm('确认重新登录', [
      changedServer ? '将切换服务，并为该服务使用独立的设备凭据目录。' : '将替换当前设备的本地登录凭据。',
      '旧服务或旧设备记录不会自动撤销，可在对应网页中撤销。',
      '重新登录会停止当前连接及其托管任务。',
    ], '继续登录')) return;
    const wasRunning = running;
    await stopRunner();
    const settings = parseRunnerSettings({
      server: normalized.server, name, stateDir,
      maxProcesses: config?.maxProcesses ?? 8, maxOutputBytes: config?.maxOutputBytes ?? 8388608, maxJobHistory: config?.maxJobHistory ?? 500,
    });
    // Creating a fresh connection file is intentional here, after form validation.
    if (!config) {
      await saveRunnerSettings(filename, settings, true);
      config = await loadRunnerConfig(filename);
    }
    const pendingConfig: RunnerConfig = { ...settings, projects: [] };
    let verificationUrl: string | undefined;
    try {
      await ui.progress('登录设备', ['正在向服务申请登录链接…'], signal => pairDevice(pendingConfig, replacesCredential, text => ui.log(text), {
        signal,
        onPairing: prompt => {
          verificationUrl = prompt.verificationUrl;
          ui.showProgress('等待浏览器批准', [
            `设备：${name}`, '按 o 打开登录页面，在网页中确认设备和项目权限。',
            prompt.verificationUrl, `备用配对码：${prompt.code}`,
            `有效期至 ${new Date(prompt.expires).toLocaleTimeString()}`, '完成批准后会自动连接，无需再输入命令。',
          ]);
        },
      }), async () => {
        if (!verificationUrl) throw new Error('正在获取登录链接，请稍后再试');
        await openWeb(verificationUrl);
      });
      await saveRunnerSettings(filename, settings);
      await load();
      await remember();
      await startRunner();
    } catch (error) {
      // A canceled pairing leaves an existing device available to reconnect.
      await load();
      if (wasRunning && credential && !(error instanceof TuiExitError)) await startRunner();
      throw error;
    }
  };
  const editSetting = async (field: 'name' | 'maxProcesses' | 'maxOutputBytes' | 'maxJobHistory') => {
    if (!config) return;
    const settings = parseRunnerSettings(JSON.parse(await readFile(filename, 'utf8')));
    const titles = { name: '设备名称', maxProcesses: '最大并发进程数', maxOutputBytes: '每个任务的输出上限（MiB）', maxJobHistory: '保留的任务记录数' };
    const current = field === 'maxOutputBytes' ? String(settings[field] / 1048576) : String(settings[field]);
    const parse = (value: string) => parseRunnerSettings({
      ...settings, [field]: field === 'name' ? value : Number(value) * (field === 'maxOutputBytes' ? 1048576 : 1),
    });
    const answer = await ui.ask(titles[field], current, [
      field === 'name' ? '用于识别当前设备。' : '并发 1–64；输出 0.0625–64 MiB；记录 10–10000，且不少于并发数。',
    ], value => { try { parse(value); return undefined; } catch { return field === 'name' ? '设备名称需要 1–128 个字符。' : '数值超出范围，或任务记录数小于并发数，请重新输入。'; } });
    if (answer === undefined) return;
    if (running && !await confirm('保存并重新连接', ['修改运行设置需要短暂断线，并停止当前托管任务。'], '保存并重连')) return;
    const wasRunning = running;
    await stopRunner();
    try { await saveRunnerSettings(filename, parse(answer)); await load(); }
    finally { if (wasRunning && credential) await startRunner(); }
    ui.log('设置已保存。');
  };
  const settings = async () => {
    while (true) {
      const selected = await ui.select('设置', [
        ...(config ? [
          { value: 'name', label: `设备名称  ${config.name}` },
          { value: 'maxProcesses', label: `并发进程  ${config.maxProcesses}` },
          { value: 'maxOutputBytes', label: `任务输出上限  ${config.maxOutputBytes / 1048576} MiB` },
          { value: 'maxJobHistory', label: `任务历史  ${config.maxJobHistory} 条` },
        ] : []),
        { value: 'assist', label: '加入远程协助 · 本机临时授权' },
        { value: 'login', label: credential ? '重新登录 / 切换服务' : '登录并配置服务' },
        { value: 'config', label: '选择配置文件', detail: filename },
        ...(config ? [
          { value: 'service-install', label: '启用自启动', detail: '确认后由后台 Runner 接管连接。' },
          { value: 'service-uninstall', label: '关闭自启动' },
        ] : []),
        ...(credential ? [{ value: 'logout', label: '退出登录' }] : []),
        { value: 'back', label: '返回总览' },
      ], [configError ?? (config ? `服务：${config.server}` : '尚未配置设备。登录后即可开始使用。'), '项目目录和访问权限可通过总览的网页入口管理。']);
      if (!selected || selected === 'back') return;
      if (selected === 'assist') {
        const link = await ui.ask('粘贴远程协助邀请链接', '', ['链接只用于接入，本机选择并批准后才开放项目。']);
        if (!link) continue;
        if (running && !await confirm('切换到临时远程协助', ['当前界面的普通连接及托管任务将停止，配置和凭据保持不变。'])) continue;
        await stopRunner();
        const prepared = await prepareAssist(link, ui, home);
        if (!prepared) { syncInfo(); continue; }
        const assistAgent = new Agent(prepared.config, prepared.credential, text => ui.log(text), (state, detail) => ui.setState(state, detail), prepared.consent);
        agent = assistAgent; running = true;
        ui.updateInfo({ server: prepared.config.server, config: '远程协助 · 临时本机授权' }); assistAgent.start();
        try {
          while (true) {
            const choice = await ui.select('远程协助 · 本机控制', [{ value: 'stop', label: '立即停止 / 重试任务清理' }, { value: 'activity', label: '查看活动与任务' }, { value: 'back', label: '结束并返回' }], [`到期：${new Date(prepared.consent.snapshot().expiresAt).toLocaleString()}`, '断线即结束；不能自动恢复或由 Server 延长。']);
            if (choice === 'activity') { for (const job of assistAgent.tools.processes.snapshot()) ui.log(`${job.id.slice(0, 8)} · ${job.executable} · ${job.state}`); await ui.activity(); continue; }
            await assistAgent.stopAssist('local_stop');
            if (choice !== 'stop') break;
          }
        } finally { await stopRunner(); syncInfo(); }
        continue;
      }
      if (selected === 'login') { await login(); continue; }
      if (selected === 'config') { await chooseConfig(); continue; }
      if (selected === 'logout' && config) {
        if (!await confirm('退出登录', ['将停止当前连接并删除本地凭据；网页上的设备记录不会自动撤销。'], '退出登录')) continue;
        await stopRunner();
        const lock = new RunnerLock(config.stateDir);
        try { await unlink(path.join(config.stateDir, 'device.json')); } finally { lock.close(); }
        credential = undefined; ui.setState('unpaired'); return;
      }
      if ((selected === 'service-install' || selected === 'service-uninstall') && config) {
        if (selected === 'service-install' && !credential) { await notice('请先登录', ['完成登录后才能启用自启动。']); continue; }
        const uninstall = selected === 'service-uninstall';
        if (!await confirm(uninstall ? '关闭自启动' : '启用自启动', [
          uninstall ? '将停止并移除这份配置对应的后台启动任务。' : '将停止前台连接并由后台 Runner 接管；关闭本界面后仍可运行。',
        ], uninstall ? '关闭自启动' : '启用自启动')) continue;
        await stopRunner();
        await ui.progress('更新自启动设置', ['正在更新系统启动任务，请稍候…'], () =>
          manageService(config!, filename, uninstall, text => ui.log(text)), undefined, false);
        ui.setState('stopped');
        await notice('自启动设置已更新', [uninstall ? '自启动已关闭，可返回总览后按 p 连接。' : '后台启动任务已启用，可以安全退出本界面。']);
        continue;
      }
      await editSetting(selected as 'name' | 'maxProcesses' | 'maxOutputBytes' | 'maxJobHistory');
    }
  };

  const exit = () => ui.requestExit();
  ui.setState('unpaired');
  ui.start();
  process.on('SIGINT', exit); process.on('SIGTERM', exit);
  try {
    try { filename = await resolveRunnerConfigPath(options.config, { home }); }
    catch (error) {
      if (!(error instanceof AppError && error.code === 'config_not_found')) {
        configError = message(error);
        ui.log(configError);
      }
    }
    if (!configError) await load();
    else syncInfo();
    if (credential && !options.login) {
      try { await startRunner(); } catch (error) { ui.setState('stopped'); await notice('暂时无法连接', [message(error), '可在设置中关闭已有自启动，或稍后重试。']); }
    }
    let action = options.login ? 'login' : await ui.waitForAction();
    while (action !== 'quit') {
      try {
        if (action === 'settings') await settings();
        else if (action === 'config') await chooseConfig();
        else if (action === 'login') await login();
        else if (action === 'web') {
          if (config) await openWeb(new URL('/', config.server).href);
          else await notice('尚未设置服务地址', ['先按 Enter 登录设备，即可配置服务地址。']);
        } else if (action === 'toggle') {
          if (!credential) await login();
          else if (running) { await stopRunner(); ui.setState('stopped'); }
          else { await stopRunner(); await startRunner(); }
        } else if (action === 'activity') {
          await ui.activity();
        } else if (action === 'help') {
          await notice('快捷键', ['Enter / s：设置　a：活动　o：打开网页', 'p：暂停或恢复连接　c：选择配置文件', 'l：登录或切换服务　q / Ctrl+C：退出']);
        }
      } catch (error) {
        if (error instanceof TuiExitError) throw error;
        if (error instanceof TuiCancelError) ui.log('操作已取消。');
        else await notice('操作未完成', [message(error), '可以返回后重试，或在设置中调整配置。']);
      }
      action = await ui.waitForAction();
    }
  } catch (error) {
    if (!(error instanceof TuiExitError)) throw error;
  } finally {
    process.off('SIGINT', exit); process.off('SIGTERM', exit);
    try { await stopRunner(); } finally { ui.stop(); }
  }
}
