import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { AssistConsent } from '../src/runner/assist-consent.js';
import { assistProject, type AssistApproval, type AssistDescriptor } from '../src/shared/assist.js';
import { Tools } from '../src/runner/tools.js';
import type { Principal, ToolResult } from '../src/shared/protocol.js';
import { fixture } from './helpers.js';

const data = (value: ToolResult) => JSON.parse(value.content[0]!.text);
function local(root: string, scopes: AssistApproval['scopes'] = ['read']) {
  const now = Date.now(), approval: AssistApproval = { root, scopes, commands: scopes.includes('execute') ? [process.execPath] : [], durationMinutes: 30, approvedAt: now, expiresAt: now + 1800000 };
  const descriptor: AssistDescriptor = { sessionId: randomUUID(), deviceId: randomUUID(), inviteId: randomUUID(), operatorId: 'operator', deviceOwnerId: randomUUID(), authorizationId: randomUUID(), authorizationRevision: 0, localConsentRevision: 1, approval };
  const principal: Principal = { id: 'operator', scopes: ['read', 'write', 'execute', 'git'], devices: [descriptor.deviceId], projects: ['assist'], authorizationId: descriptor.authorizationId, authorizationRevision: 0, assist: { sessionId: descriptor.sessionId, localConsentRevision: 1 } };
  return { approval, descriptor, principal };
}
test('local ceiling rejects server roots, programs, profiles, fallback and missing session context', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const x = local(f.root), consent = new AssistConsent(x.approval); consent.bind(x.descriptor); consent.activate();
  const policy = { revision: 1, projects: [assistProject(x.approval)], expiresAt: x.approval.expiresAt, fallbackProjects: [] };
  assert.ok(consent.validatePermissions(policy));
  for (const change of [{ root: f.outside }, { commandMode: 'unrestricted' }, { filesystemScope: 'device' }, { commands: [process.execPath] }, { deniedNames: [] }, { environmentProfiles: { secret: { env: { KEY: 'value' }, inherit: [] } } }]) assert.throws(() => consent.validatePermissions({ ...policy, projects: [{ ...policy.projects[0]!, ...change } as any] }), /exceeds/);
  assert.throws(() => consent.validatePermissions({ ...policy, fallbackProjects: policy.projects }), /exceeds/);
  assert.throws(() => consent.assertCall({ ...x.principal, assist: undefined }), /match/);
  assert.throws(() => consent.assertCall(x.principal, 'write_file', 'assist'), /outside/);
  consent.revoke(); assert.throws(() => consent.assertCall(x.principal), /ended/);
});
test('monotonic expiry cannot be extended by a wall-clock rollback or server deadline', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const x = local(f.root); let wall = x.approval.approvedAt, monotonic = 0;
  const consent = new AssistConsent(x.approval, { wall: () => wall, monotonic: () => monotonic });
  consent.bind(x.descriptor); consent.activate(); wall -= 600000; monotonic = 1800001;
  assert.throws(() => consent.assertCall(x.principal), /ended/);
});
test('local scopes independently gate writes and execution and revoke queued mutations', async t => {
  const f = await fixture(), x = local(f.root, ['read', 'execute']);
  const consent = new AssistConsent(x.approval); consent.bind(x.descriptor); consent.activate();
  f.config.projects = [assistProject(x.approval)];
  const tools = new Tools(f.config, x.descriptor.deviceId, consent);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  await writeFile(path.join(f.root, 'hello.txt'), 'hello');
  assert.equal(data(await tools.invoke('read_file', { projectId: 'assist', path: 'hello.txt' }, x.principal)).text, 'hello');
  assert.equal(data(await tools.invoke('write_file', { projectId: 'assist', path: 'hello.txt', content: 'changed' }, x.principal)).error, 'assist_forbidden');
  consent.revoke();
  assert.equal(data(await tools.invoke('start_process', { projectId: 'assist', executable: process.execPath }, x.principal)).error, 'assist_ended');
  assert.equal(await readFile(path.join(f.root, 'hello.txt'), 'utf8'), 'hello');
});
test('locally approved programs cannot be replaced from the shared project', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const program = path.join(f.root, 'program.exe'); await writeFile(program, 'not a trusted installation');
  const x = local(f.root, ['read', 'execute']);
  await assert.rejects(AssistConsent.approve(f.config, { ...x.approval, commands: [program] }), /outside the shared/);
});

test('queued writes are fenced after local revocation', async t => {
  const f = await fixture(), x = local(f.root, ['read', 'write']);
  const consent = new AssistConsent(x.approval); consent.bind(x.descriptor); consent.activate();
  f.config.projects = [assistProject(x.approval)];
  const tools = new Tools(f.config, x.descriptor.deviceId, consent);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = tools.editor.assertWritable.bind(tools.editor);
  tools.editor.assertWritable = async project => { await blocked; await original(project); };
  const first = tools.invoke('write_file', { projectId: 'assist', path: 'first.txt', content: 'first' }, x.principal);
  const queued = tools.invoke('write_file', { projectId: 'assist', path: 'queued.txt', content: 'queued' }, x.principal);
  consent.revoke(); release();
  assert.equal((await first).isError, true); assert.equal((await queued).isError, true);
  await assert.rejects(readFile(path.join(f.root, 'queued.txt')), { code: 'ENOENT' });
});
