import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError, jobViewSchema, terminalJob, type JobView } from '../shared/protocol.js';
import type { ProjectConfig, RunnerConfig } from './config.js';
import { Policy } from './policy.js';
import { OutputLog } from './output-log.js';

export interface Job extends JobView { error?: string; requestKey?: string; executionHash?: string }
interface StartArgs { executable: string; args: string[]; cwd: string; timeoutMs: number; idempotencyKey?: string; environment?: string }
interface LiveJob {
  child: ChildProcess; log: OutputLog; timer: NodeJS.Timeout; killTimer?: NodeJS.Timeout;
  job: Job; stoppedAs?: 'stopped' | 'timed_out'; treeReleased: boolean;
  done: Promise<void>; finish: () => void;
}
export function toolEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|localappdata|appdata|lang|lc_.*|term)$/i.test(key)) env[key] = value;
  }
  if (process.platform === 'win32') {
    // WinPS needs an explicit module path in a filtered environment. Use only
    // built-in modules; never inherit user/project module-loader hooks.
    env.PSModulePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  }
  env.NO_COLOR = '1';
  return env;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Processes extends EventEmitter<{ change: [JobView] }> {
  private db: DatabaseSync;
  private live = new Map<string, LiveJob>();
  private closing?: Promise<void>;
  constructor(readonly config: RunnerConfig, readonly policy: Policy) {
    super();
    this.setMaxListeners(64);
    this.db = new DatabaseSync(path.join(config.stateDir, 'jobs.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, signature TEXT NOT NULL, jobId TEXT NOT NULL, expires INTEGER NOT NULL)');
    for (const job of this.all()) if (!job.finished) {
      job.state = 'interrupted'; job.finished = Date.now();
      // A crash can occur between the ring write and its metadata commit. Do not invent a valid tail cursor.
      delete job.totalOutputBytes;
      this.save(job);
    }
  }
  private all(): Job[] { return this.db.prepare('SELECT data FROM jobs').all().map(row => ({ revision: 0, ...JSON.parse(row.data as string) }) as Job); }
  private view(job: Job): JobView {
    const { error, requestKey, executionHash, ...view } = job;
    return jobViewSchema.parse({ ...view, executable: path.basename(job.executable) });
  }
  snapshot(): JobView[] { return this.all().map(job => this.view(job)); }
  private save(job: Job) {
    job.revision = (job.revision ?? 0) + 1;
    this.db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job));
    this.emit('change', this.view(job));
  }
  private receipt(job: Job) { const { requestKey, executionHash, ...receipt } = job; return receipt; }
  private filename(id: string) { return path.join(this.config.stateDir, `${id}.output`); }
  private get(id: string): Job | undefined {
    const live = this.live.get(id);
    if (live) return live.job;
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id);
    return row ? { revision: 0, ...JSON.parse(row.data as string) } as Job : undefined;
  }
  private owned(id: string, owner: string, projectId: string) {
    const job = this.get(id);
    if (!job || job.owner !== owner || job.projectId !== projectId) throw new AppError('unknown_process', 'Process is not owned by this client and project');
    return job;
  }
  private replay(key: string | undefined, signature: string) {
    if (!key) return;
    const row = this.db.prepare('SELECT * FROM requests WHERE key=?').get(key);
    if (!row || (row.expires as number) <= Date.now()) return;
    if (row.signature !== signature) throw new AppError('idempotency_conflict', 'This idempotency key was used with different execution arguments');
    const job = this.get(row.jobId as string);
    if (!job) throw new AppError('idempotency_receipt_expired', 'The execution was admitted, but its job history has been pruned. Inspect the project before starting a new execution.');
    return { ...this.receipt(job), replayed: true };
  }
  async start(project: ProjectConfig, owner: string, args: StartArgs, signal?: AbortSignal) {
    const alias = Object.hasOwn(project.commandAliases, args.executable) ? project.commandAliases[args.executable] : undefined;
    const executable = alias?.executable ?? args.executable;
    const argv = [...(alias?.args ?? []), ...args.args];
    if (!alias) this.policy.command(project, executable);
    else if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) throw new AppError('command_denied', 'Command aliases must resolve to an executable, not a .cmd/.bat wrapper');
    if (argv.some(arg => arg.includes('\0')) || executable.includes('\0')) throw new AppError('invalid_command', 'NUL is not permitted in executable arguments');
    const env = toolEnvironment();
    if (args.environment) {
      const profile = Object.hasOwn(project.environmentProfiles, args.environment) ? project.environmentProfiles[args.environment] : undefined;
      if (!profile) throw new AppError('unknown_environment', 'Environment profile is not configured locally');
      for (const key of profile.inherit) if (process.env[key] !== undefined) env[key] = process.env[key];
      Object.assign(env, profile.env);
    }
    const cwd = await this.policy.resolve(project, args.cwd);
    const key = args.idempotencyKey ? digest([owner, project.id, args.idempotencyKey]) : undefined;
    const signature = digest([executable, argv, cwd, args.timeoutMs, args.environment ?? null, args.environment ? env : null]);
    const existing = this.replay(key, signature);
    if (existing) return existing;
    await this.prune();
    if (signal?.aborted || this.closing) throw new AppError('cancelled', 'Process start cancelled');
    const concurrentReplay = this.replay(key, signature);
    if (concurrentReplay) return concurrentReplay;
    if (this.live.size >= this.config.maxProcesses) throw new AppError('process_limit', 'Runner process limit reached');
    if (key && (this.db.prepare('SELECT count(*) AS n FROM requests').get()!.n as number) >= 10000) throw new AppError('idempotency_limit', 'Idempotency receipt capacity reached; retry after old receipts expire');
    const job: Job = { id: randomUUID(), owner, projectId: project.id, executable, started: Date.now(), state: 'starting', revision: 0, outputBytes: 0, totalOutputBytes: 0, truncated: false, requestKey: key, executionHash: signature };
    const log = new OutputLog(this.filename(job.id), this.config.maxOutputBytes);
    // Persist admission before spawn. A crash is an interrupted outcome, never an automatic second execution.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.save(job);
      if (key) this.db.prepare('INSERT OR REPLACE INTO requests VALUES(?,?,?,?)').run(key, signature, job.id, Date.now() + 48 * 3600000);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); log.close(); throw error; }
    let child: ChildProcess;
    try {
      const options = { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env, stdio: 'pipe' as const };
      if (process.platform === 'win32') {
        const helper = fileURLToPath(new URL('../../runtime/windows-process-tree.ps1', import.meta.url));
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', helper, '-Executable', executable, '-ArgumentsBase64', Buffer.from(JSON.stringify(argv)).toString('base64'), '-ParentPid', String(process.pid)], options);
      } else child = spawn(executable, argv, options);
    } catch (error) {
      log.close(); job.state = 'failed'; job.finished = Date.now(); job.error = String(error); this.save(job); throw error;
    }
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const timer = setTimeout(() => { void this.terminate(job.id, 'timed_out').catch(error => { job.error = String(error); this.save(job); }); }, args.timeoutMs).unref();
    const live: LiveJob = { child, log, timer, job, done, finish, treeReleased: false };
    this.live.set(job.id, live);
    const capture = (buffer: Buffer) => {
      log.append(buffer);
      job.outputBytes = log.retained; job.totalOutputBytes = log.total;
      if (log.total > log.retained) job.truncated = true;
      this.save(job);
    };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    child.stdin?.on('error', () => {});
    child.once('spawn', () => { if (job.state === 'starting') { job.state = 'running'; this.save(job); } });
    child.once('error', error => { job.state = 'failed'; job.error = error.message; this.save(job); });
    child.once('exit', () => {
      // A leader's exit is not proof its descendants exited. Reap the remaining owned group immediately.
      if (process.platform !== 'win32') this.killGroup(live, 'SIGKILL');
    });
    child.once('close', (code, killedSignal) => {
      clearTimeout(timer); if (live.killTimer) clearTimeout(live.killTimer);
      live.treeReleased = true; log.close(); this.live.delete(job.id);
      if (live.stoppedAs) job.state = live.stoppedAs;
      else if (job.state !== 'failed') job.state = code === 0 ? 'exited' : 'failed';
      job.finished = Date.now(); job.exitCode = code; job.signal = killedSignal; this.save(job); finish();
    });
    await new Promise<void>(resolve => { child.once('spawn', resolve); child.once('error', () => resolve()); });
    return this.receipt(job);
  }
  async read(owner: string, projectId: string, args: { processId: string; cursor: number; length: number }) {
    const job = this.owned(args.processId, owner, projectId);
    const handle = await open(this.filename(job.id), 'r');
    try {
      const buffer = Buffer.alloc(args.length);
      const { bytesRead } = await handle.read(buffer, 0, args.length, args.cursor);
      return { ...this.receipt(job), output: buffer.subarray(0, bytesRead).toString('utf8'), cursor: args.cursor, nextCursor: args.cursor + bytesRead };
    } finally { await handle.close(); }
  }
  list(owner: string, projectId: string) { return this.all().filter(job => job.owner === owner && job.projectId === projectId).sort((a, b) => b.started - a.started).map(job => this.receipt(job)); }
  tail(owner: string, projectId: string, args: { processId: string; cursor?: number; length: number }) {
    const job = this.owned(args.processId, owner, projectId);
    if (job.totalOutputBytes === undefined) throw new AppError('tail_unavailable', 'Rolling-tail position is unavailable for this legacy or interrupted job; use read_process_output');
    return { ...this.receipt(job), ...OutputLog.read(this.filename(job.id), job.totalOutputBytes, args.length, args.cursor) };
  }
  async wait(owner: string, projectId: string, args: { processId: string; cursor?: number; length: number; waitMs: number; until: 'output' | 'finished' }, signal?: AbortSignal) {
    this.owned(args.processId, owner, projectId);
    if (signal?.aborted) throw new AppError('cancelled', 'Wait cancelled; execution continues');
    const baseline = args.cursor ?? (this.get(args.processId)!.totalOutputBytes ?? 0);
    let reason = 'timeout';
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const cleanup = () => { clearTimeout(timer); this.off('change', changed); signal?.removeEventListener('abort', abort); };
      const finish = (why: string) => { reason = why; cleanup(); resolve(); };
      const check = () => {
        const job = this.get(args.processId)!;
        if (job.finished) { finish('finished'); return; }
        if (args.until === 'output' && (job.totalOutputBytes ?? 0) > baseline) finish('output');
      };
      const changed = (job: JobView) => { if (job.id === args.processId) check(); };
      const abort = () => { cleanup(); reject(new AppError('cancelled', 'Wait cancelled; execution continues')); };
      timer = setTimeout(() => finish('timeout'), args.waitMs);
      this.on('change', changed); signal?.addEventListener('abort', abort, { once: true }); check();
    });
    return { ...this.tail(owner, projectId, args), waitReason: reason };
  }
  async run(project: ProjectConfig, owner: string, args: StartArgs & { waitMs: number; length: number }, signal?: AbortSignal) {
    const started = await this.start(project, owner, args, signal);
    return { ...await this.wait(owner, project.id, { processId: started.id, length: args.length, waitMs: args.waitMs, until: 'finished' }, signal), replayed: 'replayed' in started ? started.replayed : false };
  }
  async input(owner: string, projectId: string, args: { processId: string; input: string; close: boolean }) {
    this.owned(args.processId, owner, projectId);
    const live = this.live.get(args.processId);
    if (!live || live.job.state !== 'running' || !live.child.stdin?.writable) throw new AppError('process_finished', 'Process stdin is not available');
    await new Promise<void>((resolve, reject) => live.child.stdin!.write(args.input, error => error ? reject(error) : resolve()));
    if (args.close) live.child.stdin.end();
    return { sent: Buffer.byteLength(args.input) };
  }
  async stop(owner: string, projectId: string, id: string) {
    this.owned(id, owner, projectId); await this.terminate(id, 'stopped'); return this.receipt(this.owned(id, owner, projectId));
  }
  private killGroup(live: LiveJob, signal: NodeJS.Signals) {
    if (live.treeReleased || !live.child.pid) return;
    if (live.killTimer) clearTimeout(live.killTimer);
    try { process.kill(-live.child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (signal === 'SIGKILL') live.treeReleased = true;
  }
  private async terminate(id: string, state: 'stopped' | 'timed_out') {
    const live = this.live.get(id);
    if (!live || live.stoppedAs || live.treeReleased) return;
    live.stoppedAs = state; live.job.state = 'stopping'; this.save(live.job);
    if (process.platform === 'win32') {
      if (live.child.pid) await new Promise<void>((resolve, reject) => {
        const killer = spawn('taskkill.exe', ['/PID', String(live.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', reject);
        killer.once('close', code => { if (code && live.child.exitCode === null && this.live.has(id)) reject(new AppError('termination_failed', 'Windows rejected process-tree termination')); else resolve(); });
      });
    } else if (live.child.pid) {
      this.killGroup(live, 'SIGTERM');
      live.killTimer = setTimeout(() => this.killGroup(live, 'SIGKILL'), 1500).unref();
    }
  }
  private async prune() {
    this.db.prepare('DELETE FROM requests WHERE expires <= ?').run(Date.now());
    const finished = this.all().filter(terminalJob).sort((a, b) => b.started - a.started);
    for (const job of finished.slice(this.config.maxJobHistory - this.config.maxProcesses)) {
      await unlink(this.filename(job.id)).catch(() => {});
      await unlink(`${this.filename(job.id)}.tail`).catch(() => {});
      this.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
    }
  }
  async stopAll() { await Promise.all([...this.live.keys()].map(id => this.terminate(id, 'stopped'))); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.stopAll();
      const pending = [...this.live.values()].map(live => live.done);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([Promise.all(pending), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Runner process trees have not exited; persistence remains open')), 7000); })]);
      } finally { if (timer) clearTimeout(timer); }
      this.db.close();
    })();
    return this.closing;
  }
}
