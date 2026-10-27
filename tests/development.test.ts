import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Tools } from '../src/runner/tools.js';
import { sha256 } from '../src/runner/files.js';
import { fixture, waitFor } from './helpers.js';
import type { Principal, ToolResult } from '../src/shared/protocol.js';
import { randomUUID } from 'node:crypto';
import { loadRunnerConfig } from '../src/runner/config.js';
import { RunnerPermissions } from '../src/runner/permissions.js';
const exec = promisify(execFile);
const principal: Principal = { id: 'development-client', scopes: ['read', 'write', 'execute', 'git'], devices: null, projects: null };
const value = (result: ToolResult) => JSON.parse(result.content[0]!.text);
const caller = (tools: Tools) => (name: string, args: object = {}, who = principal, signal?: AbortSignal) => tools.invoke(name, { projectId: 'workspace', ...args }, who, signal);

test('Server project policies cannot expose the Runner connection file', async t => {
  const f = await fixture();
  const filename = path.join(f.root, 'runner.json');
  await writeFile(filename, JSON.stringify({ server: f.config.server, stateDir: f.stateDir }));
  const config = await loadRunnerConfig(filename, {}), tools = new Tools(config);
  const manager = new RunnerPermissions(config, tools, async () => {}, () => {});
  t.after(async () => { manager.close(); await tools.close(); await f.cleanup(); });
  const projects = f.config.projects;
  await assert.rejects(manager.apply({ revision: 1, projects, expiresAt: null, fallbackProjects: [] }), /Project roots must exclude/);
  assert.deepEqual(config.projects, []);
});

test('line-based batch reads preserve CRLF, report independent errors and fence edits by full SHA', async t => {
  const f = await fixture(), tools = new Tools(f.config), call = caller(tools);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  await writeFile(path.join(f.root, 'a.txt'), 'one\r\ntwo\r\nthree\r\n');
  await writeFile(path.join(f.root, 'b.txt'), 'other');
  const response = value(await call('read_files', { files: [{ path: 'a.txt', startLine: 2, endLine: 2 }, { path: '.env' }, { path: 'b.txt' }] }));
  assert.equal(response.files[0].text, 'two\r\n'); assert.equal(response.files[0].nextStartLine, null);
  assert.equal(response.files[0].sha256, sha256('one\r\ntwo\r\nthree\r\n'));
  assert.ok(response.files[1].error); assert.equal(response.files[2].text, 'other');
  const wrong = value(await call('read_files', { files: [{ path: 'a.txt', expectedSha256: '0'.repeat(64) }] }));
  assert.equal(wrong.files[0].error, 'conflict');
});

test('multi-file preflight/dry-run prevents partial edits and journal recovery preserves concurrent changes', async t => {
  const f = await fixture(), tools = new Tools(f.config), call = caller(tools);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  await writeFile(path.join(f.root, 'a.txt'), 'before');
  const changes = [{ operation: 'replace', path: 'a.txt', expectedSha256: sha256('before'), content: 'after' }, { operation: 'create', path: 'b.txt', content: 'new' }];
  assert.ok(!(await call('edit_files', { changes, dryRun: true })).isError);
  assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'before');
  assert.equal((await call('edit_files', { changes: [changes[0], { operation: 'replace', path: 'missing.txt', expectedSha256: '0'.repeat(64), content: 'x' }] })).isError, true);
  assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'before');
  const original = tools.files.atomic.bind(tools.files);
  let calls = 0;
  tools.files.atomic = async (filename, bytes) => {
    if (++calls === 2) { await writeFile(path.join(f.root, 'a.txt'), 'external edit'); throw new Error('Injected second-file write failure'); }
    return original(filename, bytes);
  };
  const failed = await call('edit_files', { changes });
  assert.equal(value(failed).error, 'recovery_required');
  assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'external edit');
  assert.equal(value(await call('write_file', { path: 'x.txt', content: 'blocked' })).error, 'recovery_required');
  const receipts = value(await call('get_edit_transactions'));
  assert.equal(receipts[0].state, 'recovery_conflict');
  assert.equal((await call('recover_edit_transaction', { transactionId: receipts[0].id }, { ...principal, id: 'foreign' })).isError, true);
  tools.files.atomic = original;
  await writeFile(path.join(f.root, 'a.txt'), 'after');
  const recovered = value(await call('recover_edit_transaction', { transactionId: receipts[0].id }));
  assert.equal(recovered.state, 'rolled_back');
  assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'before');
  assert.ok(!(await call('edit_files', { changes })).isError);
  assert.equal(await readFile(path.join(f.root, 'b.txt'), 'utf8'), 'new');
});

