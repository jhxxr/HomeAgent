import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { defaultRunnerConfigPath, rememberRunnerConfigPath, resolveRunnerConfigPath, runnerConfigLocationPath } from '../src/runner/config-location.js';
import { loadRunnerConfig, saveRunnerSettings } from '../src/runner/config.js';
import { fixture } from './helpers.js';

test('Runner finds its saved configuration across working directories and explicit paths override it', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const home = path.join(f.directory, 'profile'), cwd = path.join(f.directory, 'current');
  const custom = path.join(f.directory, 'custom runner.json'), standard = defaultRunnerConfigPath(home), legacy = path.join(cwd, 'runner.local.json');
  await Promise.all([mkdir(path.dirname(standard), { recursive: true }), mkdir(cwd)]);
  await Promise.all([writeFile(standard, '{}'), writeFile(legacy, '{}'), writeFile(custom, '{}')]);
  assert.equal(await resolveRunnerConfigPath(undefined, { home, cwd }), standard);
  await rememberRunnerConfigPath(custom, home);
  assert.equal(await resolveRunnerConfigPath(undefined, { home, cwd }), custom);
  assert.equal(await resolveRunnerConfigPath(undefined, { home, cwd: f.outside }), custom);
  assert.deepEqual(JSON.parse(await readFile(runnerConfigLocationPath(home), 'utf8')), { config: custom });
  assert.equal(await resolveRunnerConfigPath('runner.local.json', { home, cwd }), legacy);
  // An explicit missing file must not select a different device's saved configuration.
  const missing = await resolveRunnerConfigPath('missing.json', { home, cwd });
  await assert.rejects(loadRunnerConfig(missing, {}), { code: 'ENOENT' });
  await unlink(runnerConfigLocationPath(home));
  await unlink(standard);
  await assert.rejects(resolveRunnerConfigPath(undefined, { home, cwd }), /homeagent login/, 'Current-directory configuration must never be loaded implicitly');
  await unlink(legacy);
  await assert.rejects(resolveRunnerConfigPath(undefined, { home, cwd }), /homeagent login/);
});

test('a stale or corrupt saved location fails clearly instead of silently switching to a different device', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const home = path.join(f.directory, 'profile'), cwd = f.outside;
  const custom = path.join(f.directory, 'moved.json'), standard = defaultRunnerConfigPath(home);
  await rememberRunnerConfigPath(custom, home);
  await writeFile(standard, '{}');
  await assert.rejects(resolveRunnerConfigPath(undefined, { home, cwd }), /moved or removed/);
  assert.equal(await resolveRunnerConfigPath(standard, { home, cwd }), standard);
  for (const invalid of ['{', 'null', JSON.stringify({ config: 'relative.json' }), JSON.stringify({ config: 12 })]) {
    await writeFile(runnerConfigLocationPath(home), invalid);
    await assert.rejects(resolveRunnerConfigPath(undefined, { home, cwd }), /location is invalid/);
  }
  await writeFile(custom, '{invalid');
  await rememberRunnerConfigPath(custom, home);
  await assert.rejects(loadRunnerConfig(await resolveRunnerConfigPath(undefined, { home, cwd }), {}), SyntaxError);
});

test('Runner connection settings reject local project configuration and the obsolete roots environment variable', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const filename = path.join(f.directory, 'runner.json');
  const input = { server: 'http://localhost:3210', name: 'web-managed', stateDir: f.stateDir };
  await writeFile(filename, JSON.stringify(input));
  const config = await loadRunnerConfig(filename, {});
  assert.deepEqual(config.projects, []);
  for (const fields of [{ projects: [] }, { allowRemotePermissions: false }, { projects: [{ root: f.root }] }]) {
    await writeFile(filename, JSON.stringify({ ...input, ...fields }));
    await assert.rejects(loadRunnerConfig(filename, {}), /no longer supported/);
  }
  await writeFile(filename, JSON.stringify(input));
  await assert.rejects(loadRunnerConfig(filename, { ALLOWED_ROOTS: JSON.stringify([f.root]) }), /no longer supported/);
});

test('saving settings validates first, protects existing files during creation and excludes local grants', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const filename = path.join(f.directory, 'settings.json');
  const initial = { server: 'https://example.com/', name: 'demo', stateDir: f.stateDir };
  await saveRunnerSettings(filename, initial, true);
  const before = await readFile(filename, 'utf8');
  await assert.rejects(saveRunnerSettings(filename, { ...initial, server: 'http://public.example.com' }));
  await assert.rejects(saveRunnerSettings(filename, { ...initial, maxProcesses: 65 }));
  await assert.rejects(saveRunnerSettings(filename, { ...initial, projects: [] }));
  await assert.rejects(saveRunnerSettings(filename, { ...initial, name: 'replacement' }, true), { code: 'EEXIST' });
  assert.equal(await readFile(filename, 'utf8'), before);
  await saveRunnerSettings(filename, { ...initial, maxProcesses: 4 });
  assert.equal((await loadRunnerConfig(filename, {})).maxProcesses, 4);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).server, 'https://example.com');
});
