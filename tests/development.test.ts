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

test('fuzzy unified diffs relocate shifted hunks, support optional whitespace tolerance and reject ambiguous matches', async t => {
  const f = await fixture(), tools = new Tools(f.config), call = caller(tools);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  const initial = ['line 1', 'line 2', 'line 3', 'line 4', 'target before', 'target mid', 'target after', 'line 8', ''].join('\n');
  await writeFile(path.join(f.root, 'fuzzy.txt'), initial);
  // Header claims line 2, but target block actually starts at line 5 (offset +3).
  const shiftedDiff = '--- a/fuzzy.txt\n+++ b/fuzzy.txt\n@@ -2,3 +2,3 @@\n target before\n-target mid\n+target updated\n target after\n';
  const strictRejected = await call('apply_unified_diff', { diff: shiftedDiff, expectedSha256: { 'fuzzy.txt': sha256(initial) }, fuzz: 0 });
  assert.equal(value(strictRejected).error, 'patch_context');

  const applied = value(await call('apply_unified_diff', { diff: shiftedDiff, expectedSha256: { 'fuzzy.txt': sha256(initial) }, fuzz: 10 }));
  assert.equal(applied.state, 'completed');
  assert.equal(applied.relocatedHunks.length, 1);
  assert.deepEqual(applied.relocatedHunks[0], { path: 'fuzzy.txt', hunkIndex: 1, expectedLine: 2, appliedLine: 5, offset: 3 });
  const updatedText = await readFile(path.join(f.root, 'fuzzy.txt'), 'utf8');
  assert.ok(updatedText.includes('target before\ntarget updated\ntarget after'));

  // Whitespace-tolerant matching
  const wsDiff = '--- a/fuzzy.txt\n+++ b/fuzzy.txt\n@@ -5,3 +5,3 @@\n   target before   \n-  target updated  \n+target final\n   target after\n';
  assert.equal(value(await call('apply_unified_diff', { diff: wsDiff, expectedSha256: { 'fuzzy.txt': sha256(updatedText) }, ignoreWhitespace: false })).error, 'patch_context');
  const wsApplied = value(await call('apply_unified_diff', { diff: wsDiff, expectedSha256: { 'fuzzy.txt': sha256(updatedText) }, ignoreWhitespace: true }));
  assert.equal(wsApplied.state, 'completed');
  assert.equal(wsApplied.relocatedHunks[0].whitespaceNormalized, true);

  // Ambiguous hunk within fuzz window must be rejected
  const duplicateContent = ['dup context', 'old value', 'dup end', 'middle', 'dup context', 'old value', 'dup end', ''].join('\n');
  await writeFile(path.join(f.root, 'dup.txt'), duplicateContent);
  const ambiguousDiff = '--- a/dup.txt\n+++ b/dup.txt\n@@ -3,3 +3,3 @@\n dup context\n-old value\n+new value\n dup end\n';
  const ambiguous = await call('apply_unified_diff', { diff: ambiguousDiff, expectedSha256: { 'dup.txt': sha256(duplicateContent) }, fuzz: 10 });
  assert.equal(value(ambiguous).error, 'ambiguous_patch');
});

test('persistent shell sessions enforce command policy and preserve working directory, variables and exit codes across commands', async t => {
  const f = await fixture();
  await mkdir(path.join(f.root, 'sub'));
  const tools = new Tools(f.config), call = caller(tools);
  t.after(async () => { await tools.close(); await f.cleanup(); });

  // Disallowed when shell executable is not in allowlist
  const denied = await call('start_shell', {});
  assert.equal(value(denied).error, 'command_denied');

  const shellExec = process.platform === 'win32' ? 'powershell.exe' : 'sh';
  f.config.projects[0]!.commands.push(shellExec);

  const started = value(await call('start_shell', { shell: shellExec }));
  assert.ok(started.sessionId);
  assert.equal(started.state, 'ready');

  const step1Cmd = process.platform === 'win32'
    ? '$env:HA_PERSIST = "kept_value"; Set-Location sub; Write-Output "step1:$env:HA_PERSIST"'
    : 'export HA_PERSIST="kept_value"; cd sub; echo "step1:$HA_PERSIST"';
  const step1 = value(await call('run_shell', { sessionId: started.sessionId, command: step1Cmd }));
  assert.equal(step1.state, 'ready');
  assert.equal(step1.exitCode, 0);
  assert.ok(step1.output.includes('step1:kept_value'), step1.output);
  assert.equal(path.basename(step1.cwd), 'sub');

  const step2Cmd = process.platform === 'win32'
    ? 'Write-Output "step2:$env:HA_PERSIST"; cmd /c "exit /b 7"'
    : 'echo "step2:$HA_PERSIST"; (exit 7)';
  const step2 = value(await call('run_shell', { sessionId: started.sessionId, command: step2Cmd }));
  assert.equal(step2.state, 'ready');
  assert.equal(step2.exitCode, 7);
  assert.ok(step2.output.includes('step2:kept_value'), step2.output);
  assert.equal(path.basename(step2.cwd), 'sub');

  const shells = value(await call('list_shells'));
  assert.equal(shells.length, 1);
  assert.equal(shells[0].sessionId, started.sessionId);
  assert.equal(shells[0].lastExitCode, 7);
  assert.equal(path.basename(shells[0].cwd), 'sub');

  const stopped = value(await call('stop_shell', { sessionId: started.sessionId }));
  assert.equal(stopped.finished, true);
});

