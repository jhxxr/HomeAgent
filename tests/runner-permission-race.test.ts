import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RunnerPermissions } from '../src/runner/permissions.js';
import type { AssistConsent } from '../src/runner/assist-consent.js';
import type { Tools } from '../src/runner/tools.js';
import type { RemotePermissions } from '../src/shared/permissions.js';
import { fixture } from './helpers.js';

async function permissionsFixture(t: TestContext, consent?: AssistConsent) {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const permanent = f.config.projects.map(project => ({ ...project, commands: [], allowGitWrite: false }));
  const temporary: RemotePermissions = {
    revision: 1,
    projects: permanent.map(project => ({ ...project, id: 'temporary', commandMode: 'unrestricted', filesystemScope: 'device' })),
    expiresAt: Date.now() + 1000,
    fallbackProjects: permanent,
  };
  const replacement: RemotePermissions = {
    revision: 2,
    projects: permanent.map(project => ({ ...project, id: 'replacement', readOnly: true })),
    expiresAt: Date.now() + 10_000,
    fallbackProjects: permanent,
  };
  const tools = {
    policy: { expiresAt: undefined as number | undefined },
    processes: { stopAllAndWait: t.mock.fn(async () => {}) },
    editor: { reconcileProjects: t.mock.fn(async () => {}) },
  };
  const invalidate = t.mock.fn(async () => {});
  const changes: Array<{ revision: number; error?: string; projects: string[] }> = [];
  const expired = Promise.withResolvers<void>();
  const manager = new RunnerPermissions(f.config, tools as unknown as Tools, invalidate, (revision, error) => {
    changes.push({ revision, error, projects: f.config.projects.map(project => project.id) });
    expired.resolve();
  }, consent);
  t.after(async () => { manager.close(); t.mock.timers.reset(); await f.cleanup(); });
  return { f, manager, tools, invalidate, permanent, temporary, replacement, changes, expired: expired.promise };
}

function deferredOperation() {
  const entered = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => finished.resolve(),
    wait: async () => { entered.resolve(); await finished.promise; },
  };
}

async function assertReplacementActive(h: Awaited<ReturnType<typeof permissionsFixture>>) {
  // A rejected old revision drains preceding queue work without changing the active policy.
  await assert.rejects(h.manager.apply({ ...h.replacement, revision: 0 }), { code: 'stale_permissions' });
  assert.deepEqual(h.f.config.projects, h.replacement.projects);
  assert.equal(h.tools.policy.expiresAt, h.replacement.expiresAt);
  assert.equal(h.invalidate.mock.callCount(), 2);
  assert.equal(h.tools.processes.stopAllAndWait.mock.callCount(), 2);
  assert.equal(h.tools.editor.reconcileProjects.mock.callCount(), 2);
  assert.deepEqual(h.changes, [], 'An obsolete expiration must not report a change or error');
}

for (const phase of ['invalidate', 'stopAllAndWait'] as const) {
  test(`an old expiration cannot clear an update awaiting ${phase}`, async t => {
    const h = await permissionsFixture(t);
    await h.manager.apply(h.temporary);
    const blocker = deferredOperation();
    t.after(blocker.release);
    const operation = phase === 'invalidate' ? h.invalidate : h.tools.processes.stopAllAndWait;
    operation.mock.mockImplementationOnce(blocker.wait);
    const updating = h.manager.apply(h.replacement);
    await blocker.entered;
    t.mock.timers.tick(1000);
    blocker.release();
    await updating;
    await assertReplacementActive(h);
  });
}

test('an expiration queued behind a newer update is obsolete when it executes', async t => {
  const h = await permissionsFixture(t);
  await h.manager.apply(h.temporary);
  const blocker = deferredOperation();
  t.after(blocker.release);
  h.tools.processes.stopAllAndWait.mock.mockImplementationOnce(blocker.wait);
  const updating = h.manager.apply(h.replacement);
  // Fire before the queued apply starts: clearing its timer later cannot remove this queued expiration.
  t.mock.timers.tick(1000);
  await blocker.entered;
  blocker.release();
  await updating;
  await assertReplacementActive(h);
});

