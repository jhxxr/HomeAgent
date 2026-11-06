import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { Hub } from '../src/server/hub.js';
import { Store, type Device } from '../src/server/store.js';
import type { KanbanTask } from '../src/server/kanban.js';
import { result, type Principal, type ToolResult } from '../src/shared/protocol.js';
import { fixture } from './helpers.js';

const owner: Principal = { id: 'worker', scopes: ['read', 'write', 'execute'], devices: null, projects: null };
const body = (value: ToolResult) => JSON.parse(value.content[0]!.text);
const projectId = 'workspace';
const digest = 'a'.repeat(64);
function device(id: string, projects = ['workspace', 'other']): Device {
  return { id, name: id, tokenHash: '', revoked: false, paused: false, projects: projects.map(id => ({ id, name: id, readOnly: false, commands: [] })), platform: 'test', lastSeen: 0, created: Date.now() };
}

class RunnerSocket extends EventEmitter {
  readyState = 1;
  response = result({ ok: true });
  calls = 0;
  send(frame: string, callback?: (error?: Error) => void) {
    const message = JSON.parse(frame);
    if (message.type === 'welcome') this.emit('message', JSON.stringify({ type: 'permissions_applied', revision: 0, projects: [{ id: projectId, name: projectId, readOnly: false, commands: [] }] }));
    if (message.type === 'call') {
      this.calls++;
      this.emit('message', JSON.stringify({ type: 'result', id: message.id, result: this.response }));
    }
    callback?.();
  }
  ping() { this.emit('pong'); }
  terminate() { this.close(); }
  close() { this.readyState = 3; this.emit('close'); }
}

async function setup(t: { after: (fn: () => Promise<void>) => void }, online = false) {
  const f = await fixture();
  const store = new Store(path.join(f.directory, 'kanban.sqlite')), hub = new Hub(store);
  t.after(async () => { hub.close(); store.close(); await f.cleanup(); });
  const id = randomUUID(), d = device(id); store.put('devices', id, d);
  const socket = new RunnerSocket();
  if (online) {
    hub.attach(d, socket as unknown as WebSocket);
    socket.emit('message', JSON.stringify({ type: 'hello', protocol: 2, name: 'test', platform: 'test', version: 'test', projects: [], instanceId: randomUUID(), capabilities: ['read_file', 'write_file', 'edit_block', 'edit_files', 'apply_unified_diff', 'move_file', 'run_command'] }));
  }
  const create = () => hub.kanban.create(projectId, { title: 'Work', description: '', requiresReview: true }, owner.id);
  const call = (name: string, input: object = {}, principal = owner) => hub.invoke(principal, name, { projectId, ...input });
  return { store, hub, id, socket, create, call };
}

test('all kanban tools enforce current PAT and OAuth device/project grants', async t => {
  const { store, hub, id, create } = await setup(t);
  const task = create();
  for (const kind of ['pat', 'access'] as const) {
    const family = randomUUID();
    const raw = store.mintToken({ ...owner, kind, id: owner.id, clientId: 'client', family, expires: Date.now() + 60000 });
    store.put('authorizations', family, { revision: 1, permanent: { scopes: ['read', 'write'], devices: [id], projectGrants: { [id]: ['other'] }, tools: null, machineAccess: false, unrestrictedExecution: false } });
    const token = store.token(raw)!;
    assert.equal(token.projects, null);
    const calls = [
      ['kanban_list_tasks', {}], ['kanban_create_task', { title: 'Denied' }],
      ['kanban_claim_task', { taskId: task.id }], ['kanban_update_task', { taskId: task.id }],
      ['kanban_submit_review', { taskId: task.id, proposedCommitMessage: 'Denied' }],
      ['kanban_complete_task', { taskId: task.id }],
    ] as const;
    for (const [tool, args] of calls) for (const explicit of [false, true]) {
      await assert.rejects(hub.invoke(token, tool, { projectId, ...args, ...(explicit ? { deviceId: id } : {}) }, undefined, { family, tokenHash: token.tokenHash }), /outside token grants|No authorized device/);
    }
    assert.equal(hub.kanban.list(projectId).length, 1);
    assert.equal(hub.kanban.list(projectId)[0]!.status, 'todo');
    assert.equal((await hub.invoke(token, 'kanban_list_tasks', { projectId: 'other' }, undefined, { family, tokenHash: token.tokenHash })).isError, undefined);
  }
});

test('kanban fallback rejects revoked, missing, excluded and assistance devices', async t => {
  const { store, id, call } = await setup(t);
  const grant = { ...owner, devices: [id], projectGrants: { [id]: [projectId] } };
  await assert.rejects(call('kanban_list_tasks', {}, { ...grant, devices: [] }), /No authorized device/);
  await assert.rejects(call('kanban_list_tasks', { deviceId: 'missing' }, owner), /unknown/);
  for (const change of [{ revoked: true }, { paused: true }, { assistSessionId: randomUUID() }]) {
    store.put('devices', id, { ...device(id), ...change });
    await assert.rejects(call('kanban_list_tasks', {}, grant));
    await assert.rejects(call('kanban_list_tasks', { deviceId: id }, grant));
  }
  store.put('devices', id, device(id));
  await assert.rejects(call('kanban_list_tasks', {}, { ...grant, scopes: [] }), /scope/);
  await assert.rejects(call('kanban_list_tasks', {}, { ...grant, tools: [] }), /disabled/);
});

