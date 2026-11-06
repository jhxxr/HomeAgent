import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, link, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Memory, resolveWorkspacePath } from '../src/runner/memory.js';
import { Tools } from '../src/runner/tools.js';
import { fixture } from './helpers.js';
import type { Principal, ToolResult } from '../src/shared/protocol.js';

const owner: Principal = { id: 'worker', scopes: ['read', 'write'], devices: null, projects: null };
const body = (value: ToolResult) => JSON.parse(value.content[0]!.text);
const entry = { globs: ['src/**', '*.txt'], severity: 'critical', source: 'regression-test' };

async function memoryFixture() {
  const f = await fixture();
  const directory = path.join(f.directory, 'memory', 'workspace');
  const pitfalls = path.join(directory, 'pitfalls');
  await mkdir(pitfalls, { recursive: true });
  await writeFile(path.join(pitfalls, '_index.json'), JSON.stringify({ 'note.md': entry }));
  await writeFile(path.join(pitfalls, 'note.md'), 'Remember the edge case.');
  return { ...f, directory: f.directory, memoryDir: directory, pitfalls, memory: new Memory(f.directory) };
}

// These tests use the same node:test runner as the rest of the project.
test('workspace discovery uses ESM fs access and respects environment precedence', async t => {
  const f = await fixture();
  const previous = process.env.HOMEAGENT_WORKSPACE;
  t.after(async () => {
    if (previous === undefined) delete process.env.HOMEAGENT_WORKSPACE; else process.env.HOMEAGENT_WORKSPACE = previous;
    await f.cleanup();
  });
  delete process.env.HOMEAGENT_WORKSPACE;
  assert.equal(resolveWorkspacePath(f.directory), path.join(os.homedir(), '.homeagent', 'workspace'));
  await writeFile(path.join(f.directory, 'workspace.json'), '{}');
  assert.equal(resolveWorkspacePath(f.directory), f.directory);
  process.env.HOMEAGENT_WORKSPACE = f.outside;
  assert.equal(resolveWorkspacePath(f.directory), f.outside);
});

test('charter truncation uses bytes and does not split UTF-8 codepoints', async t => {
  const f = await memoryFixture(); t.after(f.cleanup);
  const filename = path.join(f.memoryDir, 'charter.md');
  for (const [text, truncated] of [['a'.repeat(8191), false], ['a'.repeat(8192), false], ['a'.repeat(8193), true], ['中'.repeat(3000), true], ['😀'.repeat(3000), true]] as const) {
    await writeFile(filename, text);
    const charter = await f.memory.charter('workspace');
    assert.ok(charter);
    assert.equal(charter.truncated, truncated);
    assert.ok(Buffer.byteLength(charter.text) <= 8192);
    assert.ok(!charter.text.includes('\ufffd'));
    assert.ok(text.startsWith(charter.text));
  }
});

test('memory matches POSIX globs after normalizing Windows paths and dot prefixes', async t => {
  const f = await memoryFixture(); t.after(f.cleanup);
  const hints = await f.memory.match('workspace', ['./src/a.ts', '.\\src\\b.ts', 'src/nested/../c.ts', 'other.ts']);
  assert.equal(hints.length, 1);
  assert.deepEqual(hints[0]!.matchedPaths, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(hints[0]!.severity, 'critical');
});

test('malicious index filenames, malformed entries and invalid project IDs cannot disclose files', async t => {
  const f = await memoryFixture(); t.after(f.cleanup);
  await writeFile(path.join(f.directory, 'secret.txt'), 'TOP SECRET');
  const invalid = ['../../../secret.txt', '..\\..\\..\\secret.txt', path.join(f.directory, 'secret.txt'), 'C:\\secret.txt', 'note.md:stream', 'note.md.', 'NUL', 'sub/note.md'];
  await writeFile(path.join(f.pitfalls, '_index.json'), JSON.stringify({
    ...Object.fromEntries(invalid.map(file => [file, entry])),
    'null.md': null, 'malformed.md': { globs: [12] }, 'note.md': entry,
  }));
  const hints = await f.memory.match('workspace', ['src/a.ts']);
  assert.deepEqual(hints.map(hint => hint.file), ['note.md']);
  assert.ok(!JSON.stringify(hints).includes('TOP SECRET'));
  for (const id of ['../workspace', '..\\workspace', '.', '..', 'x/y', 'C:\\workspace', 'NUL']) {
    assert.deepEqual(await f.memory.match(id, ['src/a.ts']), [], id);
    assert.equal(await f.memory.charter(id), null, id);
  }
});

test('memory rejects linked files and directory junctions including cached indexes', async t => {
  for (const target of ['note.md', '_index.json', 'charter.md', 'pitfalls', 'project', 'memory']) {
    await t.test(target, async () => {
      const f = await memoryFixture();
      try {
        await writeFile(path.join(f.memoryDir, 'charter.md'), 'charter');
        assert.equal((await f.memory.match('workspace', ['src/a.ts'])).length, 1);
        if (target === 'note.md' || target === '_index.json' || target === 'charter.md') {
          const location = path.join(target === 'charter.md' ? f.memoryDir : f.pitfalls, target);
          const outside = path.join(f.outside, target);
          await rename(location, outside);
          await link(outside, location);
        } else {
          const location = target === 'pitfalls' ? f.pitfalls : target === 'project' ? f.memoryDir : path.dirname(f.memoryDir);
          const outside = path.join(f.outside, 'redirect');
          await rename(location, outside);
          await symlink(outside, location, process.platform === 'win32' ? 'junction' : 'dir');
        }
        if (target === 'charter.md' || target === 'project' || target === 'memory') assert.equal(await f.memory.charter('workspace'), null);
        if (target !== 'charter.md') assert.deepEqual(await f.memory.match('workspace', ['src/a.ts']), []);
      } finally { await f.cleanup(); }
    });
  }
});

test('single-file tools inject L2 hints and context propagates charter truncation', async t => {
  const f = await memoryFixture();
  const previous = process.env.HOMEAGENT_WORKSPACE;
  delete process.env.HOMEAGENT_WORKSPACE;
  await writeFile(path.join(f.directory, 'workspace.json'), '{}');
  // A custom state directory name must still find the sibling workspace.json.
  f.config.stateDir = path.join(f.directory, 'custom-runtime');
  await mkdir(f.config.stateDir);
  const tools = new Tools(f.config);
  t.after(async () => {
    if (previous === undefined) delete process.env.HOMEAGENT_WORKSPACE; else process.env.HOMEAGENT_WORKSPACE = previous;
    await tools.close(); await f.cleanup();
  });
  const call = (name: string, args: object) => tools.invoke(name, { projectId: 'workspace', ...args }, owner);
  for (const [name, args] of [
    ['write_file', { path: 'a.txt', content: 'before' }],
    ['read_file', { path: 'a.txt' }],
    ['edit_block', { path: 'a.txt', oldText: 'before', newText: 'after' }],
  ] as const) {
    const response = await call(name, args);
    assert.ok(!response.isError, JSON.stringify(response));
    assert.equal(body(response).memoryHints[0].file, 'note.md', name);
  }
  await writeFile(path.join(f.memoryDir, 'charter.md'), '中'.repeat(3000));
  const context = body(await call('get_project_context', {}));
  assert.equal(context.instructions.find((item: { path: string }) => item.path === 'memory/charter.md').truncated, true);
  const noInstructions = body(await call('get_project_context', { includeInstructions: false }));
  assert.deepEqual(noInstructions.instructions, []);
});
