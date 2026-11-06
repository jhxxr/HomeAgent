import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createServer, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { Store, hash, secret, type Device } from '../src/server/store.js';
import { Hub } from '../src/server/hub.js';
import { loadServerConfig } from '../src/server/config.js';
import { MAX_FRAME, result } from '../src/shared/protocol.js';
import { createHomeServer } from '../src/server/app.js';
import { fixture, freePort, waitFor } from './helpers.js';

test('configuration refuses insecure public origins and weak secrets', () => {
  const env = { ADMIN_PASSWORD: 'strong-admin-password', SESSION_SECRET: 's'.repeat(64) };
  assert.equal(loadServerConfig({ ...env, PUBLIC_URL: 'http://localhost:3210' }).publicUrl, 'http://localhost:3210');
  for (const PUBLIC_URL of ['http://192.168.1.1:3210', 'https://example.com/subpath', 'https://user:password@example.com', 'https://example.com/?secret=1']) assert.throws(() => loadServerConfig({ ...env, PUBLIC_URL }));
  assert.throws(() => loadServerConfig({ ...env, ADMIN_PASSWORD: 'short' }));
  assert.throws(() => loadServerConfig({ ...env, TRUST_PROXY_HOPS: 'true' }));
  assert.throws(() => loadServerConfig({ SESSION_SECRET: 's'.repeat(64), ADMIN_PASSWORD: '' }));
  assert.throws(() => loadServerConfig({ ...env, XAUTH_ISSUER: 'https://auth.example.com' }));
  assert.throws(() => loadServerConfig({ ...env, XAUTH_CLIENT_ID: 'client-1' }));
  assert.throws(() => loadServerConfig({ ...env, XAUTH_ISSUER: 'http://192.168.1.1:8080', XAUTH_CLIENT_ID: 'client-1' }));
  assert.throws(() => loadServerConfig({ ...env, XAUTH_ISSUER: 'https://auth.example.com/subpath', XAUTH_CLIENT_ID: 'client-1' }));
  const xauthOnly = loadServerConfig({ SESSION_SECRET: 's'.repeat(64), ADMIN_PASSWORD: '', XAUTH_ISSUER: 'http://localhost:8080', XAUTH_CLIENT_ID: 'ha-client', XAUTH_CLIENT_SECRET: 'ha-secret' });
  assert.equal(xauthOnly.password, undefined);
  assert.deepEqual(xauthOnly.xauth, { issuer: 'http://localhost:8080', clientId: 'ha-client', clientSecret: 'ha-secret' });
});

test('transport results remain bounded even after JSON escaping', () => {
  const value = result({ data: '\0'.repeat(MAX_FRAME) });
  assert.equal(value.isError, true);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < MAX_FRAME);
});

test('audit cursor traverses records with identical timestamps without loss', async t => {
  const f = await fixture(), store = new Store(path.join(f.directory, 'audit.sqlite'));
  t.after(async () => { store.close(); await f.cleanup(); });
  for (let i = 0; i < 25; i++) store.audit({ principal: 'owner', deviceId: '', projectId: '', tool: 'test', argsHash: hash(String(i)), status: 'ok', durationMs: 0 });
  store.db.exec('UPDATE audit SET at=1000');
  const seen: string[] = [];
  let before = 1001, beforeId = '';
  while (true) {
    const page = store.audits(4, before, beforeId);
    if (!page.length) break;
    seen.push(...page.map(row => row.id)); before = page.at(-1)!.at; beforeId = page.at(-1)!.id;
  }
  assert.equal(seen.length, 25); assert.equal(new Set(seen).size, 25);
});

