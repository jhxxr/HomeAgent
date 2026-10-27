import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeConsole, auditTimeline, jobLabel } from '../public/console-model.js';

test('overview distinguishes live executions from disconnected and retained observations', () => {
  const model = summarizeConsole({ jobs: [
    { id: 'live', state: 'running', available: true, observation: 'live' },
    { id: 'stopping', state: 'stopping', available: true, observation: 'live' },
    { id: 'offline', state: 'running', available: false, observation: 'unconfirmed' },
    { id: 'missing', state: 'starting', available: true, observation: 'missing' },
    { id: 'retained', state: 'exited', available: false, observation: 'retained' },
  ] });
  assert.deepEqual(model.activeJobs.map(job => job.id), ['live', 'stopping']);
  assert.deepEqual(model.unconfirmedJobs.map(job => job.id), ['offline', 'missing']);
  assert.equal(jobLabel('stopping'), '停止中');
});

test('empty snapshots do not imply clients, machines, latency or audit success', () => {
  const model = summarizeConsole();
  assert.deepEqual(model.clients, []); assert.deepEqual(model.runners, []);
  assert.deepEqual(model.outcomes, { ok: 0, other: 0, total: 0 });
  assert.equal(model.medianDuration, null); assert.equal(model.projects, 0);
  assert.deepEqual(auditTimeline([]).buckets.map(bucket => bucket.total), Array(20).fill(0));
});

test('client grouping counts project identity per device and ignores revoked or expired usage', () => {
  const now = 100000;
  const model = summarizeConsole({
    clients: [{ id: 'cursor', name: 'Cursor' }, { id: 'unused', name: 'Unused registration' }],
    authorizations: [
      { id: 'a', clientId: 'cursor', kind: 'oauth', permissions: { scopes: ['read'], tools: null, projectGrants: { d1: ['workspace'], d2: ['workspace'] } } },
      { id: 'b', clientId: 'cursor', kind: 'pat', permissions: { scopes: ['write', 'execute', 'git'], tools: null, projectGrants: { d1: ['workspace', 'other'] } } },
      { id: 'expired', clientId: 'old', expires: now, permissions: {} },
    ],
    tokens: [
      { family: 'a', clientId: 'cursor', expires: now + 1, lastUsed: 1000 },
      { family: 'b', clientId: 'cursor', expires: now + 1, revoked: true, lastUsed: 90000 },
      { family: 'b', clientId: 'cursor', expires: now, lastUsed: 80000 },
      { family: 'unrelated', clientId: 'cursor', expires: now + 1, lastUsed: 70000 },
    ],
  }, now);
  assert.equal(model.clients.length, 1);
  assert.deepEqual(model.clients[0], { id: 'cursor', name: 'Cursor', kind: 'mixed', grantIds: ['a', 'b'], projectCount: 3, scopeLabel: '多组权限', lastUsed: 1000 });
});

test('permission reminders preserve unapplied revision zero and order actionable failures first', () => {
  const model = summarizeConsole({ devices: [
    { id: 'pending', name: 'Pending', online: true, projects: [{ id: 'p' }] },
    { id: 'applied', name: 'Applied', online: true, projects: [{ id: 'p' }], permissionAppliedRevision: 0 },
    { id: 'failed', name: 'Failed', online: false, projects: [], permissionError: 'missing root', permissions: { revision: 2, projects: [] } },
  ] }, 100000);
  assert.equal(model.policyAlerts[0].id, 'error:failed');
  assert.ok(model.policyAlerts.some(alert => alert.id === 'pending:pending'));
  assert.ok(!model.policyAlerts.some(alert => alert.deviceId === 'applied'));
  assert.equal(model.projects, 2);
});

test('activity excludes stale and future events while result and duration statistics retain the returned sample', () => {
  const now = 100000;
  const model = summarizeConsole({ devices: [{ id: 'd', projects: [], online: true, permissionAppliedRevision: 0 }], audit: [
    { at: now - 15001, deviceId: 'd', status: 'ok', durationMs: 10 },
    { at: now - 15000, deviceId: 'd', status: 'denied', durationMs: 20 },
    { at: now, deviceId: 'd', status: 'error', durationMs: 30 },
    { at: now + 1, deviceId: 'd', status: 'error', durationMs: -1 },
  ] }, now);
  assert.equal(model.runners[0].recentCount, 2);
  assert.equal(model.recentEvents.length, 2);
  assert.deepEqual(model.outcomes, { ok: 1, other: 3, total: 4 });
  assert.equal(model.medianDuration, 20);
  assert.deepEqual(summarizeConsole({ audit: [{ status: 'denied', durationMs: 0 }] }).outcomes, { ok: 0, other: 1, total: 1 });
});

test('audit histogram includes both window endpoints and excludes events outside the requested interval', () => {
  const timeline = auditTimeline([
    { at: -1, status: 'ok' }, { at: 0, status: 'ok' },
    { at: 499, status: 'denied' }, { at: 500, status: 'ok' },
    { at: 1000, status: 'error' }, { at: 1001, status: 'ok' },
  ], { now: 1000, windowMs: 1000, bins: 2 });
  assert.deepEqual(timeline, { start: 0, end: 1000, total: 4, other: 2, buckets: [{ at: 0, total: 2, other: 1 }, { at: 500, total: 2, other: 1 }] });
  assert.throws(() => auditTimeline([], { bins: 0 }), RangeError);
});