test('interrupted edits recover after Server projects arrive, with no local project configuration', async t => {
  const f = await fixture(), id = randomUUID(), directory = path.join(f.stateDir, 'edits', id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(f.root, 'a.txt'), 'after');
  await writeFile(path.join(directory, '0.before'), 'before');
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ id, projectId: 'workspace', rootHash: sha256(f.root), owner: principal.id, created: Date.now(), entries: [{ index: 0, path: 'a.txt', before: sha256('before'), after: sha256('after'), mode: 0o600 }] }));
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ state: 'applying' }));
  const projects = structuredClone(f.config.projects);
  f.config.projects = [];
  const tools = new Tools(f.config), manager = new RunnerPermissions(f.config, tools, async () => {}, () => {});
  t.after(async () => { manager.close(); await tools.close(); await f.cleanup(); });
  await tools.editor.ready;
  assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'after', 'No recovery may access a project before the Server authorizes it');
  await manager.apply({ revision: 1, projects, expiresAt: null, fallbackProjects: projects });
  const response = value(await caller(tools)('get_edit_transactions'));
  assert.equal(response[0].state, 'rolled_back'); assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'before');
});

test('Server project reconciliation keeps writes blocked when any interrupted edit still conflicts', async t => {
  const f = await fixture(), projects = structuredClone(f.config.projects);
  for (const [id, filename, current] of [
    ['00000000-0000-4000-8000-000000000001', 'conflict.txt', 'external changes'],
    ['ffffffff-ffff-4fff-8fff-ffffffffffff', 'recoverable.txt', 'after'],
  ]) {
    const directory = path.join(f.stateDir, 'edits', id!);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(f.root, filename!), current!);
    await writeFile(path.join(directory, '0.before'), 'before');
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      id, projectId: 'workspace', rootHash: sha256(f.root), owner: principal.id, created: Date.now(),
      entries: [{ index: 0, path: filename, before: sha256('before'), after: sha256('after'), mode: 0o600 }],
    }));
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ state: 'applying' }));
  }
  f.config.projects = [];
  const tools = new Tools(f.config), manager = new RunnerPermissions(f.config, tools, async () => {}, () => {});
  t.after(async () => { manager.close(); await tools.close(); await f.cleanup(); });
  await manager.apply({ revision: 1, projects, expiresAt: null, fallbackProjects: projects });
  assert.equal(await readFile(path.join(f.root, 'recoverable.txt'), 'utf8'), 'before');
  assert.equal(await readFile(path.join(f.root, 'conflict.txt'), 'utf8'), 'external changes');
  const response = value(await caller(tools)('write_file', { path: 'new.txt', content: 'blocked' }));
  assert.equal(response.error, 'recovery_required');
});

