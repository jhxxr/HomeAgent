import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { AssistConsent } from '../src/runner/assist-consent.js';
import { Tools } from '../src/runner/tools.js';
import { Agent } from '../src/runner/agent.js';
import { createHomeServer } from '../src/server/app.js';
import { ASSIST_FEATURE, ASSIST_MULTI_FEATURE, assistProjects, assistMultiApprovalSchema, type AssistMultiApproval, type AssistAnyDescriptor } from '../src/shared/assist.js';
import { type Principal, type ToolResult } from '../src/shared/protocol.js';
import { hash } from '../src/server/store.js';
import { fixture, freePort, waitFor } from './helpers.js';

const data = (value: ToolResult) => JSON.parse(value.content[0]!.text);
function approval(first: string, second: string): AssistMultiApproval {
  const now = Date.now();
  return { projects: [
    { id: 'source', name: '源码', root: first, scopes: ['read', 'write', 'execute'], commands: [process.execPath] },
    { id: 'reference', name: '只读资料', root: second, scopes: ['read'], commands: [] },
  ], durationMinutes: 30, approvedAt: now, expiresAt: now + 1800000 };
}
function descriptor(approval: AssistMultiApproval): AssistAnyDescriptor {
  return { sessionId: randomUUID(), deviceId: randomUUID(), inviteId: randomUUID(), operatorId: 'operator', deviceOwnerId: randomUUID(), authorizationId: randomUUID(), authorizationRevision: 0, localConsentRevision: 1, approval };
}
function principal(value: AssistAnyDescriptor): Principal {
  return { id: value.operatorId, scopes: ['read', 'write', 'execute'], devices: [value.deviceId], projects: null, authorizationId: value.authorizationId, authorizationRevision: 0, assist: { sessionId: value.sessionId, localConsentRevision: value.localConsentRevision } };
}

test('multi-project consent validates the entire set and independently fences each project', async t => {
  const f = await fixture(), input = approval(f.root, f.outside), identity = descriptor(input), consent = await AssistConsent.approve(f.config, input);
  consent.bind(identity); consent.activate();
  const policy = { revision: 1, projects: assistProjects(input), fallbackProjects: [], expiresAt: input.expiresAt };
  assert.deepEqual(consent.validatePermissions(policy), policy);
  consent.assertProject(policy.projects[0]!); consent.assertProject(policy.projects[1]!);
  assert.throws(() => consent.validatePermissions({ ...policy, projects: policy.projects.slice(0, 1) }), /exceeds/);
  assert.throws(() => consent.validatePermissions({ ...policy, projects: [policy.projects[0]!, policy.projects[0]!] }), /exceeds/);
  for (const change of [{ root: f.root }, { readOnly: false }, { commands: [process.execPath] }, { deniedNames: [] }, { commandMode: 'unrestricted' }]) {
    assert.throws(() => consent.validatePermissions({ ...policy, projects: [policy.projects[0]!, { ...policy.projects[1]!, ...change } as any] }), /exceeds/);
  }
  f.config.projects = policy.projects;
  const tools = new Tools(f.config, identity.deviceId, consent), caller = principal(identity);
  t.after(async () => { consent.close(); await tools.close(); await f.cleanup(); });
  await writeFile(path.join(f.outside, 'reference.txt'), 'read only');
  assert.equal((await tools.invoke('write_file', { projectId: 'source', path: 'source.txt', content: 'editable' }, caller)).isError, undefined);
  assert.equal(data(await tools.invoke('read_file', { projectId: 'reference', path: 'reference.txt' }, caller)).text, 'read only');
  assert.equal(data(await tools.invoke('write_file', { projectId: 'reference', path: 'reference.txt', content: 'no' }, caller)).error, 'assist_forbidden');
  assert.equal(data(await tools.invoke('start_process', { projectId: 'reference', executable: process.execPath }, caller)).error, 'assist_forbidden');
  assert.equal(data(await tools.invoke('read_file', { projectId: 'third', path: 'reference.txt' }, caller)).error, 'assist_forbidden');
  assert.equal(data(await tools.invoke('read_file', { projectId: 'source', path: path.join(f.outside, 'reference.txt') }, caller)).error, 'path_escape');
  assert.equal(await readFile(path.join(f.outside, 'reference.txt'), 'utf8'), 'read only');
  consent.revoke();
  for (const projectId of ['source', 'reference']) assert.equal(data(await tools.invoke('read_file', { projectId, path: 'any.txt' }, caller)).error, 'assist_ended');
});

