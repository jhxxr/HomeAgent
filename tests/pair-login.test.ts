import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHomeServer } from '../src/server/app.js';
import { fixture, freePort } from './helpers.js';

test('browser approval link authorizes a pending Runner pairing', async t => {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({
    host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'pair-link.sqlite'),
    password: 'pair-link-admin-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 1,
  });
  await relay.listen();
  t.after(async () => { await relay.close(); await f.cleanup(); });

  const startResponse = await fetch(base + '/pair/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'link-device' }),
  });
  assert.equal(startResponse.status, 201);
  const start = await startResponse.json() as { id: string; pollToken: string; verificationUrl: string };
  const anonymous = await fetch(start.verificationUrl, { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.get('location') ?? '', /^\/login\?next=/);
  const login = await fetch(base + '/login', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pair-link-admin-password' }), redirect: 'manual',
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as { csrf: string };

  const pending = await fetch(start.verificationUrl, { headers: { cookie } });
  assert.equal(pending.status, 200);
  assert.match(await pending.text(), /link-device/);

  const url = new URL(start.verificationUrl);
  const approved = await fetch(start.verificationUrl, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: start.id, token: url.searchParams.get('token')!, _csrf: state.csrf }),
    redirect: 'manual',
  });
  assert.equal(approved.status, 303);
  assert.equal((await (await fetch(start.verificationUrl, { headers: { cookie } })).text()).includes('设备已批准'), true);

  const claimed = await fetch(base + '/pair/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: start.id, pollToken: start.pollToken }),
  });
  assert.equal(claimed.status, 200);
  assert.equal((await fetch(base + '/pair/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: start.id, pollToken: start.pollToken }),
  })).status, 401);
  assert.ok(!JSON.stringify(relay.store.all('pairings')).includes(url.searchParams.get('token')!));
});
