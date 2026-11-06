import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { createHomeServer } from '../src/server/app.js';
import { hash, type Device } from '../src/server/store.js';
import type { KanbanTask } from '../src/server/kanban.js';
import { result } from '../src/shared/protocol.js';
import { fixture, freePort, setDeviceProjects } from './helpers.js';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'kanban-api.sqlite'), password: 'strong-admin-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 90 });
  await relay.listen();
  t.after(async () => { await relay.close(); await f.cleanup(); });
  const id = randomUUID();
  const device: Device = { id, name: 'First device', tokenHash: hash('test'), revoked: false, paused: false, projects: [], platform: 'test', lastSeen: 0, created: Date.now() };
  relay.store.put('devices', id, device); setDeviceProjects(relay.store, id, f.config);
  const login = await fetch(`${base}/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'strong-admin-password' }), redirect: 'manual' });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const { csrf } = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json() as { csrf: string };
  const get = async (route: string) => { const response = await fetch(`${base}/api/kanban${route}`, { headers: { cookie } }); return { status: response.status, body: await response.json() as any }; };
  const post = async (route: string, body: object, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api/kanban${route}`, { method: 'POST', headers: { cookie, origin: base, 'x-csrf-token': csrf, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const create = async (input: object = {}) => {
    const response = await post('/tasks', { projectId: 'workspace', title: 'Work', ...input }); assert.equal(response.status, 201); return response.body.task as KanbanTask;
  };
  const stored = (task: KanbanTask) => relay.store.get<KanbanTask>('tasks', task.id)!;
  return { f, relay, id, base, cookie, csrf, get, post, create, stored };
}

test('Kanban API requires browser session, CSRF and same origin; bearer tokens cannot impersonate admin', async t => {
  const { relay, base, cookie, post } = await setup(t);
  const raw = relay.store.mintToken({ id: 'worker', kind: 'pat', clientId: 'test', family: randomUUID(), scopes: ['read', 'write'], devices: null, projects: null, expires: Date.now() + 60000 });
  for (const route of ['/projects', '/assignees?projectId=workspace', '/board?projectId=workspace', '/tasks?projectId=workspace', '/tasks/TASK-001?projectId=workspace']) {
    assert.equal((await fetch(`${base}/api/kanban${route}`)).status, 401);
    assert.equal((await fetch(`${base}/api/kanban${route}`, { headers: { authorization: `Bearer ${raw}` } })).status, 401);
  }
  const body = { projectId: 'workspace', title: 'Denied' };
  assert.equal((await fetch(`${base}/api/kanban/tasks`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  assert.equal((await post('/tasks', body, { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await post('/tasks', body, { origin: 'https://evil.example' })).status, 403);
  for (const [action, input] of [['assign', { assignee: 'worker', deviceId: randomUUID() }], ['submit', { proposedCommitMessage: 'message', aiSummary: 'summary' }], ['revise', { reason: 'reason' }], ['reopen', { reason: 'reason' }], ['finish', { skipReview: true }]] as const) {
    assert.equal((await post(`/tasks/TASK-001/${action}`, { projectId: 'workspace', expectedRevision: 0, ...input }, { 'x-csrf-token': 'wrong' })).status, 403);
  }
  assert.equal(relay.hub.kanban.list('workspace').length, 0);
  assert.equal(relay.store.audits(100).filter(row => row.tool.startsWith('admin.kanban')).length, 0, 'unauthenticated/pre-route rejections do not produce persistent mutation audit spam');
});

test('Kanban admin edits/comments/releases/rejects/approves enforce states and revisions without Runner execution', async t => {
  const { relay, id, create, get, post, stored } = await setup(t);
  const task = await create({ title: '<script>alert("x")</script>&', description: '<b>text</b>', targetPaths: ['src\\a.ts'] });
  assert.equal(task.revision, 0); assert.equal(task.createdBy, 'admin'); assert.deepEqual(task.targetPaths, ['src/a.ts']);
  const edit = await post(`/tasks/${task.id}/edit`, { projectId: 'workspace', expectedRevision: 0, title: '<img src=x onerror=alert(1)>', requiresReview: true });
  assert.equal(edit.status, 200); assert.equal(edit.body.task.revision, 1);
  assert.equal(edit.body.task.title, '<img src=x onerror=alert(1)>');
  assert.equal((await get(`/tasks/${task.id}?projectId=workspace`)).body.task.description, '<b>text</b>');
  assert.equal((await post(`/tasks/${task.id}/approve`, { projectId: 'workspace', expectedRevision: 1 })).status, 409);
  assert.equal((await post(`/tasks/${task.id}/edit`, { projectId: 'workspace', title: 'Missing revision' })).status, 400);
  assert.equal((await post(`/tasks/${task.id}/edit`, { projectId: 'workspace', expectedRevision: 1.5, title: 'Fractional' })).status, 400);
  assert.equal((await post(`/tasks/${task.id}/comment`, { projectId: 'other', expectedRevision: 1, message: 'Cross project' })).status, 404);
  relay.hub.kanban.claim(task.id, 'workspace', 'worker', id);
  assert.equal(stored(task).revision, 2);
  const lease = stored(task).leaseExpiresAt;
  const comment = await post(`/tasks/${task.id}/comment`, { projectId: 'workspace', expectedRevision: 2, message: '<em>admin text</em>' });
  assert.equal(comment.status, 200); assert.equal(comment.body.task.revision, 3); assert.equal(comment.body.task.leaseExpiresAt, lease);
  assert.equal(comment.body.task.messages.at(-1).text, '<em>admin text</em>');
  assert.equal((await post(`/tasks/${task.id}/edit`, { projectId: 'workspace', expectedRevision: 3, title: 'Not todo' })).status, 409);
  const release = await post(`/tasks/${task.id}/release`, { projectId: 'workspace', expectedRevision: 3, reason: 'Reassign' });
  assert.equal(release.status, 200); assert.equal(release.body.task.status, 'todo'); assert.equal(release.body.task.assignee, undefined); assert.equal(release.body.task.leaseExpiresAt, undefined);
  relay.hub.kanban.claim(task.id, 'workspace', 'worker', id);
  relay.hub.kanban.update(task.id, 'workspace', { actualPaths: ['old.ts'] }, 'worker');
  relay.hub.kanban.submitReview(task.id, 'workspace', { proposedCommitMessage: 'old', aiSummary: 'old evidence', fileHashes: { 'old.ts': 'a'.repeat(64) } });
  relay.hub.kanban.recordActualPaths('workspace', 'unassigned-editor', id, ['old.ts']);
  const reject = await post(`/tasks/${task.id}/reject`, { projectId: 'workspace', expectedRevision: stored(task).revision, reason: 'Needs work' });
  assert.equal(reject.status, 200); assert.equal(reject.body.task.status, 'todo');
  for (const key of ['assignee', 'assigneeDevice', 'leaseExpiresAt', 'claimedAt', 'evidence', 'reviewFingerprints', 'reviewStalePaths', 'proposedCommitMessage']) assert.equal(reject.body.task[key], undefined, key);
  assert.deepEqual(reject.body.task.actualPaths, ['old.ts']);
  relay.hub.kanban.claim(task.id, 'workspace', 'worker', id);
  relay.hub.kanban.submitReview(task.id, 'workspace', { proposedCommitMessage: 'fresh', aiSummary: 'fresh', fileHashes: {} });
  const approve = await post(`/tasks/${task.id}/approve`, { projectId: 'workspace', expectedRevision: stored(task).revision });
  assert.equal(approve.status, 200); assert.equal(approve.body.task.status, 'done'); assert.ok(approve.body.task.completedAt); assert.equal(approve.body.task.commitSha, undefined);
  assert.equal((await post(`/tasks/${task.id}/comment`, { projectId: 'workspace', expectedRevision: stored(task).revision, message: 'Done note' })).status, 200);
  const audit = relay.store.audits(100).filter(row => row.tool.startsWith('admin.kanban'));
  assert.ok(audit.some(row => row.status === 'error')); assert.ok(audit.some(row => row.tool === 'admin.kanban.approve' && row.status === 'ok'));
  assert.ok(audit.every(row => row.principal === 'admin' && /^[a-f0-9]{64}$/.test(row.argsHash)));
  assert.ok(!JSON.stringify(audit).includes('admin text'));
});

test('same-revision form races and MCP mutations conflict; old tasks migrate without read writes or heartbeat revisions', async t => {
  const { relay, id, create, get, post, stored } = await setup(t);
  const task = await create();
  const old = { ...stored(task) } as Partial<KanbanTask>; delete old.revision; relay.store.put('tasks', task.id, old);
  assert.equal((await get(`/tasks/${task.id}?projectId=workspace`)).body.task.revision, 0);
  assert.equal(stored(task).revision, undefined, 'migration read is side effect free');
  const races = await Promise.all(['one', 'two'].map(title => post(`/tasks/${task.id}/edit`, { projectId: 'workspace', expectedRevision: 0, title })));
  assert.deepEqual(races.map(response => response.status).sort(), [200, 409]);
  assert.equal(races.find(response => response.status === 409)!.body.error, 'conflict');
  relay.hub.kanban.claim(task.id, 'workspace', 'worker', id);
  const before = stored(task); const lease = before.leaseExpiresAt;
  for (const route of ['/projects', '/board?projectId=workspace', '/tasks?projectId=workspace', `/tasks/${task.id}?projectId=workspace`]) assert.equal((await get(route)).status, 200);
  assert.equal(stored(task).leaseExpiresAt, lease); assert.equal(stored(task).updatedAt, before.updatedAt); assert.equal(stored(task).revision, before.revision);
  relay.hub.kanban.renewLease('workspace', 'worker', id);
  assert.equal(stored(task).revision, before.revision); assert.equal(stored(task).updatedAt, before.updatedAt);
  await relay.hub.invoke({ id: 'worker', scopes: ['write'], devices: [id], projects: ['workspace'] }, 'kanban_update_task', { deviceId: id, projectId: 'workspace', taskId: task.id, message: 'MCP progress' });
  assert.equal(stored(task).revision, before.revision + 1);
  assert.equal((await post(`/tasks/${task.id}/comment`, { projectId: 'workspace', expectedRevision: before.revision, message: 'Stale' })).body.error, 'conflict');
  relay.hub.kanban.recordActualPaths('workspace', 'worker', id, ['changed.ts']);
  assert.equal(stored(task).revision, before.revision + 2);
  relay.hub.kanban.submitReview(task.id, 'workspace', { proposedCommitMessage: 'review', aiSummary: '', fileHashes: {} });
  assert.equal(stored(task).revision, before.revision + 3);
  relay.hub.kanban.complete(task.id, 'workspace', { skipReview: false });
  assert.equal(stored(task).revision, before.revision + 4);
  const expired = await create(); relay.hub.kanban.claim(expired.id, 'workspace', 'worker', id);
  const record = stored(expired); record.leaseExpiresAt = Date.now() - 1; relay.store.put('tasks', expired.id, record);
  relay.hub.kanban.sweepLeases();
  assert.equal(stored(expired).status, 'todo'); assert.equal(stored(expired).revision, 2);
});

test('project discovery groups only by ID and allows retained history while creation/edit fail closed', async t => {
  const { f, relay, id, create, get, post, stored } = await setup(t);
  const add = (project: string, name: string, changes: Partial<Device> = {}) => {
    const did = randomUUID(); const device: Device = { id: did, name: did, tokenHash: '', revoked: false, paused: false, projects: [{ id: project, name }], platform: '', lastSeen: 0, created: Date.now(), ...changes };
    relay.store.put('devices', did, device); return did;
  };
  add('workspace', 'Different name'); add('other-id', 'Workspace'); add('assist-only', 'Assist', { assistSessionId: randomUUID() }); add('revoked-only', 'Revoked', { revoked: true }); add('paused-only', 'Paused', { paused: true });
  const history = relay.hub.kanban.create('removed-project', { title: 'Retained', description: '', requiresReview: true }, 'worker');
  const discovered = (await get('/projects')).body.projects;
  assert.equal(discovered.find((project: any) => project.id === 'workspace').devices.length, 2);
  assert.ok(discovered.some((project: any) => project.id === 'other-id'));
  assert.ok(!discovered.some((project: any) => project.id === 'assist-only' || project.id === 'revoked-only'));
  assert.deepEqual(discovered.find((project: any) => project.id === 'removed-project'), { id: 'removed-project', name: 'removed-project', devices: [], available: false });
  assert.equal(discovered.find((project: any) => project.id === 'paused-only').available, false);
  assert.equal((await get('/board?projectId=removed-project')).body.columns.todo.total, 1);
  assert.equal((await get(`/tasks/${history.id}?projectId=removed-project`)).status, 200);
  assert.equal((await post('/tasks', { projectId: 'removed-project', title: 'No' })).status, 409);
  assert.equal((await post('/tasks', { projectId: 'paused-only', title: 'No' })).status, 409);
  assert.equal((await post('/tasks', { projectId: 'assist-only', title: 'No' })).status, 404);
  assert.equal((await post(`/tasks/${history.id}/edit`, { projectId: 'removed-project', expectedRevision: 0, title: 'No' })).status, 409);
  assert.equal((await post(`/tasks/${history.id}/comment`, { projectId: 'removed-project', expectedRevision: 0, message: 'History note' })).status, 200);
  relay.hub.kanban.claim(history.id, 'removed-project', 'old-worker', 'removed-device');
  relay.hub.kanban.submitReview(history.id, 'removed-project', { proposedCommitMessage: 'old', aiSummary: '', fileHashes: {} });
  assert.equal((await post(`/tasks/${history.id}/approve`, { projectId: 'removed-project', expectedRevision: stored(history).revision })).status, 200);
  // Current configuration, not the Runner's obsolete reported projects, controls membership.
  const current = relay.store.get<Device>('devices', id)!;
  current.projects = [{ id: 'obsolete', name: 'Obsolete' }]; relay.store.put('devices', id, current); setDeviceProjects(relay.store, id, f.config);
  assert.ok(!(await get('/projects')).body.projects.some((project: any) => project.id === 'obsolete'));
  assert.equal((await create()).status, 'todo', 'offline configured projects can create metadata');
});

test('board columns and tasks support stable bounded cursors, exact assignee/device filters and text search', async t => {
  const { relay, id, get } = await setup(t);
  for (let i = 0; i < 67; i++) {
    const task = relay.hub.kanban.create('workspace', { title: `Needle ${i}`, description: 'plain <text>', requiresReview: true }, 'worker');
    task.updatedAt = 1000; task.status = 'todo'; task.assignee = i % 2 ? 'alice' : 'bob'; task.assigneeDevice = id;
    task.targetPaths = [`src/target-only-${i}.ts`]; task.actualPaths = [`lib/actual-only-${i}.ts`]; relay.store.put('tasks', task.id, task);
  }
  for (const status of ['in_progress', 'review', 'done'] as const) {
    const task = relay.hub.kanban.create('workspace', { title: status, description: '', requiresReview: true }, 'worker'); task.status = status; relay.store.put('tasks', task.id, task);
  }
  const board = (await get('/board?projectId=workspace&query=&deviceId=&assignee=')).body;
  assert.equal(typeof board.serverTime, 'number'); assert.deepEqual(Object.keys(board.columns), ['todo', 'in_progress', 'review', 'done']);
  assert.equal(board.columns.todo.items.length, 30); assert.equal(board.columns.todo.total, 67); assert.equal(typeof board.columns.todo.nextCursor, 'string');
  assert.equal(board.columns.review.items.length, 1); assert.equal(board.columns.review.nextCursor, null);
  const seen = [...board.columns.todo.items.map((task: any) => task.id)];
  let cursor = board.columns.todo.nextCursor;
  while (cursor) {
    const page = (await get(`/tasks?projectId=workspace&status=todo&cursor=${cursor}`)).body;
    assert.equal(page.total, 67); assert.ok(page.items.length <= 30); seen.push(...page.items.map((task: any) => task.id)); cursor = page.nextCursor;
  }
  assert.equal(seen.length, 67); assert.equal(new Set(seen).size, 67);
  assert.equal((await get('/tasks?projectId=workspace&status=todo&query=NEEDLE&assignee=alice')).body.total, 33);
  assert.equal((await get('/tasks?projectId=workspace&query=TARGET-ONLY-5.ts')).body.total, 1);
  assert.equal((await get('/tasks?projectId=workspace&query=ACTUAL-ONLY-8.ts')).body.total, 1);
  assert.equal((await get('/board?projectId=workspace&query=target-only-5.ts')).body.columns.todo.total, 1);
  assert.equal((await get('/board?projectId=workspace&query=actual-only-8.ts')).body.columns.todo.total, 1);
  assert.equal((await get(`/tasks?projectId=workspace&deviceId=${id}&assignee=bob`)).body.total, 34);
  assert.equal((await get('/tasks?projectId=workspace&deviceId=missing')).body.total, 0);
  assert.equal((await get(`/tasks?projectId=workspace&status=review&cursor=${board.columns.todo.nextCursor}`)).status, 400);
  assert.equal((await get('/tasks?projectId=workspace&cursor=garbage')).status, 400);
  assert.equal((await get('/tasks?projectId=workspace&status=invalid')).status, 400);
});

test('administrator drag transitions validate assignment grants, clear evidence and never execute Runner tools', async t => {
  const { relay, id, create, get, post, stored } = await setup(t);
  const principal = 'worker-principal';
  relay.store.mintToken({ id: principal, kind: 'pat', clientId: 'Worker name', family: randomUUID(), scopes: ['write'], devices: [id], projects: ['workspace'], expires: Date.now() + 60000 });
  const socket = new RunnerSocket(); relay.hub.attach(relay.store.get<Device>('devices', id)!, socket as unknown as WebSocket);
  socket.emit('message', JSON.stringify({ type: 'hello', protocol: 2, name: 'device', platform: 'test', version: 'test', projects: [], instanceId: randomUUID(), capabilities: [] }));
  const task = await create({ requiresReview: false });
  const move = (action: string, input: object = {}) => post(`/tasks/${task.id}/${action}`, { projectId: 'workspace', expectedRevision: stored(task).revision, ...input });
  assert.equal((await move('submit', { proposedCommitMessage: 'No', aiSummary: 'No' })).status, 409);
  assert.equal((await move('finish', { skipReview: true })).status, 409);
  const assigned = await move('assign', { assignee: principal, deviceId: id });
  assert.equal(assigned.status, 200); assert.equal(assigned.body.task.status, 'in_progress');
  assert.equal(assigned.body.task.assignee, principal); assert.equal(assigned.body.task.assigneeDevice, id);
  assert.ok(Math.abs(assigned.body.task.leaseExpiresAt - assigned.body.task.claimedAt - 30 * 60000) < 5);
  assert.equal((await move('assign', { assignee: principal, deviceId: id })).status, 409);
  const submitted = await move('submit', { proposedCommitMessage: '  proposed  ', aiSummary: '  admin summary  ' });
  assert.equal(submitted.status, 200); assert.equal(submitted.body.task.status, 'review', 'administrator submission explicitly reviews even requiresReview:false');
  assert.equal(submitted.body.task.proposedCommitMessage, 'proposed'); assert.equal(submitted.body.task.evidence.aiSummary, 'admin summary');
  assert.deepEqual(submitted.body.task.reviewFingerprints, {}); assert.equal(submitted.body.task.reviewFingerprintsTotal, 0);
  const reviewRecord = stored(task); reviewRecord.reviewFingerprints = { 'a.ts': 'a'.repeat(64) }; reviewRecord.reviewStalePaths = ['a.ts']; relay.store.put('tasks', task.id, reviewRecord);
  const revised = await move('revise', { reason: '  Needs revision  ' });
  assert.equal(revised.status, 200); assert.equal(revised.body.task.status, 'in_progress'); assert.equal(revised.body.task.assignee, principal);
  assert.equal(revised.body.task.evidence, undefined); assert.equal(revised.body.task.reviewFingerprints, undefined); assert.equal(revised.body.task.reviewStalePaths, undefined);
  assert.ok(revised.body.task.leaseExpiresAt >= assigned.body.task.leaseExpiresAt);
  assert.equal((await move('finish')).status, 400); assert.equal((await move('finish', { skipReview: false })).status, 400);
  const finished = await move('finish', { skipReview: true });
  assert.equal(finished.status, 200); assert.equal(finished.body.task.status, 'done'); assert.equal(finished.body.task.messages.at(-1).text, 'Completed (review skipped by administrator)');
  const done = stored(task); done.evidence = { aiSummary: 'old' }; done.reviewFingerprints = { 'old.ts': 'b'.repeat(64) }; done.reviewStalePaths = ['old.ts']; done.commitSha = 'old-sha'; relay.store.put('tasks', task.id, done);
  const reassigned = await move('assign', { assignee: principal, deviceId: id });
  assert.equal(reassigned.status, 200); assert.equal(reassigned.body.task.status, 'in_progress');
  for (const key of ['evidence', 'reviewFingerprints', 'reviewStalePaths', 'completedAt', 'commitSha']) assert.equal(reassigned.body.task[key], undefined);
  await move('finish', { skipReview: true });
  const reopened = await move('reopen', { reason: 'More work' });
  assert.equal(reopened.status, 200); assert.equal(reopened.body.task.status, 'todo'); assert.equal(reopened.body.task.assignee, undefined); assert.equal(reopened.body.task.completedAt, undefined);
  assert.equal((await move('reopen', { reason: 'Again' })).status, 409);
  assert.equal((await move('unknown', {})).status, 400);
  const races = await Promise.all([1, 2].map(() => post(`/tasks/${task.id}/assign`, { projectId: 'workspace', expectedRevision: stored(task).revision, assignee: principal, deviceId: id })));
  assert.deepEqual(races.map(response => response.status).sort(), [200, 409]);
  assert.equal((await get('/assignees?projectId=workspace')).body.assignees[0].id, principal);
  assert.equal(socket.calls, 0, 'metadata drag actions cannot execute or stop Runner processes');
  assert.ok(relay.store.audits(100).some(row => row.tool === 'admin.kanban.finish' && row.status === 'ok'));
});

test('assignment choices and POST validation share current exact PAT/OAuth principal-device eligibility', async t => {
  const { relay, id, create, get, post, stored } = await setup(t);
  const ordinary = relay.store.get<Device>('devices', id)!;
  const second = randomUUID(); relay.store.put('devices', second, { ...ordinary, id: second, name: 'Second device' });
  const client = relay.oauth.clientsStore.registerClient({ client_name: 'OAuth worker name', redirect_uris: ['http://127.0.0.1:9999/callback'], token_endpoint_auth_method: 'none' });
  const oauthRaw = relay.store.mintToken({ id: 'oauth-worker', kind: 'access', clientId: client.client_id, family: randomUUID(), scopes: ['write'], devices: [id], projects: ['workspace'], expires: Date.now() + 60000 });
  const mint = (name: string, overrides: object = {}) => relay.store.mintToken({ id: name, kind: 'pat', clientId: `${name} name`, family: randomUUID(), scopes: ['write'], devices: [id], projects: ['workspace'], expires: Date.now() + 60000, ...overrides });
  const valid = mint('valid'); mint('valid');
  const staleFamily = randomUUID(); mint('policy-denied', { family: staleFamily });
  relay.store.put('authorizations', staleFamily, { revision: 1, permanent: { scopes: ['read'], devices: [id], projectGrants: { [id]: ['workspace'] }, tools: null, machineAccess: false, unrestrictedExecution: false } });
  const bad = [
    ['expired', { expires: Date.now() - 1 }], ['read-only', { scopes: ['read'] }], ['wrong-project', { projects: ['other'] }],
    ['wrong-device', { devices: [randomUUID()] }], ['pair-denied', { projects: null, projectGrants: { [id]: ['other'] } }],
    ['tool-denied', { tools: [] }], ['refresh-only', { kind: 'refresh' }], ['other-identity', { id: 'not-the-requested-id' }],
  ] as const;
  for (const [name, overrides] of bad) mint(name, overrides);
  const revoked = mint('revoked'); relay.store.revokeFamily(relay.store.token(revoked)!.family);
  const task = await create();
  const assign = (assignee: string, deviceId = id) => post(`/tasks/${task.id}/assign`, { projectId: 'workspace', expectedRevision: stored(task).revision, assignee, deviceId });
  const choices = (await get('/assignees?projectId=workspace')).body.assignees;
  assert.deepEqual(choices.find((item: any) => item.id === 'valid'), { id: 'valid', name: 'valid name', devices: [{ id, name: 'First device' }] });
  assert.equal(choices.find((item: any) => item.id === 'oauth-worker').name, 'OAuth worker name');
  for (const name of ['policy-denied', 'revoked', ...bad.map(([name]) => name)]) {
    assert.ok(!choices.some((item: any) => item.id === name), name); assert.equal((await assign(name)).status, 403, name);
  }
  assert.equal((await assign('valid', second)).status, 403, 'authorization of one device does not grant another configured device');
  for (const change of [{ paused: true }, { revoked: true }, { assistSessionId: randomUUID() }, { permissions: { revision: 1, projects: [], expiresAt: null, fallbackProjects: [] }, permanentProjects: [] }]) {
    relay.store.put('devices', id, { ...ordinary, ...change });
    assert.equal((await assign('valid')).status, 403);
    assert.ok(!(await get('/assignees?projectId=workspace')).body.assignees.some((item: any) => item.id === 'valid'));
  }
  relay.store.put('devices', id, ordinary);
  assert.equal((await assign('valid')).status, 200);
  relay.hub.kanban.submitReview(task.id, 'workspace', { proposedCommitMessage: 'worker review', aiSummary: '', fileHashes: {} });
  relay.store.revokeFamily(relay.store.token(valid)!.family);
  // A second valid credential for the same identity still grants the exact pair.
  assert.equal((await post(`/tasks/${task.id}/revise`, { projectId: 'workspace', expectedRevision: stored(task).revision, reason: 'Continue' })).status, 200);
  relay.hub.kanban.submitReview(task.id, 'workspace', { proposedCommitMessage: 'again', aiSummary: '', fileHashes: {} });
  for (const token of relay.store.all<import('../src/server/store.js').ClientToken>('tokens')) if (token.id === 'valid') relay.store.revokeFamily(token.family);
  assert.equal((await post(`/tasks/${task.id}/revise`, { projectId: 'workspace', expectedRevision: stored(task).revision, reason: 'Denied' })).status, 403);
  assert.equal(stored(task).status, 'review');
  relay.oauth.revokeClient(client.client_id);
  const fresh = await create();
  assert.equal((await post(`/tasks/${fresh.id}/assign`, { projectId: 'workspace', expectedRevision: 0, assignee: 'oauth-worker', deviceId: id })).status, 403);
  assert.ok(!(await get('/assignees?projectId=workspace')).body.assignees.some((item: any) => item.id === 'oauth-worker'));
  assert.equal(relay.store.token(oauthRaw), undefined);
  for (const [action, input] of [['assign', { assignee: ' ', deviceId: id }], ['submit', { proposedCommitMessage: ' ', aiSummary: 'summary' }], ['submit', { proposedCommitMessage: 'message', aiSummary: ' ' }], ['revise', { reason: ' ' }], ['reopen', { reason: ' ' }]] as const) assert.equal((await post(`/tasks/${fresh.id}/${action}`, { projectId: 'workspace', expectedRevision: 0, ...input })).status, 400);
});

class RunnerSocket extends EventEmitter {
  readyState = 1; calls = 0; response = result({ ok: true });
  send(frame: string, callback?: (error?: Error) => void) {
    const message = JSON.parse(frame);
    if (message.type === 'welcome') this.emit('message', JSON.stringify({ type: 'permissions_applied', revision: message.permissions.revision, projects: [{ id: 'workspace', name: 'Workspace', readOnly: false, commands: [] }] }));
    if (message.type === 'call') { this.calls++; this.emit('message', JSON.stringify({ type: 'result', id: message.id, result: this.response })); }
    callback?.();
  }
  ping() { this.emit('pong'); }
  terminate() { this.close(); }
  close() { this.readyState = 3; this.emit('close'); }
}

test('confirmed Hub mutations stale overlapping reviews even without active worker tasks; failures/dry runs do not', async t => {
  const { relay, id, create, get, post, stored } = await setup(t);
  const socket = new RunnerSocket(); relay.hub.attach(relay.store.get<Device>('devices', id)!, socket as unknown as WebSocket);
  socket.emit('message', JSON.stringify({ type: 'hello', protocol: 2, name: 'device', platform: 'test', version: 'test', projects: [], instanceId: randomUUID(), capabilities: ['write_file', 'edit_files', 'move_file'] }));
  const task = await create({ targetPaths: ['src/a.ts'] });
  relay.hub.kanban.claim(task.id, 'workspace', 'reviewer', id);
  relay.hub.kanban.submitReview(task.id, 'workspace', { proposedCommitMessage: 'review', aiSummary: 'advisory', fileHashes: { 'src/a.ts': 'a'.repeat(64) } });
  const principal = { id: 'unassigned-editor', scopes: ['write' as const], devices: [id], projects: ['workspace'] };
  const call = (tool: string, input: object) => relay.hub.invoke(principal, tool, { deviceId: id, projectId: 'workspace', ...input });
  await call('edit_files', { changes: [{ operation: 'create', path: 'src/a.ts', content: 'dry' }], dryRun: true });
  socket.response = result({ error: 'failed' }, true); await call('write_file', { path: 'src/a.ts', content: 'fail' });
  assert.equal(stored(task).reviewStalePaths, undefined);
  const before = stored(task).revision;
  socket.response = result({ ok: true }); await call('move_file', { source: 'src', destination: 'renamed' });
  assert.deepEqual(stored(task).reviewStalePaths, ['src/a.ts']); assert.equal(stored(task).revision, before + 1);
  assert.deepEqual((await get('/board?projectId=workspace')).body.columns.review.items[0].reviewStalePaths, ['src/a.ts']);
  assert.equal((await post(`/tasks/${task.id}/approve`, { projectId: 'workspace', expectedRevision: before })).body.error, 'conflict');
  const afterMove = stored(task).revision;
  await call('write_file', { path: 'src/ab.ts', content: 'unrelated sibling' });
  assert.equal(stored(task).revision, afterMove, 'directory prefix uses segment boundaries, not filename prefixes');
  const overlap = await create({ targetPaths: ['src'] });
  assert.ok((await get(`/tasks/${overlap.id}?projectId=workspace`)).body.warnings.some((warning: string) => warning.includes(task.id)));
  assert.equal((await post(`/tasks/${task.id}/reject`, { projectId: 'workspace', expectedRevision: stored(task).revision, reason: 'Resubmit' })).status, 200);
  relay.hub.kanban.claim(task.id, 'workspace', 'reviewer', id);
  relay.hub.kanban.submitReview(task.id, 'workspace', { proposedCommitMessage: 'fresh', aiSummary: '', fileHashes: {} });
  assert.equal(stored(task).reviewStalePaths, undefined);
  const fresh = stored(task);
  fresh.reviewStalePaths = ['src/a.ts']; relay.store.put('tasks', task.id, fresh);
  relay.hub.kanban.administer(task.id, 'workspace', fresh.revision, { action: 'reject', reason: 'Fresh submission needed' });
  relay.hub.kanban.claim(task.id, 'workspace', 'reviewer', id);
  const working = stored(task); working.reviewStalePaths = ['src/a.ts']; relay.store.put('tasks', task.id, working);
  relay.hub.kanban.submitReview(task.id, 'workspace', { proposedCommitMessage: 'fresh again', aiSummary: '', fileHashes: {} });
  assert.equal(stored(task).reviewStalePaths, undefined, 'fresh review submission clears stale advisory');
  const calls = socket.calls;
  await post(`/tasks/${task.id}/approve`, { projectId: 'workspace', expectedRevision: stored(task).revision });
  assert.equal(socket.calls, calls, 'browser actions never dispatch to Runner');
});

test('bounded histories and input limits preserve text without HTML interpretation', async t => {
  const { relay, create, get, post } = await setup(t);
  const task = await create();
  for (let i = 0; i < 130; i++) relay.hub.kanban.administer(task.id, 'workspace', i, { action: 'comment', message: `<b>${i}</b>` });
  const record = relay.store.get<KanbanTask>('tasks', task.id)!;
  record.actualPaths = Array.from({ length: 300 }, (_, i) => `file-${i}.ts`); record.reviewStalePaths = [...record.actualPaths];
  record.reviewFingerprints = Object.fromEntries(record.actualPaths.map(file => [file, 'a'.repeat(64)]));
  relay.store.put('tasks', task.id, record);
  const detail = (await get(`/tasks/${task.id}?projectId=workspace`)).body.task;
  assert.equal(detail.actualPaths.length, 256); assert.equal(detail.actualPathsTotal, 300);
  assert.equal(detail.reviewStalePaths.length, 256); assert.equal(detail.reviewStalePathsTotal, 300); assert.equal(detail.targetPathsTotal, 0);
  assert.equal(Object.keys(detail.reviewFingerprints).length, 256); assert.equal(detail.reviewFingerprintsTotal, 300);
  assert.equal(detail.messagesTotal, 130); assert.equal(detail.messages.length, 100); assert.equal(detail.messagesTruncated, true); assert.equal(detail.messages.at(-1).text, '<b>129</b>');
  const summary = (await get('/tasks?projectId=workspace')).body.items[0];
  assert.equal(summary.messages, undefined); assert.equal(summary.messagesTotal, 130);
  assert.equal(summary.actualPaths.length, 32); assert.equal(summary.actualPathsTotal, 300);
  assert.equal(summary.reviewStalePaths.length, 32); assert.equal(summary.reviewStalePathsTotal, 300);
  assert.equal(summary.reviewFingerprints, undefined); assert.equal(summary.reviewFingerprintsTotal, 300);
  for (const input of [{ title: 'x'.repeat(257) }, { title: ' \t\n ' }, { description: 'x'.repeat(4097) }, { targetPaths: Array(33).fill('a') }, { targetPaths: ['nul\0path'] }, { unexpected: true }]) assert.equal((await post('/tasks', { projectId: 'workspace', title: 'Work', ...input })).status, 400);
  for (const [action, input] of [['edit', { title: ' \t\n ' }], ['comment', { message: ' \t\n ' }], ['release', { reason: ' \t\n ' }], ['reject', { reason: ' \t\n ' }]] as const) assert.equal((await post(`/tasks/${task.id}/${action}`, { projectId: 'workspace', expectedRevision: 130, ...input })).status, 400);
  assert.equal((await post(`/tasks/${task.id}/comment`, { projectId: 'workspace', expectedRevision: 130, message: 'x'.repeat(1025) })).status, 400);
  assert.ok(relay.store.audits(100).some(row => row.tool === 'admin.kanban.create' && row.status === 'error'));
});
