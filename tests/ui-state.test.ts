import test from 'node:test';
import assert from 'node:assert/strict';
import { accessRole, rolePermissions, projectAccess, initialDuration, nextProjectId, devicePolicyStatus, gitPermissions, projectTargetChoices } from '../public/ui.js';

test('simple access presets grant development without enabling device-wide files, and preserve custom grants as custom', () => {
  const read = rolePermissions('read'), full = rolePermissions('full');
  assert.deepEqual(read.scopes, ['read']);
  assert.equal(read.unrestrictedExecution, false);
  assert.deepEqual(full.scopes, ['read', 'write', 'execute', 'git']);
  assert.equal(full.unrestrictedExecution, true);
  assert.equal(full.machineAccess, false);
  assert.equal(accessRole(read), 'read');
  assert.equal(accessRole(full), 'full');
  assert.equal(accessRole({ ...full, scopes: ['read', 'write'] }), 'custom');
  assert.equal(accessRole({ ...full, tools: ['read_file'] }), 'custom');
  assert.equal(accessRole({ ...full, machineAccess: true }), 'custom');
  assert.equal(projectAccess({ readOnly: false, commandMode: 'allowlist', filesystemScope: 'project' }), 'custom');
});

test('the single Git switch controls local writes, network access and pushes together', () => {
  assert.deepEqual(gitPermissions(true), { allowGitWrite: true, allowGitNetwork: true, allowGitPush: true });
  assert.deepEqual(gitPermissions(false), { allowGitWrite: false, allowGitNetwork: false, allowGitPush: false });
});

test('editing permanent settings keeps permanent duration and project additions do not reuse an existing id', () => {
  const now = 1000000;
  assert.equal(initialDuration(null, now), 'permanent');
  assert.equal(initialDuration(now - 1, now), 'permanent');
  assert.equal(initialDuration(now + 15 * 60000, now), '15');
  assert.equal(initialDuration(now + 20 * 1000, now), '1');
  const id = nextProjectId(['project-1', 'project-3']);
  assert.match(id, /^project-[a-f0-9]{32}$/);
  assert.notEqual(nextProjectId([]), id);
});

test('authorization choices preserve unavailable selections without expanding new token targets', () => {
  const device = { projects: [{ id: 'a', name: 'A' }], projectCatalog: [{ id: 'a', name: 'A', status: 'applied' }, { id: 'b', name: 'B', status: 'fallback' }] };
  assert.deepEqual(projectTargetChoices(device, ['a', 'b', 'removed']).map(project => project.id), ['a']);
  const choices = projectTargetChoices(device, ['a', 'b', 'removed'], true);
  assert.deepEqual(choices.map(project => project.id), ['a', 'b', 'removed']);
  assert.equal(choices[1].status, 'fallback');
  assert.equal(choices[2].status, 'removed');
});

test('saving a policy distinguishes Server persistence from Runner application', () => {
  assert.equal(devicePolicyStatus({ online: false }, 2).tone, 'pending');
  assert.equal(devicePolicyStatus({ online: true, permissionAppliedRevision: 1 }, 2).tone, 'pending');
  assert.equal(devicePolicyStatus({ online: true, permissionAppliedRevision: 2 }, 2).tone, 'success');
  assert.equal(devicePolicyStatus({ online: true, permissionError: 'directory missing' }, 2).tone, 'error');
});
