import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createHomeServer } from '../src/server/app.js';
import { fixture, freePort } from './helpers.js';

async function consentFixture(t: { after: (callback: () => Promise<void>) => void }) {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'consent.sqlite'), password: 'consent-test-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 1 });
  await relay.listen();
  t.after(async () => { await relay.close(); await f.cleanup(); });
  const registration = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Consent regression', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) });
  assert.equal(registration.status, 201);
  const client = await registration.json() as { client_id: string };
  const deviceId = randomUUID();
  relay.store.put('devices', deviceId, { id: deviceId, name: 'Device', revoked: false, projects: [{ id: 'workspace', name: 'Workspace' }] });
  const login = async () => {
    const response = await fetch(base + '/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'consent-test-password' }), redirect: 'manual' });
    const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as { csrf: string };
    return { cookie, csrf: state.csrf };
  };
  const session = await login(), verifier = 'a'.repeat(64);
  const begin = async () => {
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: 'read write', state: 'expected-state', resource: base + '/mcp' });
    const response = await fetch(base + '/authorize?' + query, { redirect: 'manual' });
    assert.equal(response.status, 302);
    return new URL(base + response.headers.get('location')!).searchParams.get('request')!;
  };
  const submit = (request: string, overrides: Record<string, string> = {}, who = session) => fetch(base + '/consent', {
    method: 'POST', headers: { cookie: who.cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual',
    body: new URLSearchParams({ request, _csrf: who.csrf, decision: 'allow', scopes: 'read', devices: deviceId, projects: `${deviceId}:workspace`, ...overrides }),
  });
  const get = (url: string, who = session) => fetch(base + url, { headers: { cookie: who.cookie }, redirect: 'manual' });
  const callback = async (url: string) => {
    const response = await get(url);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-security-policy')!.includes("form-action 'self'"));
    const html = await response.text();
    assert.ok(html.includes('/assets/consent.js'));
    return new URL(/id="oauth-callback" href="([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&'));
  };
  return { base, relay, client, deviceId, verifier, session, login, begin, submit, get, callback };
}

test('consent double submission uses one same-origin completion and one encrypted authorization code receipt', async t => {
  const f = await consentFixture(t), request = await f.begin();
  const page = await f.get('/consent?request=' + request);
  const pageHtml = await page.text();
  assert.ok(pageHtml.includes('id="oauth-consent"'));
  assert.ok(pageHtml.includes('id="consent-status"'));
  const replies = await Promise.all([f.submit(request), f.submit(request)]);
  for (const reply of replies) assert.equal(reply.status, 303);
  const completion = replies[0]!.headers.get('location')!;
  assert.ok(completion.startsWith('/consent/complete?'));
  assert.equal(replies[1]!.headers.get('location'), completion);
  assert.equal(f.relay.store.all('codes').length, 1);
  const callback = await f.callback(completion), repeated = await f.callback(completion);
  assert.equal(callback.href, repeated.href);
  assert.equal(callback.origin, 'https://client.example');
  assert.equal(callback.searchParams.get('state'), 'expected-state');
  assert.equal(callback.searchParams.get('iss'), f.relay.oauth.issuer);
  const code = callback.searchParams.get('code')!;
  assert.ok(code);
  assert.ok(!JSON.stringify(f.relay.store.all('authRequests')).includes(code));
  const changed = await f.submit(request, { scopes: 'write' });
  assert.equal(changed.status, 409);
  const otherSession = await f.login();
  assert.equal((await f.get(completion, otherSession)).status, 403);
  assert.equal((await f.submit(request, {}, otherSession)).status, 403);
  const exchange = () => fetch(f.base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: f.client.client_id, grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/callback', code_verifier: f.verifier, resource: f.base + '/mcp' }) });
  assert.equal((await exchange()).status, 200);
  assert.equal((await exchange()).status, 400);
  const used = await f.get(completion), usedHtml = await used.text();
  assert.equal(used.status, 200);
  assert.ok(usedHtml.includes('授权已提交'));
  assert.ok(!usedHtml.includes(code));
  assert.ok(!usedHtml.includes('id="oauth-callback"'));
  const replay = await f.submit(request);
  assert.equal(replay.status, 303);
  assert.equal(f.relay.store.all('codes').length, 0);
});

test('consent validation preserves choices, denial uses the bridge, and expired or revoked requests remain closed', async t => {
  const f = await consentFixture(t), request = await f.begin();
  const invalid = await f.submit(request, { projects: '' });
  assert.equal(invalid.status, 400);
  const invalidHtml = await invalid.text();
  assert.ok(invalidHtml.includes('请至少选择'));
  assert.ok(invalidHtml.includes(`value="${f.deviceId}" checked`));
  assert.equal(f.relay.store.all('codes').length, 0);
  assert.equal((await f.submit(request, { _csrf: 'wrong' })).status, 403);
  const denied = await f.submit(request, { decision: 'deny' });
  assert.equal(denied.status, 303);
  const callback = await f.callback(denied.headers.get('location')!);
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.get('state'), 'expected-state');
  assert.equal(callback.searchParams.has('code'), false);
  assert.equal(f.relay.store.all('codes').length, 0);
  const expired = await f.begin();
  const record = f.relay.store.get<{ expires: number }>('authRequests', expired)!;
  record.expires = Date.now() - 1; f.relay.store.put('authRequests', expired, record);
  const expiredReply = await f.submit(expired);
  assert.equal(expiredReply.status, 410);
  assert.ok((await expiredReply.text()).includes('重新发起'));
  assert.equal((await f.get('/consent?request=' + expired)).status, 410);
  const revoked = await f.begin();
  f.relay.oauth.revokeClient(f.client.client_id);
  assert.equal((await f.submit(revoked)).status, 400);
  assert.equal(f.relay.store.all('codes').length, 0);
});
