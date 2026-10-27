import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
