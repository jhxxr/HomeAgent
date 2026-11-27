import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHomeServer } from '../src/server/app.js';
import { normalizeTask, type KanbanTask } from '../src/server/kanban.js';
import { normalizePrincipal, projectGranted, type Principal, type ToolResult } from '../src/shared/protocol.js';
import { taskToolSchemas } from '../src/shared/tools.js';
import { Agent } from '../src/runner/agent.js';
import { hash, secret, type Device, type ClientToken } from '../src/server/store.js';
import { fixture, freePort, setDeviceProjects, waitFor } from './helpers.js';

const data = (output: ToolResult) => JSON.parse(output.content[0]!.text) as any;
async function setup(t: { after: (callback: () => Promise<void>) => void }) {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'tasks.sqlite'), password: 'task-orchestration-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 1 });
  const deviceId = randomUUID(), deviceToken = secret();
  relay.store.put('devices', deviceId, { id: deviceId, name: 'Worker device', tokenHash: hash(deviceToken), revoked: false, paused: false, projects: [], platform: 'test', lastSeen: 0, created: Date.now() });
  setDeviceProjects(relay.store, deviceId, f.config);
  await relay.listen();
  const clients: Client[] = [], runners: Agent[] = [];
  t.after(async () => { for (const client of clients) await client.close(); for (const runner of runners) await runner.close(); await relay.close(); await f.cleanup(); });
  const mint = (id: string, overrides: Partial<Principal> = {}) => {
    const raw = relay.store.mintToken({ id, kind: 'pat', clientId: id, family: randomUUID(), scopes: ['read', 'write', 'tasks:self'], agentRole: 'worker', bindingMode: 'bound_projects', displayName: id,
      devices: [deviceId], projects: null, projectGrants: { [deviceId]: ['workspace'] }, expires: Date.now() + 86400000, ...overrides });
    const token = relay.store.token(raw)!;
    const call = async (tool: string, input: Record<string, unknown> = {}) => data(await relay.hub.invoke(token, tool, input, undefined, { family: token.family, tokenHash: token.tokenHash }));
    return { raw, token, call };
  };
  const worker = mint('worker');
  const supervisor = mint('supervisor', { agentRole: 'supervisor', bindingMode: 'none', devices: [], projectGrants: {}, scopes: ['tasks:self', 'tasks:dispatch', 'tasks:review', 'calendar:read'] });
  const dispatch = (input: Record<string, unknown> = {}) => supervisor.call('task_dispatch', { title: 'Task', projectId: 'workspace', deviceId, assigneePrincipalId: worker.token.id, ...input });
  const connect = async (raw: string) => {
    const client = new Client({ name: 'task-test', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${raw}` } } })); return client;
  };
  const login = async () => {
    const response = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'task-orchestration-password' }) });
    const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as { csrf: string };
    return {
      get: (route: string) => fetch(base + route, { headers: { cookie } }),
      post: (route: string, body: object) => fetch(base + route, { method: 'POST', headers: { cookie, origin: base, 'x-csrf-token': state.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    };
  };
  const startRunner = async () => {
    f.config.server = base;
    const runner = new Agent(f.config, { server: base, deviceId, token: deviceToken }, () => {}); runners.push(runner); runner.start();
    await waitFor(() => relay.store.get<Device>('devices', deviceId)?.permissionAppliedRevision === 0);
    return runner;
  };
  return { f, relay, base, deviceId, worker, supervisor, mint, dispatch, connect, login, startRunner };
}

test('old principal and task defaults are idempotent, preserve history and do not mutate KV records', async t => {
  const { relay } = await setup(t);
  const old: Principal = { id: 'legacy', scopes: ['read', 'write'], devices: null, projects: null };
  const principal = normalizePrincipal(old);
  assert.equal(principal.agentRole, 'worker'); assert.equal(principal.bindingMode, 'bound_projects');
  assert.ok(principal.scopes.includes('tasks:self')); assert.ok(!principal.scopes.includes('tasks:dispatch'));
  assert.deepEqual(normalizePrincipal(principal), principal); assert.equal(old.agentRole, undefined);
  const legacy = { id: 'TASK-OLD', projectId: 'workspace', title: 'Legacy', requiresReview: true, assignee: 'legacy', assigneeDevice: 'device', messages: [{ from: 'legacy', text: 'Keep', at: 1 }], evidence: { testJobId: 'test' }, extra: 'preserve' };
  relay.store.put('tasks', legacy.id, legacy);
  const task = relay.hub.kanban.task(legacy.id);
  assert.equal(task.revision, 0); assert.equal(task.assigneePrincipalId, 'legacy'); assert.equal(task.deviceId, 'device'); assert.equal(task.riskLevel, 'medium');
  assert.deepEqual(normalizeTask(task), task); assert.deepEqual(relay.store.get('tasks', legacy.id), legacy);
  const cloud = normalizePrincipal({ ...old, bindingMode: 'none' as const });
  assert.equal(projectGranted(cloud, 'device', 'workspace'), false); assert.deepEqual(cloud.devices, []);
});

test('cloud supervisor MCP exposes exactly nine tools and rejects direct machine calls even with machine scopes', async t => {
  const { relay, supervisor, mint, connect, deviceId } = await setup(t);
  const client = await connect(supervisor.raw);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), Object.keys(taskToolSchemas).sort());
  assert.equal((await client.callTool({ name: 'list_devices', arguments: {} })).isError, true);
  const cloud = mint('cloud-with-machine-scopes', { bindingMode: 'none', devices: [], projectGrants: {}, scopes: ['read', 'write', 'execute', 'git', 'tasks:self'] });
  for (const tool of ['read_file', 'run_command', 'kanban_list_tasks']) {
    await assert.rejects(cloud.call(tool, { deviceId, projectId: 'workspace' }), { code: 'ERR_NO_WORKSPACE_BINDING' });
  }
  assert.deepEqual(relay.hub.devices(cloud.token), []);
  const workerWithSupervisorScopes = mint('scoped-worker', { scopes: ['tasks:self', 'tasks:dispatch', 'tasks:review', 'calendar:read'] });
  await assert.rejects(workerWithSupervisorScopes.call('agent_directory'), /role|scope/);
  const observer = mint('observer', { agentRole: 'observer', scopes: ['read', 'write', 'tasks:self'] });
  const observerClient = await connect(observer.raw);
  const names = (await observerClient.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('task_inbox')); assert.ok(!names.includes('task_claim')); assert.ok(!names.includes('write_file'));
  await assert.rejects(observer.call('task_claim', { taskId: 'TASK-001', expectedRevision: 0 }), /role|scope/);
});

test('PAT issuance and permission editing support empty-device supervisors and immediately refresh the MCP catalog', async t => {
  const { login, relay, connect, deviceId } = await setup(t), admin = await login();
  const issued = await admin.post('/api/tokens', { name: 'Cloud supervisor', displayName: 'Planner', agentRole: 'supervisor', bindingMode: 'none', devices: [], projects: null, projectGrants: {}, scopes: ['tasks:self', 'tasks:dispatch', 'tasks:review', 'calendar:read'] });
  assert.equal(issued.status, 201);
  const { token: raw } = await issued.json() as { token: string };
  const token = relay.store.token(raw)!, client = await connect(raw);
  assert.equal(token.displayName, 'Planner'); assert.equal((await client.listTools()).tools.length, 9);
  const changed = await admin.post(`/api/authorizations/${token.family}/permissions`, { expectedRevision: 0, durationMinutes: null, permissions: { scopes: ['tasks:self'], agentRole: 'observer', bindingMode: 'none', displayName: 'Observer', devices: [], projectGrants: {}, tools: null, machineAccess: false, unrestrictedExecution: false } });
  assert.equal(changed.status, 200);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['task_inbox']);
  assert.equal((await client.callTool({ name: 'task_dispatch', arguments: { title: 'Denied', assigneePrincipalId: token.id } })).isError, true);
  assert.equal((await admin.post('/api/tokens', { name: 'Bound without device', scopes: ['tasks:self'], devices: [] })).status, 400);
  assert.equal((await admin.post('/api/tokens', { name: 'Cloud with device', bindingMode: 'none', scopes: ['tasks:self'], devices: [deviceId] })).status, 400);
});

test('dispatch enforces exact workspace, active device policy, assignee role and self-task capability', async t => {
  const { relay, supervisor, worker, dispatch, mint, deviceId } = await setup(t);
  const cloud = await dispatch({ projectId: null, deviceId: null, assigneePrincipalId: supervisor.token.id, riskLevel: 'low' });
  assert.equal(cloud.projectId, null); assert.equal(cloud.deviceId, null); assert.equal(cloud.status, 'todo'); assert.equal(cloud.leaseExpiresAt, undefined);
  await assert.rejects(dispatch({ assigneePrincipalId: supervisor.token.id }), { code: 'ERR_NO_WORKSPACE_BINDING' });
  await assert.rejects(dispatch({ deviceId: randomUUID() }), { code: 'ERR_PROJECT_NOT_GRANTED' });
  await assert.rejects(dispatch({ projectId: 'other' }), { code: 'ERR_PROJECT_NOT_GRANTED' });
  const readOnly = mint('read-only', { scopes: ['read', 'tasks:self'] });
  await assert.rejects(dispatch({ assigneePrincipalId: readOnly.token.id }), { code: 'ERR_WRITE_SCOPE_MISSING' });
  const read = await dispatch({ assigneePrincipalId: readOnly.token.id, needsWrite: false });
  assert.equal(read.needsWrite, false);
  const observer = mint('watcher', { agentRole: 'observer' });
  await assert.rejects(dispatch({ assigneePrincipalId: observer.token.id }), { code: 'assignment_forbidden' });
  await assert.rejects(dispatch({ assigneePrincipalId: 'missing' }), { code: 'ERR_ASSIGNEE_NOT_FOUND' });
  const device = relay.store.get<Device>('devices', deviceId)!;
  device.permissions!.projects[0]!.readOnly = true; relay.store.put('devices', deviceId, device);
  await assert.rejects(dispatch(), { code: 'ERR_WRITE_SCOPE_MISSING' });
  assert.equal((await supervisor.call('agent_directory')).agents.find((agent: any) => agent.id === worker.token.id).bindings[0].readOnly, true);
});

test('zero-argument inbox isolates assignments and injects current authorized workspace without renewing leases', async t => {
  const { relay, worker, supervisor, dispatch, mint, f, deviceId } = await setup(t);
  const own = await dispatch();
  const another = mint('another');
  await dispatch({ assigneePrincipalId: another.token.id });
  await dispatch({ assigneePrincipalId: supervisor.token.id, projectId: null, deviceId: null });
  const before = relay.store.get<KanbanTask>('tasks', own.id)!;
  const inbox = await worker.call('task_inbox');
  assert.deepEqual(inbox.tasks.map((task: any) => task.id), [own.id]);
  assert.deepEqual(inbox.tasks[0].workspace, { deviceId, projectId: 'workspace', root: f.root, readOnly: false, online: false });
  assert.equal(inbox.tasks[0].project_note, null);
  assert.deepEqual(relay.store.get('tasks', own.id), before);
  await assert.rejects(worker.call('task_inbox', { projectId: 'workspace' }));
  relay.store.put('authorizations', worker.token.family, { revision: 1, permanent: { agentRole: 'worker', bindingMode: 'bound_projects', scopes: ['tasks:self'], devices: [deviceId], projectGrants: { [deviceId]: ['other'] } } });
  assert.deepEqual((await worker.call('task_inbox')).tasks, []);
});

test('large task histories produce bounded inbox receipts with explicit totals instead of transport failures', async t => {
  const { relay, worker, dispatch } = await setup(t);
  const task = await dispatch();
  const stored = relay.hub.kanban.task(task.id);
  stored.messages = Array.from({ length: 5000 }, () => ({ from: 'worker', text: 'x'.repeat(1024), at: 1 }));
  relay.store.put('tasks', task.id, stored);
  const inbox = await worker.call('task_inbox');
  assert.equal(inbox.total, 1); assert.equal(inbox.truncated, false); assert.equal(inbox.tasks[0].messagesTotal, 5000); assert.equal(inbox.tasks[0].messages.length, 20);
});

test('task claims and updates fence revisions, ownership and leases, including compatibility aliases', async t => {
  const { worker, dispatch, mint, deviceId, relay } = await setup(t);
  const task = await dispatch(), other = mint('other');
  await assert.rejects(other.call('task_claim', { taskId: task.id, expectedRevision: 0 }), { code: 'task_owner_required' });
  const claims = await Promise.allSettled([worker.call('task_claim', { taskId: task.id, expectedRevision: 0 }), worker.call('task_claim', { taskId: task.id, expectedRevision: 0 })]);
  assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((claims.find(item => item.status === 'rejected') as PromiseRejectedResult).reason.code, 'conflict');
  const claimed = relay.hub.kanban.task(task.id);
  assert.equal(claimed.leaseExpiresAt! - claimed.claimedAt!, 30 * 60000);
  await assert.rejects(other.call('kanban_update_task', { projectId: 'workspace', deviceId, taskId: task.id, message: 'hijack' }), { code: 'task_owner_required' });
  await assert.rejects(worker.call('task_update', { taskId: task.id, expectedRevision: 0, message: 'stale' }), { code: 'conflict' });
  const updated = await worker.call('task_update', { taskId: task.id, expectedRevision: 1, message: 'Progress', actualPaths: ['src\\a.ts'] });
  assert.equal(updated.revision, 2); assert.deepEqual(updated.actualPaths, ['src/a.ts']); assert.equal(updated.messages.at(-1).from, worker.token.id);
  await assert.rejects(worker.call('task_update', { taskId: task.id, expectedRevision: 2, riskLevel: 'low' }));
  updated.leaseExpiresAt = Date.now() - 1; relay.store.put('tasks', task.id, updated);
  await assert.rejects(worker.call('task_submit', { taskId: task.id, expectedRevision: 2 }), { code: 'lease_expired' });
  await assert.rejects(worker.call('kanban_update_task', { projectId: 'workspace', deviceId, taskId: task.id }), { code: 'lease_expired' });
});

test('delivery applies risk gates and supervisors cannot approve high-risk or stale evidence through aliases', async t => {
  const { worker, supervisor, dispatch, relay, deviceId } = await setup(t);
  for (const riskLevel of ['low', 'medium', 'high']) {
    const task = await dispatch({ riskLevel, requiresReview: false });
    await worker.call('task_claim', { taskId: task.id, expectedRevision: 0 });
    const submitted = await worker.call('task_submit', { taskId: task.id, expectedRevision: 1, aiSummary: 'Delivered', fileHashes: { 'a.ts': 'a'.repeat(64) } });
    assert.equal(submitted.status, riskLevel === 'low' ? 'done' : 'review');
    if (riskLevel === 'high') {
      await assert.rejects(supervisor.call('task_review', { taskId: task.id, expectedRevision: 2, action: 'approve' }), { code: 'admin_review_required' });
      await assert.rejects(worker.call('kanban_complete_task', { projectId: 'workspace', deviceId, taskId: task.id, skipReview: true }), { code: 'admin_review_required' });
      assert.equal(relay.hub.kanban.task(task.id).status, 'review');
    }
    if (riskLevel === 'medium') {
      relay.hub.kanban.recordActualPaths('workspace', 'external-worker', deviceId, ['a.ts']);
      await assert.rejects(supervisor.call('task_review', { taskId: task.id, expectedRevision: 3, action: 'approve' }), { code: 'admin_review_required' });
      const revised = await supervisor.call('task_review', { taskId: task.id, expectedRevision: 3, action: 'revise', reason: 'Refresh evidence' });
      assert.equal(revised.status, 'in_progress'); assert.equal(revised.reviewFingerprints, undefined);
      const fresh = await worker.call('task_submit', { taskId: task.id, expectedRevision: revised.revision });
      const approved = await supervisor.call('task_review', { taskId: task.id, expectedRevision: fresh.revision, action: 'approve' });
      assert.equal(approved.status, 'done');
      const reopened = await supervisor.call('task_review', { taskId: task.id, expectedRevision: approved.revision, action: 'reopen', reason: 'Follow-up' });
      assert.equal(reopened.status, 'todo'); assert.equal(reopened.assigneePrincipalId, null);
    }
  }
});

test('test-job evidence must match the owner and exact task workspace and survives submission', async t => {
  const { relay, worker, dispatch, deviceId } = await setup(t);
  const task = await dispatch(); await worker.call('task_claim', { taskId: task.id, expectedRevision: 0 });
  const job = { id: randomUUID(), owner: 'someone-else', deviceId, projectId: 'workspace', state: 'exited', exitCode: 0, started: Date.now() - 100, finished: Date.now() };
  relay.store.put('jobs', `${deviceId}:${job.id}`, job);
  await assert.rejects(worker.call('task_update', { taskId: task.id, expectedRevision: 1, testJobId: job.id }), { code: 'invalid_test_job' });
  relay.store.put('jobs', `${deviceId}:${job.id}`, { ...job, owner: worker.token.id, state: 'running', finished: undefined });
  const running = await worker.call('task_update', { taskId: task.id, expectedRevision: 1, testJobId: job.id });
  assert.equal(running.evidence.testPassed, undefined, 'a running test has not failed');
  relay.store.put('jobs', `${deviceId}:${job.id}`, { ...job, owner: worker.token.id });
  const updated = await worker.call('task_update', { taskId: task.id, expectedRevision: 2, testJobId: job.id });
  assert.equal(updated.evidence.testPassed, true);
  const submitted = await worker.call('task_submit', { taskId: task.id, expectedRevision: 3, aiSummary: 'Tests passed' });
  assert.equal(submitted.evidence.testJobId, job.id); assert.equal(submitted.evidence.aiSummary, 'Tests passed');
});

test('review staleness is isolated by device even when project IDs and relative paths match', async t => {
  const { relay, worker, dispatch, deviceId } = await setup(t);
  const task = await dispatch(); await worker.call('task_claim', { taskId: task.id, expectedRevision: 0 });
  await worker.call('task_submit', { taskId: task.id, expectedRevision: 1, fileHashes: { 'a.ts': 'a'.repeat(64) } });
  relay.hub.kanban.recordActualPaths('workspace', 'another-worker', 'another-device', ['a.ts']);
  assert.equal(relay.hub.kanban.task(task.id).reviewStalePaths, undefined);
  assert.deepEqual(relay.hub.kanban.checkReviewFingerprint('workspace', ['a.ts'], 'another-device'), []);
  relay.hub.kanban.recordActualPaths('workspace', 'another-worker', deviceId, ['a.ts']);
  assert.deepEqual(relay.hub.kanban.task(task.id).reviewStalePaths, ['a.ts']);
});

test('administrator can create directory-free tasks, see enriched agents and approve high-risk work', async t => {
  const { supervisor, relay, login } = await setup(t), admin = await login();
  const response = await admin.post('/api/kanban/tasks', { projectId: null, title: 'Research', assigneePrincipalId: supervisor.token.id, riskLevel: 'high', dueAt: Date.now() + 86400000 });
  assert.equal(response.status, 201);
  const task = (await response.json() as any).task;
  assert.equal(task.status, 'todo'); assert.equal(task.projectId, null);
  const board = await (await admin.get('/api/kanban/board?projectId=~')).json() as any;
  assert.equal(board.columns.todo.total, 1); assert.equal(board.calendar.enabled, false);
  assert.equal((await admin.get('/api/kanban/calendar')).status, 200);
  const agents = await (await admin.get('/api/kanban/assignees?projectId=workspace')).json() as any;
  const cloud = agents.agents.find((agent: any) => agent.id === supervisor.token.id);
  assert.equal(cloud.eligible, false); assert.equal(cloud.bindingMode, 'none'); assert.equal(cloud.reason, '仅支持非代码任务');
  await supervisor.call('task_claim', { taskId: task.id, expectedRevision: 0 });
  await supervisor.call('task_submit', { taskId: task.id, expectedRevision: 1 });
  const approved = await admin.post(`/api/kanban/tasks/${task.id}/approve`, { projectId: null, expectedRevision: 2 });
  assert.equal(approved.status, 200); assert.equal(relay.hub.kanban.task(task.id).status, 'done');
});

test('blocked tasks accept loss-of-write reports and CSRF-protected temporary elevation restores only for 30 minutes', async t => {
  const { worker, dispatch, relay, deviceId, login } = await setup(t), admin = await login();
  const task = await dispatch(); await worker.call('task_claim', { taskId: task.id, expectedRevision: 0 });
  const permanent = { agentRole: 'worker', bindingMode: 'bound_projects', scopes: ['read', 'tasks:self'], devices: [deviceId], projectGrants: { [deviceId]: ['workspace'] }, tools: null, machineAccess: false, unrestrictedExecution: false };
  relay.store.put('authorizations', worker.token.family, { revision: 1, permanent });
  const blocked = await worker.call('task_block', { taskId: task.id, expectedRevision: 1, blockReason: 'write scope missing', needHuman: true });
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.leaseExpiresAt, undefined);
  const elevated = await admin.post(`/api/kanban/tasks/${task.id}/elevate`, { projectId: 'workspace', expectedRevision: 2, scopes: ['write'] });
  assert.equal(elevated.status, 200); assert.equal(relay.hub.kanban.task(task.id).status, 'todo'); assert.equal(relay.hub.kanban.task(task.id).assigneePrincipalId, worker.token.id);
  const current = relay.store.token(worker.raw)!;
  assert.ok(current.scopes.includes('write')); assert.ok(!current.scopes.includes('execute'));
  assert.ok(Math.abs(current.authorizationExpiresAt! - Date.now() - 30 * 60000) < 1000);
  assert.deepEqual(current.projectGrants, permanent.projectGrants);
  const now = Date.now;
  try { Date.now = () => current.authorizationExpiresAt! + 1; relay.store.expireAuthorizations(); assert.ok(!relay.store.token(worker.raw)!.scopes.includes('write')); }
  finally { Date.now = now; }
  assert.equal((await admin.post(`/api/kanban/tasks/${task.id}/elevate`, { projectId: 'workspace', expectedRevision: 2, scopes: ['write'] })).status, 409);
});

test('unchanged protocol-v2 Runner completes the supervisor-to-worker MCP flow and inbox includes bounded cached project notes', async t => {
  const { worker, supervisor, dispatch, startRunner, connect, mint, f, relay, deviceId } = await setup(t);
  await startRunner();
  const client = await connect(worker.raw);
  const task = await dispatch({ riskLevel: 'medium' });
  const inbox = data(await client.callTool({ name: 'task_inbox', arguments: {} }) as ToolResult);
  assert.equal(inbox.tasks[0].workspace.online, true); assert.equal(inbox.tasks[0].workspace.root, f.root);
  const claim = data(await client.callTool({ name: 'task_claim', arguments: { taskId: task.id, expectedRevision: 0 } }) as ToolResult);
  assert.equal(claim.task.status, 'in_progress');
  assert.equal((await client.callTool({ name: 'save_project_note', arguments: { deviceId, projectId: 'workspace', text: 'Next: verify the regression.' } })).isError, undefined);
  const next = data(await client.callTool({ name: 'task_inbox', arguments: {} }) as ToolResult);
  assert.equal(next.tasks[0].project_note.text, 'Next: verify the regression.');
  const submitted = data(await client.callTool({ name: 'task_submit', arguments: { taskId: task.id, expectedRevision: 1, aiSummary: 'Completed' } }) as ToolResult);
  assert.equal(submitted.status, 'review');
  const approved = await supervisor.call('task_review', { taskId: task.id, expectedRevision: 2, action: 'approve' });
  assert.equal(approved.status, 'done');
  const observer = mint('readonly-observer', { agentRole: 'observer', scopes: ['read', 'write', 'execute', 'tasks:self'] });
  const diagnostics = await observer.call('lsp_diagnostics', { projectId: 'workspace', deviceId, serverExecutable: process.execPath });
  assert.equal(diagnostics.error, 'forbidden'); assert.match(diagnostics.message, /execute scope/);
  assert.equal(relay.store.get<Device>('devices', deviceId)!.runnerProtocol, 2);
});
