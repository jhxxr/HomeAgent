import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHomeServer } from '../src/server/app.js';
import { Store, type Device } from '../src/server/store.js';
import { configuredProjects, knownProjectIds } from '../src/server/projects.js';
import { permissionState } from '../src/server/permissions.js';
import { projectGranted } from '../src/shared/protocol.js';
import { fixture, freePort, setDeviceProjects } from './helpers.js';

async function setup(t: TestContext) {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const server = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'server.sqlite'), password: 'project-test-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 1 });
  await server.listen();
  t.after(async () => { await server.close(); await f.cleanup(); });
  const deviceId = randomUUID(), family = randomUUID();
  server.store.put('devices', deviceId, { id: deviceId, name: 'test', revoked: false, paused: false, projects: [], platform: '', lastSeen: 0, created: Date.now(), runnerProtocol: 2 });
  setDeviceProjects(server.store, deviceId, f.config);
  const raw = server.store.mintToken({ id: 'owner', kind: 'pat', family, clientId: 'test', scopes: ['read'], devices: [deviceId], projects: null, projectGrants: { [deviceId]: ['workspace', 'b'] }, expires: Date.now() + 60000 });
  const login = await fetch(base + '/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'project-test-password' }), redirect: 'manual' });
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as any;
  const post = (route: string, body: object) => fetch(base + route, { method: 'POST', headers: { origin: base, cookie, 'x-csrf-token': state.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { f, server, deviceId, family, raw, post };
}

test('removed project IDs cannot be reused even with stale applied projects and survive database reopening', async t => {
  const { f, server, deviceId, raw, post } = await setup(t);
  const device = server.store.get<Device>('devices', deviceId)!;
  device.projects = f.config.projects; server.store.put('devices', deviceId, device);
  const save = (revision: number, projects: any[]) => post(`/api/devices/${deviceId}/permissions`, { expectedRevision: revision, projects, durationMinutes: null });
  assert.equal((await save(0, [])).status, 200);
  const retired = await save(1, f.config.projects);
  assert.equal(retired.status, 400); assert.equal((await retired.json() as any).error, 'project_id_retired');
  const fresh = { ...f.config.projects[0], id: 'fresh-project' };
  assert.equal((await save(1, [fresh])).status, 200);
  assert.equal(projectGranted(server.store.token(raw)!, deviceId, fresh.id), false);
  assert.equal((await save(2, [{ ...fresh, name: 'Renamed', root: f.outside }])).status, 200);
  const reopened = new Store(path.join(f.directory, 'server.sqlite'));
  try {
    const restored = reopened.get<Device>('devices', deviceId)!;
    assert.ok(knownProjectIds(reopened, restored).has('workspace'));
    assert.equal(configuredProjects(restored).some(project => project.id === 'workspace'), false);
  }
  finally { reopened.close(); }
  assert.equal(JSON.stringify(server.hub.devices(server.store.token(raw)!)).includes('knownProjectIds'), false);
});

test('editing a client grant retains temporarily hidden and unapplied projects but rejects new unknown IDs', async t => {
  const { f, server, deviceId, family, raw, post } = await setup(t);
  const a = f.config.projects[0]!, b = { ...a, id: 'b', name: 'B', root: f.outside };
  const device = server.store.get<Device>('devices', deviceId)!;
  device.permanentProjects = [a, b];
  device.permissions = { revision: 1, projects: [a], expiresAt: Date.now() + 60000, fallbackProjects: [a, b] };
  device.projects = [a]; device.permissionAppliedRevision = 1;
  server.store.put('devices', deviceId, device);
  const grant = permissionState(server.store).authorizations[0]!.permissions;
  assert.deepEqual(grant.projectGrants[deviceId], ['workspace', 'b']);
  assert.equal(server.hub.devices()[0]!.projectCatalog?.find(p => p.id === 'b')?.status, 'fallback');
  grant.scopes = ['read', 'write'];
  const save = (revision: number, permissions: any) => post(`/api/authorizations/${family}/permissions`, { expectedRevision: revision, permissions, durationMinutes: null });
  assert.equal((await save(0, grant)).status, 200);
  assert.deepEqual(server.store.token(raw)!.projectGrants?.[deviceId], ['workspace', 'b']);
  device.projects = []; device.permissionError = 'missing directory'; server.store.put('devices', deviceId, device);
  assert.deepEqual(permissionState(server.store).authorizations[0]!.permissions.projectGrants[deviceId], ['workspace', 'b']);
  assert.equal((await save(1, { ...grant, projectGrants: { [deviceId]: ['workspace', 'b', 'unknown'] } })).status, 400);
  device.permanentProjects = [a]; device.permissions = { revision: 2, projects: [a], expiresAt: null, fallbackProjects: [a] };
  server.store.put('devices', deviceId, device);
  assert.equal((await save(1, grant)).status, 200, 'Removed selections can round-trip without granting a new unknown identity');
  assert.equal((await save(2, { ...grant, projectGrants: { [deviceId]: ['workspace'] } })).status, 200);
  assert.deepEqual(server.store.token(raw)!.projectGrants?.[deviceId], ['workspace']);
});

test('history keeps expired temporary identities but allows permanent fallback and respects device-qualified grants', async t => {
  const { f, server, deviceId, post } = await setup(t), device = server.store.get<Device>('devices', deviceId)!;
  const a = f.config.projects[0]!, temporary = { ...a, id: 'temporary' };
  device.permissions = { revision: 1, projects: [temporary], expiresAt: Date.now() - 1, fallbackProjects: [a] };
  assert.deepEqual(configuredProjects(device).map(project => project.id), ['workspace']);
  assert.ok(knownProjectIds(server.store, device).has('temporary'));
  const other = randomUUID();
  server.store.mintToken({ id: 'other', kind: 'pat', clientId: 'other', family: randomUUID(), scopes: ['read'], devices: [other], projects: ['other-only'], expires: Date.now() + 60000 });
  assert.equal(knownProjectIds(server.store, device).has('other-only'), false);
  assert.ok(knownProjectIds(server.store, device).has('b'), 'Dangling explicit grants bootstrap legacy identity history');
  server.store.put('devices', deviceId, device);
  const save = (projects: any[]) => post(`/api/devices/${deviceId}/permissions`, { expectedRevision: 1, projects, durationMinutes: null });
  assert.equal((await save([temporary])).status, 400, 'An expired temporary-only ID is retired');
  assert.equal((await save([{ ...a, id: 'b' }])).status, 400, 'An old dangling grant must not attach to a new project');
  assert.equal((await save([a])).status, 200, 'The permanent fallback keeps its identity');
});
