import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHomeServer } from '../src/server/app.js';
import { Agent } from '../src/runner/agent.js';
import { loadRunnerConfig } from '../src/runner/config.js';
import type { Device } from '../src/server/store.js';
import { fixture, freePort, waitFor } from './helpers.js';

test('browser approval link authorizes a pending Runner pairing', async t => {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({
    host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'pair-link.sqlite'),
    password: 'pair-link-admin-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 1,
  });
  await relay.listen();
  t.after(async () => { await relay.close(); await f.cleanup(); });

  const startResponse = await fetch(base + '/pair/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'link-device' }),
  });
  assert.equal(startResponse.status, 201);
  const start = await startResponse.json() as { id: string; pollToken: string; verificationUrl: string };
  const anonymous = await fetch(start.verificationUrl, { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.get('location') ?? '', /^\/login\?next=/);
  const login = await fetch(base + '/login', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pair-link-admin-password' }), redirect: 'manual',
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as { csrf: string };

  const pending = await fetch(start.verificationUrl, { headers: { cookie } });
  assert.equal(pending.status, 200);
  assert.match(await pending.text(), /link-device/);

  const url = new URL(start.verificationUrl);
  const approved = await fetch(start.verificationUrl, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: start.id, token: url.searchParams.get('token')!, _csrf: state.csrf }),
    redirect: 'manual',
  });
  assert.equal(approved.status, 303);
  assert.equal((await (await fetch(start.verificationUrl, { headers: { cookie } })).text()).includes('设备已批准'), true);

  const claimed = await fetch(base + '/pair/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: start.id, pollToken: start.pollToken }),
  });
  assert.equal(claimed.status, 200);
  assert.equal((await fetch(base + '/pair/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: start.id, pollToken: start.pollToken }),
  })).status, 401);
  assert.ok(!JSON.stringify(relay.store.all('pairings')).includes(url.searchParams.get('token')!));
});

test('a device without local projects receives Web-only project paths, persists Server edits and restores no access', async t => {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({
    host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'web-projects.sqlite'),
    password: 'web-project-admin-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 1,
  });
  let agent: Agent | undefined;
  await relay.listen();
  t.after(async () => { await agent?.close(); await relay.close(); await f.cleanup(); });
  const post = (url: string, body: object, headers: Record<string, string> = {}) => fetch(base + url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual',
  });
  const start = await (await post('/pair/start', { name: 'web-project-device' })).json() as { id: string; pollToken: string; verificationUrl: string };
  const login = await post('/login', { password: 'web-project-admin-password' }, { origin: base });
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as { csrf: string };
  const headers = { cookie, origin: base, 'x-csrf-token': state.csrf };
  assert.match(await (await fetch(start.verificationUrl, { headers: { cookie } })).text(), /name="root"/);
  const approve = (root: string) => post('/pair/verify', { id: start.id, token: new URL(start.verificationUrl).searchParams.get('token'), root }, headers);
  assert.equal((await approve('relative/project')).status, 400);
  assert.equal((await post('/pair/claim', { id: start.id, pollToken: start.pollToken })).status, 202);
  assert.equal((await approve(f.root)).status, 303);
  const credential = await (await post('/pair/claim', { id: start.id, pollToken: start.pollToken })).json() as { deviceId: string; token: string };
  assert.equal(relay.store.get<Device>('devices', credential.deviceId)!.permissions!.projects![0]!.root, f.root);

  const filename = path.join(f.directory, 'runner.json');
  const local = JSON.stringify({ server: base, name: 'web-project-device', stateDir: f.stateDir });
  await writeFile(filename, local);
  await writeFile(path.join(f.root, 'marker.txt'), 'initial Web project');
  await writeFile(path.join(f.outside, 'marker.txt'), 'updated Web project');
  const connect = async (revision: number) => {
    const config = await loadRunnerConfig(filename, {});
    assert.deepEqual(config.projects, []);
    agent = new Agent(config, { server: base, ...credential }, () => {});
    agent.start();
    await waitFor(() => relay.store.get<Device>('devices', credential.deviceId)?.permissionAppliedRevision === revision && agent!.config.projects.length === 1);
  };
  const read = async () => {
    const result = await agent!.tools.invoke('read_file', { projectId: 'workspace', path: 'marker.txt' }, { id: 'test', scopes: ['read'], devices: [credential.deviceId], projects: ['workspace'] });
    assert.ok(!result.isError, result.content[0]!.text);
    return JSON.parse(result.content[0]!.text).text;
  };
  await connect(1);
  assert.equal(await read(), 'initial Web project');
  const projects = relay.store.get<Device>('devices', credential.deviceId)!.permissions!.projects!.map(project => ({ ...project, root: f.outside }));
  assert.equal((await post(`/api/devices/${credential.deviceId}/permissions`, { expectedRevision: 1, projects, durationMinutes: null }, headers)).status, 200);
  await waitFor(() => relay.store.get<Device>('devices', credential.deviceId)?.permissionAppliedRevision === 2);
  assert.equal(await read(), 'updated Web project');
  assert.equal(await readFile(filename, 'utf8'), local, 'Web project paths must not be written to the local Runner configuration');
  await agent!.close();
  await connect(2);
  assert.equal(await read(), 'updated Web project');
  assert.equal((await post(`/api/devices/${credential.deviceId}/permissions`, { expectedRevision: 2, projects: [], durationMinutes: null }, headers)).status, 200);
  await waitFor(() => relay.store.get<Device>('devices', credential.deviceId)?.permissionAppliedRevision === 3);
  assert.deepEqual(agent!.config.projects, []);
});