test('LSP tools extract symbols, resolve cross-file definitions, find references, show hover docs and report diagnostics', async t => {
  const f = await fixture(), tools = new Tools(f.config), call = caller(tools);
  t.after(async () => { await tools.close(); await f.cleanup(); });

  await writeFile(
    path.join(f.root, 'math.ts'),
    [
      '/** Computes the sum of two numbers with tax. */',
      'export function computeTotal(price: number, tax: number): number {',
      '  return price + tax;',
      '}',
      '',
      'export class InvoiceCalculator {',
      '  format(amount: number): string {',
      '    return String(computeTotal(amount, 1));',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(f.root, 'app.ts'),
    [
      "import { computeTotal } from './math.js';",
      "import { missingHelper } from './nonexistent.js';",
      '// computeTotal in a comment must be ignored by references',
      'export const result = computeTotal(10, 2);',
      'export const computeTotalExtra = 99;',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(f.root, 'broken.json'), '{ "unclosed": 1 ');

  const docSyms = value(await call('lsp_document_symbols', { path: 'math.ts' }));
  assert.equal(docSyms.symbols.some((s: any) => s.name === 'computeTotal' && s.kind === 'function' && s.exported === true), true);
  assert.equal(docSyms.symbols.some((s: any) => s.name === 'InvoiceCalculator' && s.kind === 'class'), true);
  assert.equal(docSyms.symbols.some((s: any) => s.name === 'format' && s.kind === 'method' && s.containerName === 'InvoiceCalculator'), true);

  const wsSyms = value(await call('lsp_workspace_symbols', { query: 'computeTotal', respectGitIgnore: false }));
  assert.ok(wsSyms.symbols.some((s: any) => s.name === 'computeTotal' && s.path === 'math.ts'));

  // Resolve cross-file definition from import usage at line 4 of app.ts
  const def = value(await call('lsp_definition', { path: 'app.ts', line: 4, column: 24, respectGitIgnore: false }));
  assert.equal(def.symbol, 'computeTotal');
  assert.equal(def.resolvedVia, 'import');
  assert.equal(def.definitions[0].path, 'math.ts');
  assert.equal(def.definitions[0].line, 2);

  // Hover returns signature and JSDoc
  const hover = value(await call('lsp_hover', { path: 'app.ts', line: 4, column: 24, respectGitIgnore: false }));
  assert.equal(hover.found, true);
  assert.ok(hover.documentation.includes('Computes the sum of two numbers'));
  assert.ok(hover.signature.includes('computeTotal(price: number, tax: number)'));

  // References find exact identifier occurrences across files (excluding comments and computeTotalExtra)
  const refs = value(await call('lsp_references', { path: 'math.ts', symbol: 'computeTotal', respectGitIgnore: false }));
  assert.equal(refs.references.every((r: any) => !r.text.includes('computeTotalExtra') && !r.text.trim().startsWith('//')), true);
  assert.equal(refs.references.some((r: any) => r.path === 'math.ts' && r.isDeclaration === true), true);
  assert.equal(refs.references.some((r: any) => r.path === 'app.ts' && r.isImport === true), true);
  assert.equal(refs.references.some((r: any) => r.path === 'app.ts' && r.line === 4), true);

  // Built-in diagnostics report unresolved relative import and invalid JSON
  const diags = value(await call('lsp_diagnostics', { respectGitIgnore: false }));
  assert.equal(diags.diagnostics.some((d: any) => d.path === 'app.ts' && d.code === 'unresolved_import'), true);
  assert.equal(diags.diagnostics.some((d: any) => d.path === 'broken.json' && d.code === 'json_syntax'), true);

  // External stdio JSON-RPC LSP server diagnostics support
  const fakeLspServer = path.join(f.directory, 'fake-lsp.mjs');
  await writeFile(
    fakeLspServer,
    `let buf = Buffer.alloc(0);
function send(msg) { const b = Buffer.from(JSON.stringify(msg)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); }
process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const idx = buf.indexOf('\\r\\n\\r\\n');
    if (idx < 0) break;
    const len = Number(/Content-Length:\\s*(\\d+)/i.exec(buf.subarray(0, idx).toString())[1]);
    if (buf.length < idx + 4 + len) break;
    const msg = JSON.parse(buf.subarray(idx + 4, idx + 4 + len).toString());
    buf = buf.subarray(idx + 4 + len);
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
    if (msg.method === 'textDocument/didOpen') send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: msg.params.textDocument.uri, diagnostics: [{ range: { start: { line: 1, character: 4 } }, severity: 1, code: 'EXT001', source: 'fake-lsp', message: 'External LSP diagnostic' }] } });
  }
});`,
  );
  const externalDiags = value(await call('lsp_diagnostics', { path: 'math.ts', serverExecutable: process.execPath, serverArgs: [fakeLspServer] }));
  assert.equal(externalDiags.engine, 'external-lsp');
  assert.equal(externalDiags.diagnostics.length, 1);
  assert.equal(externalDiags.diagnostics[0].code, 'EXT001');
  assert.equal(externalDiags.diagnostics[0].line, 2);
});