test('multi-project validation rejects overlap, shared executable substitution and full-set bind tampering', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const input = approval(f.root, f.outside);
  const child = path.join(f.root, 'child'); await mkdir(child);
  await assert.rejects(AssistConsent.approve(f.config, approval(f.root, f.root)), /overlap/);
  await assert.rejects(AssistConsent.approve(f.config, approval(f.root, child)), /overlap/);
  await assert.rejects(AssistConsent.approve(f.config, approval(f.root, f.directory)), /exclude Runner/);
  const installed = path.join(f.outside, 'program.exe'); await writeFile(installed, 'not installed outside shared roots');
  await assert.rejects(AssistConsent.approve(f.config, { ...input, projects: [{ ...input.projects[0]!, commands: [installed] }, input.projects[1]!] }), /outside the shared/);
  assert.throws(() => assistMultiApprovalSchema.parse({ ...input, projects: [input.projects[0]!, input.projects[0]!] }), /unique/);
  const identity = descriptor(input), consent = new AssistConsent(input);
  assert.throws(() => consent.bind({ ...identity, approval: { ...input, projects: [{ ...input.projects[0]!, name: 'changed' }, input.projects[1]!] } }), /changed/);
  consent.bind(identity);
  assert.throws(() => consent.bind(identity), /changed/);
  consent.close();
});

