import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, type Principal } from '../shared/protocol.js';
import type { ProjectConfig } from './config.js';
import type { Policy } from './policy.js';
import type { Processes } from './processes.js';

type ShellKind = 'powershell' | 'cmd' | 'posix';
interface PendingCommand {
  token: string;
  startCursor: number;
  command: string;
}
interface ShellSession {
  sessionId: string;
  owner: string;
  projectId: string;
  shell: string;
  kind: ShellKind;
  cwd: string;
  started: number;
  lastExitCode: number | null;
  pending?: PendingCommand;
}

function detectShellKind(executable: string): ShellKind {
  const base = path.basename(executable).toLowerCase();
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(base)) return 'powershell';
  if (/^cmd(?:\.exe)?$/.test(base)) return 'cmd';
  return 'posix';
}

function defaultShellArgs(kind: ShellKind, executable: string): string[] {
  if (kind === 'powershell') return ['-NoLogo', '-NoProfile', '-Command', '-'];
  if (kind === 'cmd') return ['/Q', '/K', 'prompt $S'];
  const base = path.basename(executable).toLowerCase();
  if (base === 'bash' || base === 'bash.exe') return ['--noprofile', '--norc'];
  if (base === 'zsh' || base === 'zsh.exe') return ['--no-rcs'];
  return [];
}

function selectDefaultShell(project: ProjectConfig): string {
  if (Object.hasOwn(project.commandAliases, 'shell')) return 'shell';
  const candidates = process.platform === 'win32'
    ? ['powershell.exe', 'pwsh.exe', 'pwsh', 'powershell', 'cmd.exe', 'bash.exe', 'sh.exe']
    : ['/bin/bash', 'bash', '/bin/sh', 'sh', '/bin/zsh', 'zsh'];
  if (project.commandMode === 'allowlist') {
    for (const allowed of project.commands) {
      const base = path.basename(allowed).toLowerCase();
      if (candidates.some(candidate => path.basename(candidate).toLowerCase() === base)) return allowed;
    }
  }
  return process.platform === 'win32' ? 'powershell.exe' : 'sh';
}

