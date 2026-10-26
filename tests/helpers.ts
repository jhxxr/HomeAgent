import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { runnerConfigSchema, type RunnerConfig } from '../src/runner/config.js';

export async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'homeagent-test-'));
  const root = path.join(directory, 'workspace'), stateDir = path.join(directory, 'state'), outside = path.join(directory, 'outside');
  await Promise.all([mkdir(root), mkdir(stateDir), mkdir(outside)]);
  const config: RunnerConfig = runnerConfigSchema.parse({ server: 'http://localhost:3210', name: 'test-device', stateDir, projects: [{ id: 'workspace', name: 'Workspace', root, commands: [process.execPath], allowGitWrite: true }] });
  return { directory, root, stateDir, outside, config, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
export async function waitFor<T>(callback: () => T | Promise<T>, timeoutMs = 8000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { const value = await callback(); if (value) return value as NonNullable<T>; await delay(30); }
  throw new Error('Timed out waiting for condition');
}
export async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
