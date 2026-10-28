import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RUNNER_PROTOCOL, VERSION } from '../src/shared/protocol.js';
import { versionBanner } from '../src/shared/version.js';
import { dashboard } from '../src/server/dashboard.js';
import { compareVersions, normalizeVersion, versionStatus } from '../public/version.js';
import { createHomeServer } from '../src/server/app.js';
import { fixture, freePort } from './helpers.js';

test('runtime version matches package metadata and is surfaced by the CLIs and Dashboard', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, manifest.version);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[''].version, VERSION);
  assert.match(VERSION, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  const runnerBanner = versionBanner('Runner');
  assert.ok(runnerBanner.includes(`HomeAgent Runner v${VERSION}`));
  assert.ok(runnerBanner.includes(process.version));
  assert.ok(versionBanner('Server').includes(process.platform));
  assert.ok(dashboard.includes(`Server v${VERSION}`));
  assert.ok(dashboard.includes('id="serverVersion"'));
  assert.ok(dashboard.includes('id="versions"'));
});

test('version helpers compare semantic versions and flag Runner/Server mismatches', () => {
  assert.equal(normalizeVersion('v0.4.8'), '0.4.8');
  assert.equal(compareVersions('0.4.8', 'v0.4.8'), 0);
  assert.ok(compareVersions('0.4.7', '0.4.8') < 0);
  assert.ok(compareVersions('0.5.0', '0.4.8') > 0);
  assert.ok(compareVersions('0.4.8-rc.1', '0.4.8') < 0);
  assert.equal(compareVersions('not-a-version', '0.4.8'), null);
  assert.equal(versionStatus('0.4.8', '0.4.8').state, 'match');
  assert.equal(versionStatus('0.4.8', '0.4.7').state, 'outdated');
  assert.equal(versionStatus('0.4.8', '0.5.0').state, 'ahead');
  assert.equal(versionStatus('0.4.8', undefined).state, 'unknown');
});

test('authenticated state and health endpoints expose the Server version', async t => {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'version.sqlite'), password: 'version-test-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 1 });
  await relay.listen();
  t.after(async () => { await relay.close(); await f.cleanup(); });
  const health = await (await fetch(base + '/health')).json() as { version: string; runnerProtocol: number };
  assert.equal(health.version, VERSION);
  assert.equal(health.runnerProtocol, RUNNER_PROTOCOL);
  const login = await fetch(base + '/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'version-test-password' }), redirect: 'manual' });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as { version: string; runnerProtocol: number; runtime: { node: string } };
  assert.equal(state.version, VERSION);
  assert.equal(state.runnerProtocol, RUNNER_PROTOCOL);
  assert.equal(state.runtime.node, process.version);
  const page = await (await fetch(base + '/', { headers: { cookie } })).text();
  assert.ok(page.includes(`Server v${VERSION}`));
  assert.ok(page.includes('id="versions"'));
});