test('claims infer an authorized device offline, reject ambiguity, and never store an empty assigneeDevice', async t => {
  const { store, id, create, call } = await setup(t);
  const claimed = body(await call('kanban_claim_task', { taskId: create().id }));
  assert.equal(claimed.task.assigneeDevice, id);
  const other = randomUUID(); store.put('devices', other, device(other));
  const next = create();
  await assert.rejects(call('kanban_claim_task', { taskId: next.id }), /Specify deviceId/);
  const grant = { ...owner, devices: [id, other], projectGrants: { [id]: [projectId], [other]: ['other'] } };
  assert.equal(body(await call('kanban_claim_task', { taskId: next.id }, grant)).task.assigneeDevice, id);
});

test('online claim inference filters devices by project grant rather than device count', async t => {
  const { store, id, create, call } = await setup(t, true);
  const other = randomUUID(); store.put('devices', other, device(other, ['other']));
  const grant = { ...owner, devices: [id, other], projectGrants: { [id]: [projectId], [other]: ['other'] } };
  assert.equal(body(await call('kanban_claim_task', { taskId: create().id }, grant)).task.assigneeDevice, id);
});

test('mutation warnings preserve JSON results, audit success and record actual paths only on writes', async t => {
  const { store, hub, id, socket, create, call } = await setup(t, true);
  const review = create(); hub.kanban.claim(review.id, projectId, 'reviewer', id);
  hub.kanban.submitReview(review.id, projectId, { proposedCommitMessage: 'review', aiSummary: '', fileHashes: { 'src/a.ts': digest, 'src/b.ts': digest } });
  const active = create(); hub.kanban.claim(active.id, projectId, owner.id, id);
  const task = () => store.get<KanbanTask>('tasks', active.id)!;
  const cases = [
    ['write_file', { path: './src/a.ts', content: 'x' }],
    ['edit_block', { path: 'src\\a.ts', oldText: 'x', newText: 'y' }],
    ['edit_files', { changes: [{ operation: 'create', path: 'src/a.ts', content: 'x' }] }],
    ['apply_unified_diff', { diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n', expectedSha256: { 'src/a.ts': digest, 'unused.ts': digest } }],
    ['move_file', { source: 'src/a.ts', destination: './src/b.ts' }],
  ] as const;
  for (const [tool, args] of cases) {
    socket.response = result({ marker: tool, changes: [{ path: 'src/a.ts' }] });
    const response = await call(tool, args);
    assert.equal(body(response).marker, tool);
    assert.ok(body(response).reviewWarnings.length);
    assert.deepEqual(body(response), response.structuredContent);
    assert.equal(store.audits(1)[0]!.status, 'ok');
  }
  assert.deepEqual(task().actualPaths, ['src/a.ts', 'src/b.ts']);
  socket.response = result('plain runner receipt');
  const plain = await call('write_file', { path: 'src/a.ts', content: 'x' });
  assert.ok(plain.content[0]!.text.startsWith('plain runner receipt\nReview fingerprint warnings:'));
  socket.response = result({ text: 'content' });
  assert.equal(body(await call('read_file', { path: 'src/a.ts' })).reviewWarnings, undefined);
  await call('edit_files', { changes: [{ operation: 'create', path: 'dry.ts', content: 'x' }], dryRun: true });
  socket.response = result({ error: 'conflict' }, true);
  assert.equal((await call('write_file', { path: 'failed.ts', content: 'x' })).isError, true);
  assert.deepEqual(task().actualPaths, ['src/a.ts', 'src/b.ts']);
});

test('worker activity renews leases beyond 30 minutes without extending other workers or devices', async t => {
  const { store, hub, id, socket, create, call } = await setup(t, true);
  const active = create(); hub.kanban.claim(active.id, projectId, owner.id, id);
  const unrelated = create(); hub.kanban.claim(unrelated.id, projectId, 'another-worker', id);
  const otherDevice = create(); hub.kanban.claim(otherDevice.id, projectId, owner.id, 'another-device');
  const read = (task: KanbanTask) => store.get<KanbanTask>('tasks', task.id)!;
  const started = Date.now(), originalNow = Date.now;
  try {
    for (let minute = 1; minute <= 31; minute++) {
      Date.now = () => started + minute * 60000;
      socket.response = result({ ok: true });
      await call(minute % 2 ? 'read_file' : 'run_command', minute % 2 ? { path: 'a.ts' } : { executable: 'node' });
      hub.kanban.sweepLeases();
      assert.equal(read(active).status, 'in_progress');
    }
    assert.equal(read(unrelated).status, 'todo');
    assert.equal(read(otherDevice).status, 'todo');
    Date.now = () => started + 62 * 60000;
    // A later call must not resurrect a lease that expired before the next sweep.
    await call('read_file', { path: 'a.ts' });
    hub.kanban.sweepLeases();
    assert.equal(read(active).status, 'todo');
    assert.equal(read(active).assigneeDevice, undefined);
  } finally { Date.now = originalNow; }
});