test('WebSocket authentication, readiness and result correlation resist another device', async t => {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'relay.sqlite'), password: 'strong-admin-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 90 });
  await relay.listen();
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await relay.close(); await f.cleanup(); });
  const make = async (id: string, token: string) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/runner', { headers: { authorization: `Bearer ${token}`, 'x-device-id': id } }); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.on('message', frame => {
      const message = JSON.parse(frame.toString());
      if (message.type === 'welcome') socket.send(JSON.stringify({ type: 'permissions_applied', revision: message.permissions.revision, projects: [{ id: 'workspace', name: 'Workspace', readOnly: false, commands: [] }] }));
    });
    return socket;
  };
  const device1 = randomUUID(), device2 = randomUUID(), token1 = secret(), token2 = secret();
  for (const [id, token] of [[device1, token1], [device2, token2]]) relay.store.put('devices', id!, { id: id!, name: id!, tokenHash: hash(token!), revoked: false, paused: false, projects: [], platform: '', lastSeen: 0, created: Date.now() } satisfies Device);
  const rejected = new WebSocket(base.replace('http:', 'ws:') + '/runner', { headers: { authorization: 'Bearer wrong', 'x-device-id': device1 } }); sockets.push(rejected);
  await new Promise<void>(resolve => { rejected.on('error', () => resolve()); });
  const obsolete = await make(device1, token1);
  const obsoleteClosed = new Promise<number>(resolve => obsolete.once('close', code => resolve(code)));
  obsolete.send(JSON.stringify({ type: 'hello', protocol: 1, name: 'obsolete', platform: 'test', version: 'old', projects: [] }));
  assert.equal(await obsoleteClosed, 4400, 'An older Runner protocol must be rejected');
  const first = await make(device1, token1), second = await make(device2, token2);
  assert.ok(!relay.hub.devices().some(device => device.online));
  const hello = { type: 'hello', protocol: 2, name: 'device', platform: 'test', version: 'test', instanceId: randomUUID(), capabilities: ['read_file'], projects: [] };
  first.send(JSON.stringify(hello)); second.send(JSON.stringify(hello));
  await waitFor(() => relay.hub.devices().filter(device => device.online && device.permissionAppliedRevision === 0).length === 2);
  let requestId = '';
  first.on('message', frame => { const message = JSON.parse(frame.toString()); if (message.type === 'call') requestId = message.id; });
  const principal = { id: 'owner', scopes: ['read' as const], devices: [device1, device2], projects: null };
  let settled = false;
  const pending = relay.hub.invoke(principal, 'read_file', { deviceId: device1, projectId: 'workspace', path: 'a.txt' }).then(value => { settled = true; return value; });
  await waitFor(() => requestId);
  second.send(JSON.stringify({ type: 'result', id: requestId, result: result('forged') }));
  await delay(50); assert.equal(settled, false);
  first.send(JSON.stringify({ type: 'result', id: requestId, result: result('correct') }));
  assert.equal((await pending).content[0]!.text, 'correct');
  const cancelled = new AbortController();
  const running = relay.hub.invoke(principal, 'read_file', { deviceId: device1, projectId: 'workspace', path: 'b.txt' }, cancelled.signal);
  const rejection = assert.rejects(running, /cancelled/i); cancelled.abort(); await rejection;
});