function buildFramedScript(kind: ShellKind, token: string, command: string): string {
  if (kind === 'powershell') {
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    return `[Console]::InputEncoding=[Console]::OutputEncoding=$OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::Out.WriteLine('__HA_B_'+'${token}__'); $global:LASTEXITCODE=0; $__ha_ec=0; try { . ([ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}')))); if (-not $?) { $__ha_ec = if ($LASTEXITCODE) { [int]$LASTEXITCODE } else { 1 } } elseif ($LASTEXITCODE) { $__ha_ec = [int]$LASTEXITCODE } } catch { [Console]::Error.WriteLine($_); $__ha_ec = 1 }; $__ha_cwd=[System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((Get-Location).Path)); [Console]::Out.WriteLine('__HA_E_'+'${token}:'+$__ha_ec+':'+$__ha_cwd+'__')\n\n`;
  }
  if (kind === 'cmd') {
    return `@echo __HA_B_${token}__\r\n${command}\r\n@echo __HA_E_${token}:%ERRORLEVEL%:%CD%__\r\n`;
  }
  const singleQuoted = command.replace(/'/g, `'\\''`);
  return `printf '__HA_B_%s__\\n' '${token}'\neval '${singleQuoted}'\n__ha_ec=$?\nprintf '\\n__HA_E_%s:%d:%s__\\n' '${token}' "$__ha_ec" "$(pwd)"\n`;
}

function parseFramedOutput(raw: string, kind: ShellKind, token: string): { completed: boolean; output: string; exitCode: number | null; cwd?: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const beginMarker = `__HA_B_${token}__`;
  const beginIndex = normalized.indexOf(beginMarker);
  const contentStart = beginIndex >= 0
    ? (normalized[beginIndex + beginMarker.length] === '\n' ? beginIndex + beginMarker.length + 1 : beginIndex + beginMarker.length)
    : 0;
  const endRegex = new RegExp(`__HA_E_${token}:(-?\\d+):([^\\n]*?)__`);
  const slice = normalized.slice(contentStart);
  const match = endRegex.exec(slice);
  if (!match) {
    return { completed: false, output: slice, exitCode: null };
  }
  let output = slice.slice(0, match.index);
  if (kind === 'posix' && output.endsWith('\n')) {
    // Strip the leading newline injected before __HA_E_ when command output did not end with one, or preserve natural trailing newline.
    output = output.slice(0, -1);
  }
  const exitCode = Number(match[1]);
  let cwd = match[2]!.trim();
  if (kind === 'powershell' && cwd) {
    try { cwd = Buffer.from(cwd, 'base64').toString('utf8'); } catch {}
  }
  return { completed: true, output, exitCode, cwd: cwd || undefined };
}

export class Shells {
  private sessions = new Map<string, ShellSession>();
  constructor(private policy: Policy, private processes: Processes) {}

  private async reconcile(session: ShellSession) {
    const jobs = this.processes.list(session.owner, session.projectId);
    const job = jobs.find(item => item.id === session.sessionId);
    if (!job) {
      this.sessions.delete(session.sessionId);
      throw new AppError('unknown_shell', 'Shell session is not owned by this client and project');
    }
    if (session.pending) {
      try {
        const tail = this.processes.tail(session.owner, session.projectId, { processId: session.sessionId, cursor: session.pending.startCursor, length: 65536 });
        const parsed = parseFramedOutput(tail.output, session.kind, session.pending.token);
        if (parsed.completed) {
          session.lastExitCode = parsed.exitCode;
          if (parsed.cwd) session.cwd = parsed.cwd;
          session.pending = undefined;
        } else if (job.finished) {
          session.lastExitCode = job.exitCode ?? null;
          session.pending = undefined;
        }
      } catch {
        if (job.finished) session.pending = undefined;
      }
    }
    return job;
  }

  private ownedSession(owner: string, projectId: string, sessionId: string): ShellSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== owner || session.projectId !== projectId) {
      throw new AppError('unknown_shell', 'Shell session is not owned by this client and project');
    }
    return session;
  }

  async start(
    project: ProjectConfig,
    owner: string,
    args: { shell?: string; cwd: string; timeoutMs: number; environment?: string },
    signal?: AbortSignal,
    authorization?: Pick<Principal, 'authorizationId' | 'authorizationExpiresAt' | 'authorizationRevision' | 'assist'>,
  ) {
    const requested = args.shell ?? selectDefaultShell(project);
    const alias = Object.hasOwn(project.commandAliases, requested) ? project.commandAliases[requested] : undefined;
    const resolvedExecutable = alias?.executable ?? requested;
    const kind = detectShellKind(resolvedExecutable);
    const launchArgs = alias?.args?.length ? [] : defaultShellArgs(kind, resolvedExecutable);
    const cwd = await this.policy.resolve(project, args.cwd);
    const started = await this.processes.start(
      project,
      owner,
      { executable: requested, args: launchArgs, cwd: args.cwd, timeoutMs: args.timeoutMs, environment: args.environment },
      signal,
      authorization,
    );
    const session: ShellSession = {
      sessionId: started.id,
      owner,
      projectId: project.id,
      shell: path.basename(resolvedExecutable),
      kind,
      cwd,
      started: started.started,
      lastExitCode: null,
    };
    this.sessions.set(session.sessionId, session);
    return {
      sessionId: session.sessionId,
      processId: session.sessionId,
      shell: session.shell,
      kind: session.kind,
      cwd: session.cwd,
      state: started.state === 'running' || started.state === 'starting' ? 'ready' : started.state,
      started: session.started,
    };
  }

  async run(
    project: ProjectConfig,
    owner: string,
    args: { sessionId?: string; command: string; shell?: string; cwd: string; environment?: string; timeoutMs: number; waitMs: number },
    signal?: AbortSignal,
    authorization?: Pick<Principal, 'authorizationId' | 'authorizationExpiresAt' | 'authorizationRevision' | 'assist'>,
  ) {
    if (args.command.includes('\0')) throw new AppError('invalid_command', 'NUL is not permitted in shell commands');
    let session: ShellSession | undefined;
    let created = false;
    if (args.sessionId) {
      session = this.ownedSession(owner, project.id, args.sessionId);
      const job = await this.reconcile(session);
      if (job.finished) throw new AppError('shell_finished', 'Shell session has already terminated; start a new shell session');
      if (session.pending) throw new AppError('shell_busy', 'Shell session is currently executing a command; wait for completion or stop_shell');
    } else {
      for (const candidate of this.sessions.values()) {
        if (candidate.owner === owner && candidate.projectId === project.id) {
          const job = await this.reconcile(candidate);
          if (!job.finished && !candidate.pending && (!args.shell || candidate.shell.toLowerCase() === path.basename(args.shell).toLowerCase())) {
            session = candidate;
            break;
          }
        }
      }
      if (!session) {
        const started = await this.start(project, owner, { shell: args.shell, cwd: args.cwd, timeoutMs: args.timeoutMs, environment: args.environment }, signal, authorization);
        session = this.ownedSession(owner, project.id, started.sessionId);
        created = true;
      }
    }

    const initialTail = this.processes.tail(owner, project.id, { processId: session.sessionId, length: 1 });
    const startCursor = initialTail.nextCursor;
    const token = randomUUID().replace(/-/g, '');
    const script = buildFramedScript(session.kind, token, args.command);
    session.pending = { token, startCursor, command: args.command };
    try {
      await this.processes.input(owner, project.id, { processId: session.sessionId, input: script, close: false });
    } catch (error) {
      session.pending = undefined;
      throw error;
    }

    const deadline = Date.now() + args.waitMs;
    let cursor = startCursor;
    let collected = '';
    while (true) {
      const remaining = Math.max(0, deadline - Date.now());
      const stepWait = Math.min(remaining, 20000);
      const waited = await this.processes.wait(owner, project.id, {
        processId: session.sessionId,
        cursor,
        length: 65536,
        waitMs: stepWait,
        until: 'output',
      }, signal);
      if (waited.output) {
        const delta = waited.cursor > cursor ? waited.output : waited.output.slice(Math.max(0, cursor - waited.cursor));
        collected += delta;
        cursor = waited.nextCursor;
      }
      const parsed = parseFramedOutput(collected, session.kind, token);
      if (parsed.completed) {
        session.pending = undefined;
        session.lastExitCode = parsed.exitCode;
        if (parsed.cwd) session.cwd = parsed.cwd;
        return {
          sessionId: session.sessionId,
          processId: session.sessionId,
          shell: session.shell,
          created,
          state: 'ready',
          finished: true,
          exitCode: parsed.exitCode,
          cwd: session.cwd,
          output: parsed.output,
        };
      }
      if (waited.finished) {
        session.pending = undefined;
        session.lastExitCode = waited.exitCode ?? null;
        return {
          sessionId: session.sessionId,
          processId: session.sessionId,
          shell: session.shell,
          created,
          state: waited.state,
          finished: true,
          exitCode: waited.exitCode ?? 0,
          cwd: session.cwd,
          output: parsed.output,
        };
      }
      if (Date.now() >= deadline) {
        return {
          sessionId: session.sessionId,
          processId: session.sessionId,
          shell: session.shell,
          created,
          state: 'running',
          finished: false,
          exitCode: null,
          cwd: session.cwd,
          output: parsed.output,
        };
      }
    }
  }

  async list(owner: string, projectId: string) {
    const items = [];
    for (const session of [...this.sessions.values()]) {
      if (session.owner !== owner || session.projectId !== projectId) continue;
      try {
        const job = await this.reconcile(session);
        items.push({
          sessionId: session.sessionId,
          processId: session.sessionId,
          shell: session.shell,
          kind: session.kind,
          cwd: session.cwd,
          state: job.finished ? job.state : (session.pending ? 'running' : 'ready'),
          lastExitCode: session.lastExitCode,
          started: session.started,
          finished: Boolean(job.finished),
          finishedAt: job.finished ?? null,
        });
      } catch {}
    }
    return items.sort((a, b) => b.started - a.started);
  }

  async stop(owner: string, projectId: string, sessionId: string) {
    const session = this.ownedSession(owner, projectId, sessionId);
    session.pending = undefined;
    await this.processes.stop(owner, projectId, sessionId);
    const waited = await this.processes.wait(owner, projectId, { processId: sessionId, waitMs: 2000, until: 'finished', length: 1 }).catch(() => undefined);
    const current = waited ?? this.processes.list(owner, projectId).find(item => item.id === sessionId);
    return {
      sessionId: session.sessionId,
      processId: session.sessionId,
      shell: session.shell,
      cwd: session.cwd,
      state: current?.state ?? 'stopped',
      finished: Boolean(current?.finished ?? true),
    };
  }
}
