import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHomeServer } from '../src/server/app.js';
import { fixture, freePort } from './helpers.js';
import { toolDefinitions } from '../src/shared/tools.js';

test('official v2 client negotiates 2026 discovery/envelopes while legacy 2025 remains usable', async t => {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'server.sqlite'), password: 'protocol-test-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 90 });
  await relay.listen();
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); await relay.close(); await f.cleanup(); });
  const deviceId = randomUUID();
  relay.store.put('devices', deviceId, { id: deviceId, name: 'protocol-device', tokenHash: 'not-a-valid-device-token', revoked: false, paused: false, projects: [{ id: 'workspace', name: 'Workspace' }], platform: '', lastSeen: 0, created: Date.now() });
  const token = relay.store.mintToken({ id: 'protocol-owner', clientId: 'protocol-test', family: randomUUID(), kind: 'pat', scopes: ['read'], devices: [deviceId], projects: ['workspace'], expires: Date.now() + 60000 });
  const modern = new Client({ name: 'modern-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  clients.push(modern);
  const requests: { method: string; version?: string }[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      if (typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        requests.push({ method: body.method, version: body.params?._meta?.['io.modelcontextprotocol/protocolVersion'] });
      }
      return fetch(input, init);
    },
  });
  await modern.connect(transport);
  assert.equal(modern.getProtocolEra(), 'modern');
  const serverInfo = modern.getServerVersion()!;
  assert.equal(serverInfo.title, 'HomeAgent');
  assert.equal(serverInfo.websiteUrl, base);
  assert.deepEqual(serverInfo.icons, [{ src: base + '/assets/icon.png', mimeType: 'image/png', sizes: ['1254x1254'] }]);
  // Clients fetch branding separately from MCP, without bearer tokens or browser cookies.
  const icon = await fetch(serverInfo.icons![0]!.src);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  const image = Buffer.from(await icon.arrayBuffer());
  assert.deepEqual(image, await readFile(new URL('../public/icon.png', import.meta.url)));
  assert.equal(`${image.readUInt32BE(16)}x${image.readUInt32BE(20)}`, serverInfo.icons![0]!.sizes![0]);
  assert.equal((await modern.listTools()).tools.length, toolDefinitions.length + 1);
  const devices = await modern.callTool({ name: 'list_devices', arguments: {} });
  assert.equal(JSON.parse((devices.content![0] as { text: string }).text)[0].id, deviceId);
  assert.ok(requests.some(request => request.method === 'server/discover'));
  assert.ok(requests.filter(request => request.method === 'tools/list' || request.method === 'tools/call').every(request => request.version === '2026-07-28'));
  const legacy = new Client({ name: 'legacy-test', version: '1' }, { supportedProtocolVersions: ['2025-06-18'], versionNegotiation: { mode: 'legacy' } });
  clients.push(legacy);
  await legacy.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal(legacy.getProtocolEra(), 'legacy');
  assert.deepEqual(legacy.getServerVersion(), serverInfo);
  assert.equal((await legacy.listTools()).tools.length, toolDefinitions.length + 1);
  const unauthenticated = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }) });
  assert.equal(unauthenticated.status, 401);
  const unsupported = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'invalid-version', version: '1' } } } }) });
  assert.equal(unsupported.status, 400);
  const rejected = await unsupported.json() as any;
  assert.ok(rejected.error); assert.ok(!rejected.result);
});