test('v2 claims preserve the client credential, discover per-project scopes and stop every project task', async t => {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const server = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'server.sqlite'), password: 'multi-assist-test-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 1 });
  await server.listen();
  let agent: Agent | undefined;
  t.after(async () => { await agent?.close(); await server.close(); await f.cleanup(); });
  const family = randomUUID(), raw = server.store.mintToken({ id: 'operator', kind: 'pat', clientId: 'multi-test', family, scopes: ['read', 'write', 'execute'], devices: [], projects: [], expires: Date.now() + 60000 });
  const login = await fetch(base + '/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'multi-assist-test-password' }), redirect: 'manual' });
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as any;
  const post = (route: string, body: unknown, admin = false) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(admin ? { cookie, origin: base, 'x-csrf-token': state.csrf } : {}) }, body: JSON.stringify(body) });
  const invite = await (await post('/api/assist/invites', { authorizationId: family, operatorName: '开发者', scopes: ['read', 'write', 'execute'], maxDurationMinutes: 30 }, true)).json() as any;
  const values = new URLSearchParams(new URL(invite.link).hash.slice(1)), key = { id: values.get('id'), token: values.get('token') };
  assert.equal((await (await post('/assist/inspect', key)).json() as any).feature, ASSIST_FEATURE);
  assert.equal((await (await post('/assist/v2/inspect', key)).json() as any).feature, ASSIST_MULTI_FEATURE);
  const input = approval(f.root, f.outside);
  assert.equal((await post('/assist/claim', { ...key, feature: ASSIST_FEATURE, name: 'friend', approval: input })).status, 400);
  const claim = await post('/assist/v2/claim', { ...key, feature: ASSIST_MULTI_FEATURE, name: 'friend', approval: input });
  assert.equal(claim.status, 201);
  const claimed = await claim.json() as any;
  const token = server.store.token(raw)!, context = { family, tokenHash: token.tokenHash };
  const before = server.store.get<any>('tokens', hash(raw));
  f.config.server = base;
  const consent = new AssistConsent(input); consent.bind(claimed.descriptor);
  agent = new Agent(f.config, { server: base, deviceId: claimed.descriptor.deviceId, token: claimed.token }, () => {}, () => {}, consent); agent.start();
  await waitFor(() => server.hub.assist.get(claimed.descriptor.sessionId)?.state === 'active');
  const device = server.hub.devices(token)[0]!;
  assert.deepEqual((device.projects[0] as any).scopes, ['read', 'write', 'execute']);
  assert.deepEqual((device.projects[1] as any).scopes, ['read']);
  assert.equal((device.projects[1] as any).executionPolicy.executeScopeGranted, false);
  const call = (tool: string, projectId: string, args: Record<string, unknown> = {}) => server.hub.invoke(token, tool, { deviceId: device.id, projectId, ...args }, undefined, context);
  await writeFile(path.join(f.outside, 'reference.txt'), 'read only');
  assert.equal(data(await call('read_file', 'reference', { path: 'reference.txt' })).text, 'read only');
  assert.equal((await call('write_file', 'source', { path: 'hello.txt', content: 'hello' })).isError, undefined);
  await assert.rejects(call('write_file', 'reference', { path: 'no.txt', content: 'no' }), /scope/);
  await assert.rejects(call('start_process', 'reference', { executable: process.execPath }), /scope/);
  await assert.rejects(call('read_file', 'third', { path: 'hello.txt' }), /not authorized/);
  await assert.rejects(server.hub.invoke(token, 'read_file', { projectId: 'source', path: 'hello.txt' }, undefined, context), /deviceId/);
  const executableApproval: AssistMultiApproval = { ...input, projects: input.projects.map(project => ({ ...project, scopes: ['read', 'execute'], commands: [process.execPath] })) };
  // This session remains immutable; create a separate locally approved two-job fixture.
  await agent.stopAssist('local_stop');
  await waitFor(() => server.hub.assist.get(claimed.descriptor.sessionId)?.cleanup === 'confirmed');
  assert.equal(server.store.audits(100).find(event => event.tool === 'assist.ended' && event.deviceId === claimed.descriptor.deviceId)?.projectId, '');
  await agent.close(); agent = undefined;
  const invite2 = await (await post('/api/assist/invites', { authorizationId: family, operatorName: '开发者', scopes: ['read', 'execute'], maxDurationMinutes: 30 }, true)).json() as any;
  const values2 = new URLSearchParams(new URL(invite2.link).hash.slice(1));
  const next = await (await post('/assist/v2/claim', { id: values2.get('id'), token: values2.get('token'), feature: ASSIST_MULTI_FEATURE, name: 'two jobs', approval: executableApproval })).json() as any;
  const nextConsent = new AssistConsent(executableApproval); nextConsent.bind(next.descriptor);
  agent = new Agent(f.config, { server: base, deviceId: next.descriptor.deviceId, token: next.token }, () => {}, () => {}, nextConsent); agent.start();
  await waitFor(() => server.hub.assist.get(next.descriptor.sessionId)?.state === 'active');
  const jobs = [];
  for (const project of executableApproval.projects) jobs.push(data(await server.hub.invoke(token, 'start_process', { deviceId: next.descriptor.deviceId, projectId: project.id, executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, undefined, context)));
  assert.ok(jobs.every(job => job.id));
  assert.equal(data(await server.hub.invoke(token, 'read_process_output', { deviceId: next.descriptor.deviceId, projectId: 'reference', processId: jobs[0].id }, undefined, context)).error, 'unknown_process');
  await agent.stopAssist('local_stop');
  await waitFor(() => server.hub.assist.get(next.descriptor.sessionId)?.cleanup === 'confirmed');
  assert.ok(jobs.every(job => agent!.tools.processes.snapshot().find(item => item.id === job.id)?.state === 'stopped'));
  await waitFor(() => jobs.every(job => server.hub.jobMirror.get(next.descriptor.deviceId, job.id)?.state === 'stopped'));
  assert.deepEqual(server.store.get<any>('tokens', hash(raw)), before);
});