test('XAuth OIDC login binds the first account as sole administrator and rejects subsequent accounts', async t => {
  const f = await fixture(), port = await freePort(), xauthPort = await freePort();
  const base = `http://127.0.0.1:${port}`, issuer = `http://127.0.0.1:${xauthPort}`;
  let currentKey = { kid: 'key-1', ...generateKeyPairSync('rsa', { modulusLength: 2048 }) };
  let activeUser = { sub: 'xauth-user-1', email: 'admin@example.com', name: 'Primary Admin' };
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string; user: typeof activeUser }>();

  const xauthServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        jwks_uri: `${issuer}/keys`,
        userinfo_endpoint: `${issuer}/userinfo`,
      }));
      return;
    }
    if (url.pathname === '/keys') {
      const jwk = currentKey.publicKey.export({ format: 'jwk' });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [{ ...jwk, kid: currentKey.kid, use: 'sig', alg: 'RS256' }] }));
      return;
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const expectedBasic = `Basic ${Buffer.from('ha-web-client:ha-web-secret').toString('base64')}`;
        if (req.headers.authorization !== expectedBasic) {
          res.statusCode = 401; res.end(JSON.stringify({ error: 'invalid_client' })); return;
        }
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const code = form.get('code') ?? '', verifier = form.get('code_verifier') ?? '', redirectUri = form.get('redirect_uri') ?? '';
        const stored = codes.get(code);
        codes.delete(code);
        if (!stored || stored.redirectUri !== redirectUri || createHash('sha256').update(verifier).digest('base64url') !== stored.challenge) {
          res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return;
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: currentKey.kid })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
          iss: issuer, sub: stored.user.sub, aud: 'ha-web-client', exp: nowSec + 3600, iat: nowSec,
          nonce: stored.nonce, email: stored.user.email, name: stored.user.name,
        })).toString('base64url');
        const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), currentKey.privateKey).toString('base64url');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'at-1', token_type: 'Bearer', id_token: `${header}.${payload}.${signature}` }));
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>(resolve => xauthServer.listen(xauthPort, '127.0.0.1', resolve));

  const relay = createHomeServer({
    host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'xauth.sqlite'),
    xauth: { issuer, clientId: 'ha-web-client', clientSecret: 'ha-web-secret' },
    sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 90,
  });
  await relay.listen();
  t.after(async () => {
    await relay.close();
    await new Promise<void>(resolve => xauthServer.close(() => resolve()));
    await f.cleanup();
  });

  // In XAuth-only mode, login page shows XAuth button without password form, and POST /login is rejected
  const loginPage = await (await fetch(`${base}/login`)).text();
  assert.ok(loginPage.includes('id="xauthLogin"'));
  assert.ok(!loginPage.includes('id="loginForm"'));
  const pwAttempt = await fetch(`${base}/login`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'any-password-1234567890' }), redirect: 'manual',
  });
  assert.equal(pwAttempt.status, 403);

  const performXAuthLogin = async (nextPath = '/#settings') => {
    const start = await fetch(`${base}/login/xauth?next=${encodeURIComponent(nextPath)}`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const xauthCookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const authUrl = new URL(start.headers.get('location')!);
    assert.equal(authUrl.origin, issuer);
    assert.equal(authUrl.pathname, '/authorize');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authUrl.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
    const code = secret('xc_');
    codes.set(code, {
      challenge: authUrl.searchParams.get('code_challenge')!,
      nonce: authUrl.searchParams.get('nonce')!,
      redirectUri: authUrl.searchParams.get('redirect_uri')!,
      user: { ...activeUser },
    });
    const state = authUrl.searchParams.get('state')!;
    const callback = await fetch(`${base}/login/xauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
      headers: { cookie: xauthCookie }, redirect: 'manual',
    });
    return { callback, code, state, xauthCookie };
  };

  // 1. First XAuth user logs in and is bound as the sole administrator
  const firstLogin = await performXAuthLogin('/?welcome=1');
  assert.equal(firstLogin.callback.status, 302);
  assert.equal(firstLogin.callback.headers.get('location'), '/?welcome=1');
  const sessionCookie = firstLogin.callback.headers.getSetCookie().find(c => c.startsWith('ha_session='))!.split(';')[0]!;
  const state1 = await (await fetch(`${base}/api/state`, { headers: { cookie: sessionCookie } })).json() as any;
  assert.equal(state1.xauth.enabled, true);
  assert.equal(state1.xauth.admin.sub, 'xauth-user-1');
  assert.equal(state1.xauth.admin.email, 'admin@example.com');
  assert.equal(state1.sessions[0].authMethod, 'xauth');
  assert.equal(state1.sessions[0].userEmail, 'admin@example.com');

  // Replaying the same callback fails because the login state was consumed once
  const replay = await fetch(`${base}/login/xauth/callback?code=${encodeURIComponent(firstLogin.code)}&state=${encodeURIComponent(firstLogin.state)}`, {
    headers: { cookie: firstLogin.xauthCookie }, redirect: 'manual',
  });
  assert.equal(replay.status, 400);

  // 2. A second XAuth user attempts to log in and is rejected (403)
  activeUser = { sub: 'xauth-user-2', email: 'other@example.com', name: 'Other User' };
  const secondLogin = await performXAuthLogin('/');
  assert.equal(secondLogin.callback.status, 403);
  assert.equal(secondLogin.callback.headers.getSetCookie().some(c => c.startsWith('ha_session=')), false);
  const deniedHtml = await secondLogin.callback.text();
  assert.ok(deniedHtml.includes('仅允许首个登录的管理员账号访问'));
  const stateAfterDenied = await (await fetch(`${base}/api/state`, { headers: { cookie: sessionCookie } })).json() as any;
  assert.equal(stateAfterDenied.xauth.admin.sub, 'xauth-user-1');
  assert.ok(stateAfterDenied.audit.some((entry: any) => entry.principal === 'xauth:xauth-user-2' && entry.tool === 'admin.login' && entry.status === 'denied'));

  // 3. The first XAuth user logs in again after XAuth rotates its signing key
  currentKey = { kid: 'key-2', ...generateKeyPairSync('rsa', { modulusLength: 2048 }) };
  activeUser = { sub: 'xauth-user-1', email: 'admin@example.com', name: 'Primary Admin' };
  const rotatedLogin = await performXAuthLogin('/');
  assert.equal(rotatedLogin.callback.status, 302);
  assert.equal(rotatedLogin.callback.headers.get('location'), '/');
});
