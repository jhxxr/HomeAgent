import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Tools } from '../src/runner/tools.js';
import { fixture, waitFor } from './helpers.js';
import type { Principal, ToolResult } from '../src/shared/protocol.js';
import { loadRunnerConfig } from '../src/runner/config.js';
import { RunnerPermissions } from '../src/runner/permissions.js';
const exec = promisify(execFile);
const owner: Principal = { id: 'test-owner', scopes: ['read', 'write', 'execute', 'git'], devices: null, projects: null };
const body = (value: ToolResult) => JSON.parse(value.content[0]!.text);

test('file tools enforce scopes, optimistic edits, append, search, move and bounded reads', async t => {
  const f = await fixture(), tools = new Tools(f.config);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  const call = (name: string, args: object, principal = owner) => tools.invoke(name, { projectId: 'workspace', ...args }, principal);
  const written = body(await call('write_file', { path: 'hello.txt', content: 'hello\nworld' }));
  assert.equal(written.written, 11);
  const read = body(await call('read_file', { path: 'hello.txt', offset: 6, length: 5 }));
  assert.equal(read.text, 'world'); assert.equal(read.sha256, written.sha256);
  assert.equal((await call('write_file', { path: 'hello.txt', content: 'oops', expectedSha256: '0'.repeat(64) })).isError, true);
  assert.equal((await call('edit_block', { path: 'hello.txt', oldText: 'world', newText: 'there', expectedSha256: written.sha256 })).isError, undefined);
  await call('write_file', { path: 'hello.txt', content: '!', append: true });
  assert.equal(await readFile(path.join(f.root, 'hello.txt'), 'utf8'), 'hello\nthere!');
  assert.equal(body(await call('search_files', { query: 'THERE', content: true })).matches[0].line, 2);
  await call('create_directory', { path: 'sub/dir' });
  assert.equal((await call('move_file', { source: 'hello.txt', destination: 'sub/dir/a.txt' })).isError, undefined);
  const list = body(await call('list_directory', { path: 'sub/dir' }));
  assert.equal(list.entries[0].name, 'a.txt');
  assert.equal((await call('write_file', { path: 'a', content: 'x' }, { ...owner, scopes: ['read'] })).isError, true);
  assert.equal((await call('read_file', { path: 'sub/dir/a.txt' }, { ...owner, projects: ['other'] })).isError, true);
  f.config.projects[0]!.readOnly = true;
  assert.equal((await call('write_file', { path: 'a', content: 'x' })).isError, true);
});

test('file policy rejects traversal, denied names, junctions/symlinks, hard links and Windows aliases', async t => {
  const f = await fixture(), tools = new Tools(f.config);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  await writeFile(path.join(f.outside, 'secret.txt'), 'private');
  await symlink(f.outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await link(path.join(f.outside, 'secret.txt'), path.join(f.root, 'hard.txt'));
  await mkdir(path.join(f.root, '.git')); await writeFile(path.join(f.root, '.git', 'config'), 'private');
  for (const filename of ['../outside/secret.txt', path.join(f.outside, 'secret.txt'), 'escape/secret.txt', 'hard.txt', '.git/config']) {
    const response = await tools.invoke('read_file', { projectId: 'workspace', path: filename }, owner);
    assert.equal(response.isError, true, filename);
    assert.ok(!response.content[0]!.text.includes('"text":"private"'));
  }
  const response = await tools.invoke('write_file', { projectId: 'workspace', path: 'escape/new.txt', content: 'x' }, owner);
  assert.equal(response.isError, true);
  if (process.platform === 'win32') for (const filename of ['ok.txt:stream', 'NUL', '.git.\\config', 'bad ']) assert.equal((await tools.invoke('write_file', { projectId: 'workspace', path: filename, content: 'x' }, owner)).isError, true);
});

test('Server project policy refuses exposing a directory containing Runner credentials', async t => {
  const f = await fixture();
  const filename = path.join(f.directory, 'runner.json');
  await writeFile(filename, JSON.stringify({ server: f.config.server, stateDir: path.join(f.root, 'credentials') }));
  const config = await loadRunnerConfig(filename, {}), tools = new Tools(config);
  const manager = new RunnerPermissions(config, tools, async () => {}, () => {});
  t.after(async () => { manager.close(); await tools.close(); await f.cleanup(); });
  await assert.rejects(manager.apply({ revision: 1, projects: f.config.projects, expiresAt: null, fallbackProjects: [] }), /Runner state cannot be exposed/);
});

test('subprocesses exclude npm credentials and user or project PowerShell module hooks', async t => {
  const f = await fixture(), tools = new Tools(f.config);
  const previous = { NPM_TOKEN: process.env.NPM_TOKEN, PSModulePath: process.env.PSModulePath };
  process.env.NPM_TOKEN = 'npm_' + 'A'.repeat(36);
  process.env.PSModulePath = path.join(f.root, 'untrusted-modules');
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await tools.close(); await f.cleanup();
  });
  const response = body(await tools.invoke('run_command', {
    projectId: 'workspace', executable: process.execPath, waitMs: 20000,
    args: ['-e', 'console.log(JSON.stringify({npm:!!process.env.NPM_TOKEN,modules:process.env.PSModulePath??null}))'],
  }, owner));
  assert.equal(response.state, 'exited', response.output);
  const environment = JSON.parse(response.output);
  assert.equal(environment.npm, false);
  if (process.platform === 'win32') {
    const allowed = [
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsPowerShell', 'Modules'),
    ].map(directory => path.normalize(directory).toLowerCase());
    const modules = String(environment.modules).split(path.delimiter).filter(Boolean);
    assert.ok(modules.length > 0);
    // WinPS can prepend its machine-wide Program Files modules automatically.
    for (const directory of modules) assert.ok(allowed.includes(path.normalize(directory).toLowerCase()), directory);
  } else assert.equal(environment.modules, null);
});

