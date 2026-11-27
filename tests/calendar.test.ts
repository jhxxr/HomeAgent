import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Calendar, parseCalendarData, validateCalendarConfig } from '../src/server/calendar.js';
import { Kanban } from '../src/server/kanban.js';
import { Store } from '../src/server/store.js';
import { loadServerConfig } from '../src/server/config.js';
import { fixture } from './helpers.js';

async function setup(t: { after: (callback: () => Promise<void>) => void }) {
  const f = await fixture(), store = new Store(path.join(f.directory, 'calendar.sqlite')), kanban = new Kanban(store), calendars: Calendar[] = [];
  t.after(async () => { for (const calendar of calendars) await calendar.close(); store.close(); await f.cleanup(); });
  const calendar = (config: ConstructorParameters<typeof Calendar>[1], request: typeof fetch) => { const calendar = new Calendar(store, config, request); calendars.push(calendar); return calendar; };
  return { store, kanban, calendar };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('calendar defaults are silent and do not contact providers or persist cache data', async t => {
  const { store, calendar } = await setup(t);
  const disabled = calendar({ provider: 'none' }, async () => { throw new Error('must not fetch'); });
  disabled.start(); disabled.requestSync(); await disabled.sync();
  assert.deepEqual(disabled.context(), { enabled: false, provider: 'none', status: 'disabled', busy: [], free: [], deadlines: [] });
  assert.deepEqual(store.all('calendarCache'), []);
  const config = loadServerConfig({ SESSION_SECRET: 's'.repeat(64), ADMIN_PASSWORD: 'calendar-test-password' });
  assert.equal(config.calendar!.provider, 'none');
});

test('calendar configuration rejects missing credentials, personal writeback and unsafe CalDAV URLs', () => {
  assert.throws(() => validateCalendarConfig({ provider: 'google' }), /requires/);
  assert.throws(() => validateCalendarConfig({ provider: 'google', accessToken: 'test', tasksCalendarId: 'primary' }), /separate/);
  assert.throws(() => validateCalendarConfig({ provider: 'google', accessToken: 'test', calendarId: 'personal', tasksCalendarId: 'personal' }), /separate/);
  const caldav = { provider: 'caldav' as const, url: 'https://calendar.example/personal/', username: 'test', password: 'test' };
  assert.throws(() => validateCalendarConfig({ ...caldav, tasksUrl: caldav.url }), /separate/);
  assert.throws(() => validateCalendarConfig({ ...caldav, url: 'http://calendar.example/personal/' }), /HTTPS/);
  assert.throws(() => validateCalendarConfig({ ...caldav, url: 'https://user:secret@calendar.example/personal/' }), /credentials/);
  assert.equal(validateCalendarConfig(caldav).tasksUrl, undefined, 'CalDAV may be configured read-only');
});

test('Google cache stores busy intervals and tagged deadlines, suppresses private titles and merges overlaps', async t => {
  const { store, calendar } = await setup(t), now = Date.now();
  let calls = 0;
  const adapter = calendar({ provider: 'google', accessToken: 'test-only', calendarId: 'personal' }, async (input, init) => {
    calls++;
    assert.equal(init?.redirect, 'error'); assert.ok(String(input).includes('singleEvents=true'));
    return json({ items: [
      { summary: 'Private medical appointment', start: { dateTime: new Date(now + 3600000).toISOString() }, end: { dateTime: new Date(now + 7200000).toISOString() } },
      { summary: 'Another private meeting', start: { dateTime: new Date(now + 5400000).toISOString() }, end: { dateTime: new Date(now + 10800000).toISOString() } },
      { summary: '[DDL] Report', transparency: 'transparent', start: { dateTime: new Date(now + 14400000).toISOString() }, end: { dateTime: new Date(now + 15300000).toISOString() } },
      { summary: 'Cancelled', status: 'cancelled' },
    ] });
  });
  await adapter.sync();
  assert.equal(calls, 1); const context = adapter.context();
  assert.equal(context.status, 'synced'); assert.equal(context.busy.length, 1); assert.equal(context.free.length, 2);
  assert.deepEqual(context.busy[0], { start: now + 3600000, end: now + 10800000 });
  assert.equal(context.deadlines[0]!.title, '[DDL] Report');
  assert.ok(!JSON.stringify(store.all('calendarCache')).includes('Private medical'));
  assert.ok(!JSON.stringify(context).includes('test-only'));
});

test('Google handles pagination, stale/failed reads and safe errors without advertising unknown free time', async t => {
  const { calendar } = await setup(t); let calls = 0, fail = false;
  const adapter = calendar({ provider: 'google', accessToken: 'private-token' }, async input => {
    if (fail) return new Response('private-token: provider details', { status: 401 });
    calls++;
    return json({ items: [], ...(!String(input).includes('pageToken') ? { nextPageToken: 'next' } : {}) });
  });
  await adapter.sync(); assert.equal(calls, 2); assert.equal(adapter.context().free.length, 1);
  fail = true; await adapter.sync();
  assert.equal(adapter.context().status, 'error'); assert.deepEqual(adapter.context().free, []);
  assert.ok(!JSON.stringify(adapter.context()).includes('private-token'));
  assert.equal(adapter.context().error, 'calendar_http_401');
  const clock = Date.now;
  try { Date.now = () => clock() + 6 * 60000; assert.deepEqual(adapter.context().free, []); }
  finally { Date.now = clock; }
});

test('Google all-day events use the calendar timezone rather than assuming UTC midnight', async t => {
  const { calendar } = await setup(t), now = Date.now();
  const date = new Date(now + 2 * 86400000).toISOString().slice(0, 10), end = new Date(now + 3 * 86400000).toISOString().slice(0, 10);
  const adapter = calendar({ provider: 'google', accessToken: 'test' }, async () => json({ timeZone: 'Asia/Shanghai', items: [{ start: { date }, end: { date: end }, summary: 'All day' }] }));
  await adapter.sync();
  assert.deepEqual(adapter.context().busy, [{ start: Date.parse(`${date}T00:00:00+08:00`), end: Date.parse(`${end}T00:00:00+08:00`) }]);
});

test('high-risk reviews and deadlines write idempotently to a separate Google calendar, then update and remove', async t => {
  const { store, kanban, calendar } = await setup(t);
  const task = kanban.create(null, { title: 'Risky review', description: '', requiresReview: true, riskLevel: 'high' }, 'admin');
  kanban.claim(task.id, null, 'cloud', null); kanban.submitReview(task.id, null, { proposedCommitMessage: '', aiSummary: 'Evidence', fileHashes: {} });
  const revision = kanban.task(task.id).revision, methods: string[] = [];
  let eventId = '';
  const adapter = calendar({ provider: 'google', accessToken: 'test', calendarId: 'personal' }, async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET';
    methods.push(`${method} ${url}`);
    if (method === 'GET') return json({ items: [] });
    if (url.endsWith('/calendars')) { assert.equal(JSON.parse(String(init?.body)).summary, 'HomeAgent Tasks'); return json({ id: 'tasks-calendar' }); }
    assert.ok(url.includes('/calendars/tasks-calendar/events'));
    if (method === 'DELETE') return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body));
    assert.ok(body.summary.startsWith('[REVIEW]')); assert.equal(body.transparency, 'transparent');
    eventId = body.id ?? eventId;
    return json({ id: eventId });
  });
  await adapter.sync();
  assert.ok(eventId); assert.equal(kanban.task(task.id).calendarEventId, eventId); assert.equal(kanban.task(task.id).revision, revision, 'calendar metadata cannot create form conflicts');
  await adapter.sync(); assert.equal(methods.filter(method => method.startsWith('POST')).length, 2, 'calendar and event created only once');
  const current = kanban.task(task.id); current.title = 'Updated title'; store.put('tasks', current.id, current);
  await adapter.sync(); assert.equal(methods.filter(method => method.startsWith('PATCH')).length, 1);
  kanban.administer(task.id, null, revision, { action: 'approve' });
  await adapter.sync(); assert.equal(methods.filter(method => method.startsWith('DELETE')).length, 1); assert.equal(kanban.task(task.id).calendarEventId, null);
  await adapter.sync(); assert.equal(methods.filter(method => method.startsWith('DELETE')).length, 1);
});

