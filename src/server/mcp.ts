import { Server, createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS, type AuthInfo, type Tool } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { AppError, VERSION, errorText, result } from '../shared/protocol.js';
import { toolDefinitions } from '../shared/tools.js';
import { hash, type ClientToken, type Store } from './store.js';
import type { Hub } from './hub.js';

/** Official v2 serving entry: one factory for 2026 per-request envelopes and stateless 2025 clients. */
export function createMcpEndpoint(store: Store, hub: Hub) {
  const handler = createMcpHandler(({ authInfo }) => {
    const principal = authInfo?.extra?.principal as ClientToken | undefined;
    if (!principal) throw new AppError('unauthorized', 'Validated authentication context required', 401);
    const server = new Server({ name: 'homeagent', version: VERSION }, {
      capabilities: { tools: {} }, supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      cacheHints: { 'tools/list': { ttlMs: 0, cacheScope: 'private' }, 'server/discover': { ttlMs: 0, cacheScope: 'private' } },
    });
    const currentPrincipal = () => {
      const current = store.tokenByHash(principal.tokenHash);
      if (!current) throw new AppError('credential_revoked', 'Credential is no longer valid', 401);
      return current;
    };
    server.setRequestHandler('tools/list', async () => {
      const current = currentPrincipal();
      return ({
      tools: [
        ...(!current.tools || current.tools.includes('list_devices') ? [{ name: 'list_devices', description: 'List authorized devices, projects, Runner identity, local policies and online status. Call before selecting deviceId/projectId.', inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } }] : []),
        ...toolDefinitions.filter(tool => !current.tools || current.tools.includes(tool.name)) as Tool[],
      ],
    }); });
    server.setRequestHandler('tools/call', async (request, context) => {
      if (request.params.name === 'list_devices') {
        const current = currentPrincipal();
        if (current.tools && !current.tools.includes('list_devices')) return result({ error: 'tool_forbidden', message: 'Device discovery is disabled for this authorization' }, true);
        store.audit({ principal: principal.id, deviceId: '', projectId: '', tool: 'list_devices', argsHash: hash('{}'), status: 'ok', durationMs: 0 });
        return result(hub.devices(current));
      }
      try {
        return await hub.invoke(principal, request.params.name, request.params.arguments ?? {}, context.mcpReq.signal, { family: principal.family, tokenHash: principal.tokenHash, expires: principal.expires });
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'invalid_call';
        return result({ error: code, message: errorText(error), outcomeUnknown: ['cancelled', 'device_disconnected', 'credential_revoked'].includes(code) }, true);
      }
    });
    return server;
  }, { legacy: 'stateless', maxRequestBodySize: 512 * 1024 });
  return { handler, node: toNodeHandler(handler, { maxRequestBodySize: 512 * 1024 }) };
}
export type { AuthInfo };