test('tracked subprocesses use argv, enforce allowlists/ownership, bound output and persist completed metadata', async t => {
  const f = await fixture(); f.config.maxOutputBytes = 65536;
  let tools = new Tools(f.config);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  const call = (name: string, args: object, principal = owner) => tools.invoke(name, { projectId: 'workspace', ...args }, principal);
  assert.equal((await call('start_process', { executable: 'not-permitted' })).isError, true);
  const literal = 'a b;$HOME"\\tail\\';
  const started = body(await call('start_process', { executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1]); process.stdout.write("x".repeat(100000))', literal], timeoutMs: 10000 }));
  const output = await waitFor(async () => { const value = body(await call('read_process_output', { processId: started.id, length: 65536 })); return value.state === 'exited' ? value : undefined; });
  assert.ok(output.output.startsWith(literal)); assert.equal(output.outputBytes, 65536); assert.equal(output.truncated, true);
  assert.equal((await call('read_process_output', { processId: started.id }, { ...owner, id: 'other-client' })).isError, true);
  const second = body(await call('read_process_output', { processId: started.id, cursor: 65530, length: 10 }));
  assert.equal(second.nextCursor, 65536);
  await tools.close(); tools = new Tools(f.config);
  assert.equal(body(await call('list_processes', {}))[0].state, 'exited');
});

test('subprocess stdin, termination and timeout are observable', async t => {
  const f = await fixture(), tools = new Tools(f.config);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  const call = (name: string, args: object) => tools.invoke(name, { projectId: 'workspace', ...args }, owner);
  const input = body(await call('start_process', { executable: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'] }));
  await call('write_process_input', { processId: input.id, input: 'hello stdin', close: true });
  const output = await waitFor(async () => { const value = body(await call('read_process_output', { processId: input.id })); return value.finished ? value : undefined; });
  assert.equal(output.output, 'hello stdin');
  const stopped = body(await call('start_process', { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }));
  await call('stop_process', { processId: stopped.id });
  await waitFor(async () => body(await call('read_process_output', { processId: stopped.id })).finished);
  const timed = body(await call('start_process', { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 200 }));
  const done = await waitFor(async () => { const value = body(await call('read_process_output', { processId: timed.id })); return value.finished ? value : undefined; });
  assert.equal(done.state, 'timed_out');
});

test('Git status/add/commit/log/diff work and hooks/filters cannot execute implicitly', async t => {
  const f = await fixture(), tools = new Tools(f.config);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  await exec('git', ['init', f.root]);
  await exec('git', ['-C', f.root, 'config', 'user.name', 'HomeAgent Test']);
  await exec('git', ['-C', f.root, 'config', 'user.email', 'test@localhost']);
  const call = (name: string, args: object = {}) => tools.invoke(name, { projectId: 'workspace', ...args }, owner);
  await writeFile(path.join(f.root, 'a.txt'), 'initial\n');
  assert.ok((await call('git_status')).content[0]!.text.includes('a.txt'));
  assert.equal((await call('git_add', { paths: ['a.txt'] })).isError, undefined);
  assert.equal((await call('git_commit', { message: 'initial commit' })).isError, undefined);
  assert.ok((await call('git_log')).content[0]!.text.includes('initial commit'));
  await writeFile(path.join(f.root, 'a.txt'), 'changed\n');
  assert.ok((await call('git_diff')).content[0]!.text.includes('+changed'));
  assert.equal((await call('git_add', { paths: ['../outside'] })).isError, true);
  await exec('git', ['-C', f.root, 'config', 'filter.danger.clean', 'echo danger']);
  assert.equal((await call('git_add', { paths: ['a.txt'] })).isError, true);
  await exec('git', ['-C', f.root, 'config', '--unset', 'filter.danger.clean']);
  const included = path.join(f.directory, 'included-git-config');
  await writeFile(included, '[filter "indirect"]\n  clean = echo danger\n');
  await exec('git', ['-C', f.root, 'config', 'include.path', included]);
  assert.equal((await call('git_add', { paths: ['a.txt'] })).isError, true);
  f.config.projects[0]!.allowGitWrite = false;
  assert.equal((await call('git_commit', { message: 'disabled' })).isError, true);
});

test('concurrent process starts cannot bypass the runner process limit', async t => {
  const f = await fixture(); f.config.maxProcesses = 1;
  const tools = new Tools(f.config);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  const responses = await Promise.all(Array.from({ length: 5 }, () => tools.invoke('start_process', { projectId: 'workspace', executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, owner)));
  assert.equal(responses.filter(response => !response.isError).length, 1);
});