test('Google refresh tokens renew access without leaking credentials and concurrent syncs share one request', async t => {
  const { calendar } = await setup(t); let refreshes = 0, reads = 0;
  const adapter = calendar({ provider: 'google', clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh' }, async (input, init) => {
    if (String(input).includes('oauth2.googleapis.com')) {
      refreshes++; assert.ok(String(init?.body).includes('grant_type=refresh_token')); return json({ access_token: 'new-access', expires_in: 3600 });
    }
    reads++; assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer new-access'); return json({ items: [] });
  });
  await Promise.all([adapter.sync(), adapter.sync(), adapter.sync()]);
  assert.equal(refreshes, 1); assert.equal(reads, 1);
  await adapter.sync(); assert.equal(refreshes, 1); assert.equal(reads, 2);
});

const calendarXml = (ics: string) => `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:propstat><D:prop><C:calendar-data><![CDATA[${ics}]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
test('CalDAV parsing handles UTC expansion, all-day events, folded text and duration while rejecting unsafe or unexpanded data', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261201T090000Z\r\nDURATION:PT1H\r\nSUMMARY:[DDL] Long\r\n  title\\, safe\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261202\r\nSUMMARY:All day\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const events = parseCalendarData(calendarXml(ics));
  assert.equal(events.length, 2); assert.equal(events[0]!.end - events[0]!.start, 3600000); assert.equal(events[0]!.title, '[DDL] Long title, safe');
  assert.equal(events[1]!.end - events[1]!.start, 86400000);
  assert.throws(() => parseCalendarData('<!DOCTYPE calendar>' + calendarXml(ics)));
  assert.throws(() => parseCalendarData(calendarXml(ics.replace('DTSTART:20261201T090000Z', 'DTSTART;TZID=Asia/Shanghai:20261201T090000'))));
  assert.throws(() => parseCalendarData(calendarXml(ics.replace('DURATION:PT1H', 'RRULE:FREQ=DAILY'))));
  assert.throws(() => parseCalendarData(calendarXml(ics).replace('200 OK', '403 Forbidden')));
  assert.throws(() => parseCalendarData('<html>not a calendar</html>'));
});

test('CalDAV reads with expanded REPORT, writes folded UTC task events to a dedicated collection and removes completion', async t => {
  const { kanban, calendar } = await setup(t), now = Date.now(), calls: Array<{ url: string; method: string; body: string }> = [];
  const task = kanban.create(null, { title: 'Deadline\n' + '中文'.repeat(60), description: '', requiresReview: false, riskLevel: 'low', dueAt: now + 3600000 }, 'admin');
  const adapter = calendar({ provider: 'caldav', url: 'https://calendar.example/personal/', tasksUrl: 'https://calendar.example/tasks/', username: 'calendar-user', password: 'calendar-secret' }, async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET', body = String(init?.body ?? ''); calls.push({ url, method, body });
    if (method === 'REPORT') { assert.ok(body.includes('<C:expand')); return new Response('<D:multistatus xmlns:D="DAV:"/>', { status: 207 }); }
    assert.ok(url.startsWith('https://calendar.example/tasks/'));
    if (method === 'DELETE') return new Response(null, { status: 204 });
    assert.equal(method, 'PUT'); assert.ok(body.includes('TRANSP:TRANSPARENT'));
    assert.ok(body.includes('\\n')); for (const line of body.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
    return new Response(null, { status: 201, headers: { etag: '"v1"' } });
  });
  await adapter.sync(); assert.ok(kanban.task(task.id).calendarEventId);
  await adapter.sync(); assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  kanban.claim(task.id, null, 'cloud', null); kanban.submitReview(task.id, null, { proposedCommitMessage: '', aiSummary: '', fileHashes: {} });
  await adapter.sync(); assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
});

test('oversized or malformed provider responses fail closed and do not create free-time claims', async t => {
  const { calendar } = await setup(t);
  const adapter = calendar({ provider: 'google', accessToken: 'test' }, async () => new Response('oversized', { headers: { 'content-length': String(5 * 1024 * 1024) } }));
  await adapter.sync(); assert.equal(adapter.context().status, 'error'); assert.deepEqual(adapter.context().free, []);
  const malformed = calendar({ provider: 'google', accessToken: 'test' }, async () => json({ items: [{ start: {}, end: {} }] }));
  await malformed.sync(); assert.deepEqual(malformed.context().free, []);
});
