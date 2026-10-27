import type { Express } from 'express';
import { z } from 'zod';
import { grantPermissionsSchema, permissionDuration, permissionProjectSchema, type AuthorizationPolicy, type GrantPermissions } from '../shared/permissions.js';
import { AppError, RUNNER_PROTOCOL, SCOPES } from '../shared/protocol.js';
import { toolDefinitions, toolSchemas } from '../shared/tools.js';
import { hash, type ClientToken, type Device, type Store } from './store.js';
import type { Hub } from './hub.js';

function grantView(store: Store, token: ClientToken): GrantPermissions {
  const devices = store.all<Device>('devices').filter(device => !device.revoked && (!token.devices || token.devices.includes(device.id)));
  return {
    scopes: token.scopes,
    devices: devices.map(device => device.id),
    projectGrants: Object.fromEntries(devices.map(device => [device.id, (device.projects as { id: string }[]).filter(project => (!token.projects || token.projects.includes(project.id)) && (!token.projectGrants || !!token.projectGrants[device.id]?.includes(project.id))).map(project => project.id)])),
    tools: token.tools ?? null,
    machineAccess: token.machineAccess ?? false,
    unrestrictedExecution: token.unrestrictedExecution ?? false,
  };
}
export function permissionState(store: Store) {
  const groups = new Map<string, ClientToken[]>();
  for (const token of store.all<ClientToken>('tokens')) {
    if (token.revoked || token.expires <= Date.now()) continue;
    const list = groups.get(token.family) ?? []; list.push(token); groups.set(token.family, list);
  }
  const authorizations = [...groups.entries()].map(([id, tokens]) => {
    tokens.sort((a, b) => b.created - a.created);
    const token = tokens[0]!, effective = store.resolvePermissions(token);
    const policy = store.get<AuthorizationPolicy>('authorizations', id);
    const temporary = policy?.temporary && policy.temporary.expiresAt > Date.now() ? policy.temporary : undefined;
    return {
      id, clientId: token.clientId, kind: token.kind === 'pat' ? 'pat' : 'oauth', revision: policy?.revision ?? 0,
      expires: Math.max(...tokens.map(token => token.expires)), temporaryExpiresAt: temporary?.expiresAt ?? null,
      permissions: grantView(store, effective),
      permanentPermissions: policy?.permanent ?? grantView(store, token),
    };
  });
  return { authorizations, permissionTools: [{ name: 'list_devices', description: '设备与项目发现' }, ...toolDefinitions.map(({ name, description }) => ({ name, description }))], scopes: SCOPES };
}
export function installPermissionRoutes(app: Express, store: Store, hub: Hub) {
  app.post('/api/devices/:id/permissions', (req, res) => {
    const device = store.get<Device>('devices', String(req.params.id));
    if (!device || device.revoked) throw new AppError('not_found', 'Device not found', 404);
    const body = z.object({ expectedRevision: z.number().int().min(0), projects: z.array(permissionProjectSchema).max(100), durationMinutes: permissionDuration }).strict().parse(req.body);
    if (body.expectedRevision !== (device.permissions?.revision ?? 0)) throw new AppError('revision_conflict', '设备权限已变化，请重新打开编辑器', 409);
    if (new Set(body.projects.map(project => project.id)).size !== body.projects.length) throw new AppError('duplicate_project', '项目 ID 必须唯一');
    const expiresAt = body.durationMinutes === null ? null : Date.now() + body.durationMinutes * 60000;
    if (!expiresAt) device.permanentProjects = body.projects;
    device.permissions = { revision: body.expectedRevision + 1, projects: body.projects, expiresAt, fallbackProjects: device.permanentProjects ?? [] };
    device.permissionAppliedRevision = undefined; device.permissionError = undefined;
    store.put('devices', device.id, device);
    store.audit({ principal: 'admin', deviceId: device.id, projectId: '', tool: expiresAt ? 'device.permissions_temporary' : 'device.permissions_updated', argsHash: hash(JSON.stringify(body)), status: 'ok', durationMs: 0 });
    hub.sendPermissions(device.id);
    res.json({ revision: device.permissions.revision, expiresAt, status: 'pending', message: '已保存，等待 Runner 应用。应用时会取消该设备正在进行的调用并停止托管任务。' });
  });
  app.post('/api/authorizations/:id/permissions', (req, res) => {
    const id = String(req.params.id);
    const tokens = store.all<ClientToken>('tokens').filter(token => token.family === id && !token.revoked && token.expires > Date.now());
    if (!tokens.length) throw new AppError('not_found', 'Authorization not found', 404);
    const body = z.object({ expectedRevision: z.number().int().min(0), permissions: grantPermissionsSchema.optional(), durationMinutes: permissionDuration.optional(), restoreTemporary: z.boolean().default(false) }).strict().parse(req.body);
    const policy = store.get<AuthorizationPolicy>('authorizations', id) ?? { revision: 0 };
    if (policy.revision !== body.expectedRevision) throw new AppError('revision_conflict', '客户端授权已变化，请重新打开编辑器', 409);
    if (body.restoreTemporary) delete policy.temporary;
    else {
      if (!body.permissions || body.durationMinutes === undefined) throw new AppError('invalid_input', '请选择授权内容和有效时间');
      const permission = body.permissions;
      for (const deviceId of permission.devices) {
        const device = store.get<Device>('devices', deviceId);
        if (!device || device.revoked) throw new AppError('invalid_device', '请选择有效设备');
        if (body.durationMinutes !== null && device.runnerProtocol !== RUNNER_PROTOCOL) throw new AppError('runner_not_ready', '请先连接 Runner，再设置临时客户端授权', 409);
        if ((permission.projectGrants[deviceId] ?? []).some(id => !(device.projects as { id: string }[]).some(project => project.id === id))) throw new AppError('invalid_project', '请选择设备上已注册的项目');
      }
      if (Object.keys(permission.projectGrants).some(deviceId => !permission.devices.includes(deviceId))) throw new AppError('invalid_project', '项目授权必须属于已选设备');
      if (permission.tools?.some(name => name !== 'list_devices' && !Object.hasOwn(toolSchemas, name))) throw new AppError('invalid_tool', '未知工具权限');
      if (body.durationMinutes === null) { policy.permanent = permission; delete policy.temporary; }
      else policy.temporary = { permissions: permission, expiresAt: Date.now() + body.durationMinutes * 60000 };
    }
    policy.revision++;
    store.put('authorizations', id, policy);
    for (const token of tokens) {
      if (token.scopeLimit !== undefined) {
        delete token.scopeLimit;
        store.put('tokens', token.tokenHash, token);
      }
    }
    store.emit('permissionsChanged', id);
    store.audit({ principal: 'admin', deviceId: '', projectId: '', tool: body.restoreTemporary ? 'authorization.temporary_cancelled' : policy.temporary ? 'authorization.temporary_updated' : 'authorization.updated', argsHash: hash(JSON.stringify(body)), status: 'ok', durationMs: 0 });
    res.json({ revision: policy.revision, temporaryExpiresAt: policy.temporary?.expiresAt ?? null, message: '权限已更新；已取消该授权正在进行的调用，并通知 Runner 停止其托管任务。' });
  });
}