test('normal expiration waits for task shutdown, restores fallback and reports success once', async t => {
  const h = await permissionsFixture(t);
  await h.manager.apply(h.temporary);
  const blocker = deferredOperation();
  t.after(blocker.release);
  h.tools.processes.stopAllAndWait.mock.mockImplementationOnce(blocker.wait);
  t.mock.timers.tick(1000);
  await blocker.entered;
  assert.equal(h.tools.editor.reconcileProjects.mock.callCount(), 1, 'Fallback must wait for old tasks to stop');
  assert.deepEqual(h.changes, []);
  blocker.release();
  await h.expired;
  assert.deepEqual(h.f.config.projects, h.permanent);
  assert.equal(h.tools.policy.expiresAt, undefined);
  assert.equal(h.invalidate.mock.callCount(), 3);
  assert.equal(h.tools.processes.stopAllAndWait.mock.callCount(), 3);
  assert.equal(h.tools.editor.reconcileProjects.mock.callCount(), 2);
  assert.deepEqual(h.changes, [{ revision: 1, error: undefined, projects: ['workspace'] }]);
  t.mock.timers.tick(20_000);
  await assert.rejects(h.manager.apply({ ...h.temporary, revision: 0 }), { code: 'stale_permissions' });
  assert.equal(h.changes.length, 1, 'The permanent fallback must not arm another expiration');
  assert.deepEqual(h.f.config.projects, h.permanent);
});

test('expiration reset and fallback finish before an update queued during shutdown', async t => {
  const h = await permissionsFixture(t);
  await h.manager.apply(h.temporary);
  const blocker = deferredOperation();
  t.after(blocker.release);
  h.tools.processes.stopAllAndWait.mock.mockImplementationOnce(blocker.wait);
  t.mock.timers.tick(1000);
  await blocker.entered;
  const updating = h.manager.apply(h.replacement);
  blocker.release();
  await Promise.all([h.expired, updating]);
  assert.deepEqual(h.changes, [{ revision: 1, error: undefined, projects: ['workspace'] }]);
  assert.deepEqual(h.f.config.projects, h.replacement.projects);
  assert.equal(h.tools.policy.expiresAt, h.replacement.expiresAt);
  assert.equal(h.tools.processes.stopAllAndWait.mock.callCount(), 4);
});

test('expiration with an invalid fallback stays closed and reports the failure', async t => {
  const h = await permissionsFixture(t);
  await h.manager.apply({
    ...h.temporary,
    fallbackProjects: h.permanent.map(project => ({ ...project, root: path.join(h.f.outside, 'missing') })),
  });
  t.mock.timers.tick(1000);
  await h.expired;
  assert.deepEqual(h.f.config.projects, []);
  assert.equal(h.tools.policy.expiresAt, undefined);
  assert.equal(h.tools.processes.stopAllAndWait.mock.callCount(), 3);
  assert.equal(h.changes.length, 1);
  assert.equal(h.changes[0]!.revision, 1);
  assert.match(h.changes[0]!.error!, /ENOENT/);
  assert.deepEqual(h.changes[0]!.projects, []);
});

test('Assist expiration revokes consent instead of restoring a fallback', async t => {
  const consent = {
    validatePermissions: t.mock.fn((policy: RemotePermissions) => policy),
    revoke: t.mock.fn(() => {}),
  };
  const h = await permissionsFixture(t, consent as unknown as AssistConsent);
  const policy = { ...h.temporary, fallbackProjects: [] };
  await h.manager.apply(policy);
  t.mock.timers.tick(1000);
  await assert.rejects(h.manager.apply({ ...policy, revision: 0 }), { code: 'stale_permissions' });
  assert.equal(consent.revoke.mock.callCount(), 1);
  assert.equal(h.tools.processes.stopAllAndWait.mock.callCount(), 1);
  assert.deepEqual(h.changes, []);
});
