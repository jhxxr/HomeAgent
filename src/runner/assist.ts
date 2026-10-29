import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { ASSIST_MULTI_FEATURE, assistInviteViewSchema, assistMultiDescriptorSchema, approvedProjects, type AssistApprovedProject, type AssistMultiApproval } from '../shared/assist.js';
import { AppError, VERSION } from '../shared/protocol.js';
import { parseRunnerSettings, type RunnerConfig } from './config.js';
import { secureStateDirectory } from './credentials.js';
import { resolveRunnerConfigPath } from './config-location.js';
import { AssistConsent } from './assist-consent.js';
import { Agent } from './agent.js';
import { RunnerTui, TuiCancelError, TuiExitError, type TuiChoice } from './tui.js';

export function parseAssistLink(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new AppError('invalid_invite', 'Paste a complete HomeAgent invitation link'); }
  parseRunnerSettings({ server: url.origin });
  const values = new URLSearchParams(url.hash.slice(1));
  if (url.username || url.password || url.pathname !== '/assist' || url.search || !z.string().uuid().safeParse(values.get('id')).success || !values.get('token') || values.get('token')!.length > 128) throw new AppError('invalid_invite', 'Invalid assistance invitation link');
  return { server: url.origin, id: values.get('id')!, token: values.get('token')! };
}
async function post(server: string, route: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(server + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), redirect: 'error' });
  if (route.startsWith('/assist/v2/') && [404, 405].includes(response.status)) throw new AppError('assist_upgrade', '此 Server 不支持多项目协助，请先升级 Server；不会降级或仅共享首个项目。');
  if (!response.ok) throw new AppError('assist_connection', `Assistance request rejected (${response.status})`);
  return response.json();
}
export interface AssistUi {
  ask(title: string, fallback?: string, description?: string[], validate?: (value: string) => string | undefined): Promise<string | undefined>;
  select(title: string, choices: TuiChoice[], description?: string[]): Promise<string | undefined>;
  log(text: string): void;
  progress?<T>(title: string, description: string[], run: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
const safe = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, '');
async function chooseProject(ui: AssistUi, scopesAllowed: AssistApprovedProject['scopes'], id: string, previous?: AssistApprovedProject): Promise<AssistApprovedProject | undefined> {
  const root = await ui.ask('允许访问的本机项目', previous?.root ?? '', ['输入本机已有项目的绝对路径，必须排除 Runner 配置和凭据目录。'], value => path.isAbsolute(value) && !/[\p{Cc}\p{Cf}]/u.test(value) ? undefined : '请输入普通绝对目录路径');
  if (!root) return;
  const name = await ui.ask('项目名称', previous?.name ?? (path.basename(root) || id), ['名称仅用于标识本次共享项目。'], value => value.length >= 1 && value.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(value) ? undefined : '请输入 1–128 字符的项目名称');
  if (!name) return;
  const scopes: AssistApprovedProject['scopes'] = ['read'];
  if (scopesAllowed.includes('write')) {
    const selected = await ui.select('文件写入权限', [{ value: 'read', label: '只读查看（默认）' }, { value: 'write', label: '允许编辑、创建、移动和删除项目文件' }], [`项目：${safe(name)}`, '文件修改可能触发项目的热加载或其他自动运行服务。']);
    if (!selected) return;
    if (selected === 'write') scopes.push('write');
  }
  const commands: string[] = [];
  if (scopesAllowed.includes('execute')) {
    const selected = await ui.select('运行程序与测试 · 高风险', [{ value: 'none', label: '禁止程序执行（默认）' }, { value: 'execute', label: '本机选择允许的程序' }], [`项目：${safe(name)}`, '允许的程序及其参数拥有 Runner 系统账户权限。', '解释器和构建工具可以访问项目外文件和网络；这不是沙箱。']);
    if (!selected) return;
    if (selected === 'execute') {
      scopes.push('execute');
      while (commands.length < 16) {
        const program = await ui.ask('允许的程序绝对路径', previous?.commands[commands.length] ?? '', ['选择一个可信可执行文件；禁止 .cmd/.bat 包装，参数仍由 AI 指定。'], value => path.isAbsolute(value) && value.length <= 512 ? undefined : '请输入不超过 512 字符的程序绝对路径');
        if (!program) return;
        commands.push(program);
        const action = await ui.select('程序允许列表', [{ value: 'done', label: '完成程序选择' }, { value: 'add', label: '再添加一个程序' }]);
        if (!action) return;
        if (action !== 'add') break;
      }
    }
  }
  return { id, name, root, scopes, commands };
}
async function assistConfig(server: string, home: string): Promise<RunnerConfig> {
  const base = path.join(home, '.homeagent', 'assist');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(await mkdtemp(path.join(base, 'session-')));
  await secureStateDirectory(stateDir);
  const protectedPaths = [path.join(home, '.homeagent')];
  try {
    const filename = await resolveRunnerConfigPath(undefined, { home });
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    protectedPaths.push(filename, await realpath(filename), path.resolve(path.dirname(filename), saved.stateDir ?? 'state'));
  } catch (error) { if (!(error instanceof AppError && error.code === 'config_not_found') && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const privatePaths = [];
  for (const privatePath of protectedPaths) {
    privatePaths.push(path.resolve(privatePath));
    try { privatePaths.push(await realpath(privatePath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { ...parseRunnerSettings({ server, name: os.hostname(), stateDir }), projects: [], protectedPaths: [...new Set(privatePaths)] };
}
export async function prepareAssist(link: string, ui: AssistUi, home = os.homedir(), signal?: AbortSignal) {
  const key = parseAssistLink(link);
  const inspect = z.object({ feature: z.literal(ASSIST_MULTI_FEATURE), invite: assistInviteViewSchema }).strict().parse(await post(key.server, '/assist/v2/inspect', { id: key.id, token: key.token }, signal));
  const invite = inspect.invite;
  if (await ui.select('核对远程协助邀请', [{ value: 'cancel', label: '取消' }, { value: 'continue', label: '选择本机授权范围' }], [`服务：${key.server}`, `请求方（由 Server 声明）：${safe(invite.operatorName)}`, '项目内容和结果可能发送给操作者的模型服务。']) !== 'continue') return;
  const config = await assistConfig(key.server, home);
  let projects: AssistApprovedProject[] = [], nextId = 1;
  while (true) {
    signal?.throwIfAborted();
    const action = await ui.select('本次共享项目', [
      { value: 'cancel', label: '取消协助' },
      ...projects.map(project => ({ value: 'project:' + project.id, label: `${safe(project.name)} · ${project.scopes.join('/')} · ${safe(project.root)}` })),
      ...(projects.length < 16 ? [{ value: 'add', label: '添加项目' }] : []),
      ...(projects.length ? [{ value: 'done', label: `完成选择（${projects.length} 个项目）` }] : []),
    ], ['每个项目单独批准读写与程序。连接后项目集合固定；调整范围需结束后重新批准。']);
    if (!action || action === 'cancel') return;
    if (action === 'add') {
      const project = await chooseProject(ui, invite.scopes, 'project-' + nextId++);
      if (project) projects.push(project);
    } else if (action.startsWith('project:')) {
      const index = projects.findIndex(project => project.id === action.slice(8));
      if (index < 0) continue;
      const project = projects[index]!;
      const edit = await ui.select('修改共享项目', [{ value: 'back', label: '返回项目清单' }, { value: 'edit', label: '重新选择目录与权限' }, { value: 'remove', label: '移除此项目' }], [`ID：${project.id}`, `名称：${safe(project.name)}`, `目录：${safe(project.root)}`, `权限：${project.scopes.join(' / ')}`, ...project.commands.map(program => `程序：${safe(program)}`)]);
      if (edit === 'remove') projects.splice(index, 1);
      else if (edit === 'edit') {
        const changed = await chooseProject(ui, invite.scopes, project.id, project);
        if (changed) projects[index] = changed;
      }
    } else if (action === 'done') {
      const now = Date.now();
      try {
        const validated = await AssistConsent.validate(config, { projects, durationMinutes: 30, approvedAt: now, expiresAt: now + 1800000 });
        projects = approvedProjects(validated); break;
      } catch (error) {
        ui.log(`项目清单尚未批准，请修改后重试：${safe(error instanceof AppError ? error.message : '目录或程序不可访问')}`);
      }
    }
  }
  const durations = [30, 120, 480].filter(value => value <= invite.maxDurationMinutes);
  const duration = await ui.select('本次授权时长', [{ value: 'cancel', label: '取消' }, ...durations.map(value => ({ value: String(value), label: `${value} 分钟` }))], ['最终本机批准后立即开始计时，断线即结束，不能自动恢复。']);
  if (!duration || duration === 'cancel') return;
  // Separate review screens keep long paths and each project's risks visible.
  for (const project of projects) {
    for (const description of [[`项目：${safe(project.name)}（${project.id}）`, `目录：${safe(project.root)}`], [`权限：${project.scopes.join(' / ')}`, '允许执行不是只读沙箱，已产生的副作用不会自动回滚。'], ...project.commands.map(program => [`允许程序：${safe(program)}`, '程序参数由 AI 指定；程序使用你的系统账户权限。'])]) {
      if (await ui.select('核对本机授权', [{ value: 'cancel', label: '取消' }, { value: 'next', label: '确认这一项' }], description) !== 'next') return;
    }
  }
  if (await ui.select('激活远程协助', [{ value: 'cancel', label: '取消' }, { value: 'approve', label: `批准 ${projects.length} 个项目 · ${duration} 分钟，并连接` }], [`服务：${key.server}`, '你可以随时立即停止；断线或到期不能自动恢复。']) !== 'approve') return;
  signal?.throwIfAborted();
  const now = Date.now(), approval: AssistMultiApproval = { projects, durationMinutes: Number(duration) as 30 | 120 | 480, approvedAt: now, expiresAt: now + Number(duration) * 60000 };
  const consent = new AssistConsent(approval);
  const claim = async (progressSignal?: AbortSignal) => {
    const abort = signal && progressSignal ? AbortSignal.any([signal, progressSignal]) : signal ?? progressSignal;
    const revoke = () => consent.revoke();
    abort?.addEventListener('abort', revoke, { once: true });
    try {
      abort?.throwIfAborted(); consent.assertAlive();
      // Revalidate after review without silently changing what was displayed.
      if (JSON.stringify(await AssistConsent.validate(config, approval)) !== JSON.stringify(approval)) throw new AppError('assist_mismatch', '项目或程序路径在批准过程中发生变化，请重新选择。');
      abort?.throwIfAborted(); consent.assertAlive();
      const response = z.object({ feature: z.literal(ASSIST_MULTI_FEATURE), descriptor: assistMultiDescriptorSchema, token: z.string().min(32).max(128) }).strict().parse(await post(key.server, '/assist/v2/claim', { id: key.id, token: key.token, feature: ASSIST_MULTI_FEATURE, name: config.name, approval }, abort));
      abort?.throwIfAborted(); consent.assertAlive();
      if (response.descriptor.inviteId !== invite.id || response.descriptor.authorizationId !== invite.authorizationId || response.descriptor.authorizationRevision !== invite.authorizationRevision || response.descriptor.operatorId !== invite.operatorId) throw new AppError('assist_mismatch', 'Server changed the invitation identity');
      consent.bind(response.descriptor);
      return response;
    } catch (error) { consent.close(); throw error; }
    finally { abort?.removeEventListener('abort', revoke); }
  };
  const response = ui.progress ? await ui.progress('连接远程协助', ['正在领取一次性邀请；取消后不会激活访问。'], claim) : await claim();
  ui.log(`协助状态和日志保存在：${config.stateDir}`);
  return { config, consent, credential: { server: config.server, deviceId: response.descriptor.deviceId, token: response.token } };
}
export async function runAssist(link?: string, plain = false) {
  if (!process.stdin.isTTY) throw new AppError('local_consent_required', 'Remote Assist requires an interactive local terminal');
  const tui = plain ? undefined : new RunnerTui({ version: VERSION, node: process.version, platform: process.platform, arch: process.arch, device: os.hostname(), server: 'Remote Assist', config: '临时本机授权 · 不保存永久配对' }, { interactive: true, keepOpenOnStop: true });
  const rl = !tui ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ui: AssistUi = tui ?? {
    log: console.log,
    async ask(title, fallback = '', description = [], validate) { console.log(description.join('\n')); const value = (await rl!.question(`${title}: `)).trim() || fallback; if (!value) return; const problem = validate?.(value); if (problem) throw new Error(problem); return value; },
    async select(title, choices, description = []) { console.log(title + '\n' + description.join('\n')); choices.forEach((choice, index) => console.log(`${index + 1}. ${choice.label}`)); const value = await rl!.question('选择（默认第一项）: '); return choices[Number(value || '1') - 1]?.value; },
  };
  let agent: Agent | undefined;
  const controller = new AbortController();
  const exit = () => { controller.abort(); agent?.consent?.revoke(); tui?.requestExit(); rl?.close(); };
  process.on('SIGINT', exit); process.on('SIGTERM', exit);
  tui?.start();
  try {
    const invitation = link ?? await ui.ask('粘贴完整远程协助邀请链接');
    if (!invitation) return;
    const prepared = await prepareAssist(invitation, ui, os.homedir(), controller.signal);
    if (!prepared) return;
    tui?.updateInfo({ server: prepared.config.server, device: prepared.config.name });
    agent = new Agent(prepared.config, prepared.credential, text => ui.log(text), (state, detail) => tui?.setState(state, detail), prepared.consent);
    agent.start();
    while (true) {
      const selected = await ui.select('远程协助 · 本机控制', [{ value: 'stop', label: '立即停止 / 重试任务清理' }, { value: 'activity', label: '查看本机任务状态' }, { value: 'exit', label: '结束并退出' }], [`本机到期：${new Date(prepared.consent.snapshot().expiresAt).toLocaleString()}`, '本机授权不随 Server 配置延长。']);
      if (selected === 'activity') { for (const job of agent.tools.processes.snapshot()) ui.log(`${job.projectId} · ${job.id.slice(0, 8)} · ${job.executable} · ${job.state}`); continue; }
      await agent.stopAssist('local_stop');
      if (selected !== 'stop') break;
    }
  } catch (error) { if (!(error instanceof TuiExitError) && !(error instanceof TuiCancelError) && !controller.signal.aborted) throw error; }
  finally { process.off('SIGINT', exit); process.off('SIGTERM', exit); try { await agent?.close(); } finally { tui?.stop(); rl?.close(); } }
}