test('an I/O failure on the second file rolls back the first file before reporting failure', async t => {
  const f = await fixture(), tools = new Tools(f.config), call = caller(tools);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  await writeFile(path.join(f.root, 'a.txt'), 'original a'); await writeFile(path.join(f.root, 'b.txt'), 'original b');
  const atomic = tools.files.atomic.bind(tools.files);
  let writes = 0;
  tools.files.atomic = async (filename, bytes) => { if (++writes === 2) throw new Error('Injected disk failure'); return atomic(filename, bytes); };
  const failed = value(await call('edit_files', { changes: [
    { operation: 'replace', path: 'a.txt', expectedSha256: sha256('original a'), content: 'modified a' },
    { operation: 'replace', path: 'b.txt', expectedSha256: sha256('original b'), content: 'modified b' },
  ] }));
  assert.equal(failed.error, 'edit_rolled_back');
  assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'original a');
  assert.equal(await readFile(path.join(f.root, 'b.txt'), 'utf8'), 'original b');
  assert.equal(value(await call('get_edit_transactions'))[0].state, 'rolled_back');
});

test('strict unified diffs support multiple files, CRLF and no-newline markers while rejecting stale contexts', async t => {
  const f = await fixture(), tools = new Tools(f.config), call = caller(tools);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  await writeFile(path.join(f.root, 'a.txt'), 'one\r\ntwo\r\n');
  const diff = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+changed\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+created\n\\ No newline at end of file\n';
  const response = await call('apply_unified_diff', { diff, expectedSha256: { 'a.txt': sha256('one\r\ntwo\r\n'), 'b.txt': null } });
  assert.ok(!response.isError, response.content[0]!.text);
  assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'one\r\nchanged\r\n');
  assert.equal(await readFile(path.join(f.root, 'b.txt'), 'utf8'), 'created');
  const rejected = await call('apply_unified_diff', { diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-wrong\n+new\n', expectedSha256: { 'a.txt': sha256('one\r\nchanged\r\n') } });
  assert.equal(value(rejected).error, 'patch_context');
});

test('short commands use configured aliases/environments; rolling tail retains final errors beyond the prefix cap', async t => {
  const f = await fixture(); f.config.maxOutputBytes = 65536;
  f.config.projects[0]!.commandAliases = { test: { executable: process.execPath, args: ['-e', 'console.log(process.env.HA_TEST_VALUE)'] } };
  f.config.projects[0]!.environmentProfiles = { test: { env: { HA_TEST_VALUE: 'profile-value' }, inherit: [] } };
  const tools = new Tools(f.config), call = caller(tools);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  const context = value(await call('get_project_context'));
  assert.ok(JSON.stringify(context).includes('test')); assert.ok(!JSON.stringify(context).includes('profile-value'));
  const short = value(await call('run_command', { executable: 'test', environment: 'test', waitMs: 5000 }));
  assert.equal(short.state, 'exited'); assert.equal(short.output.trim(), 'profile-value');
  assert.equal((await call('start_process', { executable: 'constructor' })).isError, true);
  const large = value(await call('run_command', { executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(150000));console.error("FINAL_BUILD_ERROR");process.exitCode=2'], waitMs: 5000 }));
  assert.equal(large.state, 'failed'); assert.equal(large.exitCode, 2); assert.ok(large.output.includes('FINAL_BUILD_ERROR'));
  assert.equal(large.outputBytes, 65536); assert.ok(large.totalOutputBytes > large.outputBytes);
  const tail = value(await call('tail_process_output', { processId: large.id, cursor: 0 }));
  assert.ok(tail.skippedBytes > 0);
  const prefix = value(await call('read_process_output', { processId: large.id }));
  assert.ok(!prefix.output.includes('FINAL_BUILD_ERROR'));
});

test('waiting cancels observation without killing execution and returns on new output', async t => {
  const f = await fixture(), tools = new Tools(f.config), call = caller(tools);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  const started = value(await call('start_process', { executable: process.execPath, args: ['-e', 'setTimeout(()=>console.log("ready"),1200);setInterval(()=>{},1000)'] }));
  const controller = new AbortController();
  const waiting = call('wait_process', { processId: started.id, waitMs: 5000 }, principal, controller.signal);
  controller.abort(); assert.equal(value(await waiting).error, 'cancelled');
  const output = value(await call('wait_process', { processId: started.id, waitMs: 5000, until: 'output', cursor: 0 }));
  assert.equal(output.waitReason, 'output'); assert.equal(output.state, 'running'); assert.ok(output.output.includes('ready'));
});

test('selected-file commits preserve unrelated staged entries, reject stale snapshots, and exclude protected diffs', async t => {
  const f = await fixture(), tools = new Tools(f.config), call = caller(tools);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  const git = (...args: string[]) => exec('git', ['-C', f.root, ...args]);
  await git('init'); await git('config', 'user.name', 'Development Test'); await git('config', 'user.email', 'dev@localhost');
  for (const [file, content] of [['ai.txt', 'base'], ['user.txt', 'user base'], ['.env', 'OLD_SECRET']]) await writeFile(path.join(f.root, file!), content!);
  await git('add', '.'); await git('commit', '-m', 'initial');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(path.join(f.root, 'user.txt'), 'user staged'); await git('add', 'user.txt');
  const staged = (await git('rev-parse', ':user.txt')).stdout.trim();
  await writeFile(path.join(f.root, 'ai.txt'), 'AI change');
  await writeFile(path.join(f.root, '.env'), 'NEW_SECRET');
  const review = await call('git_diff');
  assert.ok(!review.content[0]!.text.includes('NEW_SECRET'));
  const committed = await call('git_commit_paths', { files: [{ path: 'ai.txt', expectedSha256: sha256('AI change') }], expectedHead: head, message: 'AI fix only' });
  assert.ok(!committed.isError, committed.content[0]!.text);
  assert.equal((await git('show', '--format=', '--name-only', 'HEAD')).stdout.trim(), 'ai.txt');
  assert.equal((await git('rev-parse', ':user.txt')).stdout.trim(), staged);
  assert.equal((await git('diff', '--cached', '--name-only')).stdout.trim(), 'user.txt');
  assert.equal(value(await call('git_commit_paths', { files: [{ path: 'ai.txt', expectedSha256: sha256('AI change') }], expectedHead: head, message: 'stale' })).error, 'head_changed');
  await assert.rejects(access(path.join(f.root, '.git', 'index.lock')));
  const current = (await git('rev-parse', 'HEAD')).stdout.trim();
  assert.equal(value(await call('git_commit_paths', { files: [{ path: 'user.txt', expectedSha256: sha256('user staged') }], expectedHead: current, message: 'do not consume staged' })).error, 'staged_conflict');
});

test('linked worktree Git needs explicit common directory; branch switching refuses dirty trees', async t => {
  const f = await fixture();
  const git = (...args: string[]) => exec('git', ['-C', f.root, ...args]);
  await git('init'); await git('config', 'user.name', 'Development Test'); await git('config', 'user.email', 'dev@localhost');
  await writeFile(path.join(f.root, 'a.txt'), 'base'); await git('add', 'a.txt'); await git('commit', '-m', 'initial');
  const worktree = path.join(f.directory, 'linked');
  await git('worktree', 'add', '-b', 'linked-test', worktree);
  f.config.projects.push({ ...f.config.projects[0]!, id: 'linked', root: worktree });
  const tools = new Tools(f.config);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  assert.equal((await tools.invoke('git_branches', { projectId: 'linked' }, principal)).isError, true);
  f.config.projects[1]!.gitCommonDir = path.join(f.root, '.git');
  const linked = await tools.invoke('git_branches', { projectId: 'linked' }, principal);
  assert.ok(!linked.isError, linked.content[0]!.text); assert.equal(value(linked).branch, 'linked-test');
  assert.ok(!(await caller(tools)('git_switch_branch', { branch: 'feature/safe', create: true })).isError);
  await writeFile(path.join(f.root, 'dirty.txt'), 'user changes');
  assert.equal(value(await caller(tools)('git_switch_branch', { branch: 'feature/blocked', create: true })).error, 'dirty_worktree');
});
