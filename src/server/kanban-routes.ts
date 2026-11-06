import type { Express, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../shared/protocol.js';
import type { Hub } from './hub.js';
import type { OAuth } from './oauth.js';
import type { KanbanTask, KanbanAdminAction } from './kanban.js';
import { configuredProjects } from './projects.js';
import { hash, type Store, type Device, type BrowserSession } from './store.js';

const statuses = ['todo', 'in_progress', 'review', 'done'] as const;
const projectId = z.string().min(1).max(64);
const taskId = z.string().min(1).max(32);
const expectedRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fields = {
  title: z.string().trim().min(1).max(256), description: z.string().max(4096),
  targetPaths: z.array(z.string().min(1).max(512).refine(value => !value.includes('\0'), 'Paths must not contain NUL')).max(32),
  requiresReview: z.boolean(),
};
const createInput = z.object({ projectId, ...fields, description: fields.description.default(''), targetPaths: fields.targetPaths.default([]), requiresReview: fields.requiresReview.default(true) }).strict();
const baseInput = { projectId, expectedRevision };
const inputs = {
  edit: z.object({ ...baseInput, title: fields.title.optional(), description: fields.description.optional(), targetPaths: fields.targetPaths.optional(), requiresReview: fields.requiresReview.optional() }).strict().refine(value => Object.keys(value).some(key => key !== 'projectId' && key !== 'expectedRevision'), 'Supply at least one editable field'),
  comment: z.object({ ...baseInput, message: z.string().trim().min(1).max(1024) }).strict(),
  release: z.object({ ...baseInput, reason: z.string().trim().min(1).max(1024) }).strict(),
  approve: z.object(baseInput).strict(),
  reject: z.object({ ...baseInput, reason: z.string().trim().min(1).max(1024) }).strict(),
  assign: z.object({ ...baseInput, assignee: z.string().trim().min(1).max(200), deviceId: z.string().uuid() }).strict(),
  submit: z.object({ ...baseInput, proposedCommitMessage: z.string().trim().min(1).max(512), aiSummary: z.string().trim().min(1).max(2048) }).strict(),
  reopen: z.object({ ...baseInput, reason: z.string().trim().min(1).max(1024) }).strict(),
  revise: z.object({ ...baseInput, reason: z.string().trim().min(1).max(1024) }).strict(),
  finish: z.object({ ...baseInput, skipReview: z.literal(true) }).strict(),
};
const optionalFilter = (max: number) => z.string().max(max).optional().transform(value => value || undefined);
const filterFields = { projectId, query: optionalFilter(256), deviceId: optionalFilter(128), assignee: optionalFilter(256) };
const boardInput = z.object(filterFields).strict();
const listInput = z.object({ ...filterFields, status: z.enum(statuses).optional(), cursor: z.string().min(1).max(1024).optional() }).strict();
type Filters = z.infer<typeof boardInput> & { status?: KanbanTask['status'] };
const cursorInput = z.object({ v: z.literal(1), at: z.number().int().nonnegative(), id: taskId, key: z.string().length(64) }).strict();

function projects(hub: Hub, store: Store) {
  const groups = new Map<string, { id: string; name: string; devices: Array<{ id: string; name: string; online: boolean; paused: boolean }>; available: boolean }>();
  const online = new Set(hub.devices().filter(device => device.online).map(device => device.id));
  for (const device of store.all<Device>('devices').filter(device => !device.revoked && !device.assistSessionId).sort((a, b) => a.id.localeCompare(b.id))) {
    for (const project of configuredProjects(device)) {
      let group = groups.get(project.id);
      if (!group) { group = { id: project.id, name: project.name, devices: [], available: false }; groups.set(project.id, group); }
      group.devices.push({ id: device.id, name: device.name, online: online.has(device.id), paused: device.paused });
      // Kanban is server-side metadata, so offline ordinary configured devices still qualify.
      if (!device.paused) group.available = true;
    }
  }
  for (const task of store.all<KanbanTask>('tasks')) {
    if (!groups.has(task.projectId)) groups.set(task.projectId, { id: task.projectId, name: task.projectId, devices: [], available: false });
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function requireProject(hub: Hub, store: Store, id: string, writable = false) {
  const project = projects(hub, store).find(project => project.id === id);
  if (!project) throw new AppError('unknown_project', 'Project is not configured and has no retained tasks', 404);
  if (writable && !project.available) throw new AppError('project_unavailable', 'A non-paused ordinary configured device is required to create or edit tasks', 409);
}

// Wire views bound accumulated histories and old/MCP-created records, not just browser inputs.
function taskView(task: KanbanTask, detail = false) {
  const { messages, evidence, reviewFingerprints, ...rest } = task;
  const summary = {
    ...rest, title: task.title.slice(0, 256), description: task.description.slice(0, 4096),
    createdBy: task.createdBy.slice(0, 256),
    ...(task.assignee ? { assignee: task.assignee.slice(0, 256) } : {}),
    ...(task.assigneeDevice ? { assigneeDevice: task.assigneeDevice.slice(0, 128) } : {}),
    targetPaths: task.targetPaths.slice(0, 32).map(value => value.slice(0, 512)), targetPathsTotal: task.targetPaths.length,
    actualPaths: task.actualPaths.slice(0, detail ? 256 : 32).map(value => value.slice(0, 512)), actualPathsTotal: task.actualPaths.length,
    reviewStalePathsTotal: task.reviewStalePaths?.length ?? 0,
    reviewFingerprintsTotal: Object.keys(reviewFingerprints ?? {}).length,
    ...(task.reviewStalePaths ? { reviewStalePaths: task.reviewStalePaths.slice(0, detail ? 256 : 32).map(value => value.slice(0, 512)) } : {}),
    ...(task.proposedCommitMessage ? { proposedCommitMessage: task.proposedCommitMessage.slice(0, 512) } : {}),
    messagesTotal: messages.length,
  };
  if (!detail) return summary;
  return {
    ...summary, messages: messages.slice(-100).map(message => ({ ...message, from: message.from.slice(0, 256), text: message.text.slice(0, 2048) })),
    messagesTruncated: messages.length > 100,
    ...(evidence ? { evidence: { ...evidence, ...(evidence.aiSummary ? { aiSummary: evidence.aiSummary.slice(0, 2048) } : {}) } } : {}),
    ...(reviewFingerprints ? { reviewFingerprints: Object.fromEntries(Object.entries(reviewFingerprints).slice(0, 256).map(([file, digest]) => [file.slice(0, 512), digest.slice(0, 64)])) } : {}),
  };
}

function page(hub: Hub, filters: Filters, cursor?: string) {
  const key = hash(JSON.stringify([filters.projectId, filters.query ?? '', filters.deviceId ?? '', filters.assignee ?? '', filters.status ?? '']));
  let after: z.infer<typeof cursorInput> | undefined;
  if (cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      after = cursorInput.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      if (after.key !== key) throw new Error();
    } catch { throw new AppError('invalid_cursor', 'Cursor is invalid or does not match these filters'); }
  }
  const query = filters.query?.toLowerCase();
  const matching = hub.kanban.list(filters.projectId, filters.status).filter(task =>
    (!filters.deviceId || task.assigneeDevice === filters.deviceId)
    && (!filters.assignee || task.assignee === filters.assignee)
    && (!query || [task.id, task.title, task.description, ...task.targetPaths, ...task.actualPaths].some(value => value.toLowerCase().includes(query))));
  const remaining = after ? matching.filter(task => task.updatedAt < after.at || task.updatedAt === after.at && task.id < after.id) : matching;
  const selected = remaining.slice(0, 30), last = selected.at(-1);
  const nextCursor = remaining.length > selected.length && last
    ? Buffer.from(JSON.stringify({ v: 1, at: last.updatedAt, id: last.id, key })).toString('base64url') : null;
  return { items: selected.map(task => taskView(task)), total: matching.length, nextCursor };
}

function audited(store: Store, action: string, handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const started = Date.now();
    let status = 'error';
    try { handler(req, res, next); status = 'ok'; }
    finally {
      const id = typeof req.body?.projectId === 'string' && req.body.projectId.length <= 64 ? req.body.projectId : '';
      store.audit({ principal: actor(res), deviceId: '', projectId: id, tool: `admin.kanban.${action}`, argsHash: hash(JSON.stringify({ path: req.path, body: req.body ?? null })), status, durationMs: Date.now() - started });
    }
  };
}

/** Install only after BrowserAuth.requireSession: all mutations inherit administrator CSRF checks. */
export function installKanbanRoutes(app: Express, store: Store, hub: Hub, oauth: OAuth) {
  app.get('/api/kanban/assignees', (req, res) => {
    const { projectId: id } = z.object({ projectId }).strict().parse(req.query);
    requireProject(hub, store, id);
    const groups = new Map<string, { id: string; name: string; devices: Array<{ id: string; name: string }> }>();
    for (const { token, device } of hub.kanban.assignmentCandidates(id)) {
      let group = groups.get(token.id);
      if (!group) {
        const client = oauth.clientsStore.getClient(token.clientId);
        group = { id: token.id, name: (client?.client_name || token.clientId || token.id).slice(0, 256), devices: [] };
        groups.set(token.id, group);
      }
      if (!group.devices.some(item => item.id === device.id)) group.devices.push({ id: device.id, name: device.name });
    }
    res.json({ assignees: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)).map(group => ({ ...group, devices: group.devices.sort((a, b) => a.id.localeCompare(b.id)) })) });
  });
  app.get('/api/kanban/projects', (_req, res) => res.json({ projects: projects(hub, store) }));
  app.get('/api/kanban/board', (req, res) => {
    const filters = boardInput.parse(req.query);
    requireProject(hub, store, filters.projectId);
    res.json({ columns: Object.fromEntries(statuses.map(status => [status, page(hub, { ...filters, status })])), serverTime: Date.now() });
  });
  app.get('/api/kanban/tasks', (req, res) => {
    const filters = listInput.parse(req.query);
    requireProject(hub, store, filters.projectId);
    res.json(page(hub, filters, filters.cursor));
  });
  app.get('/api/kanban/tasks/:id', (req, res) => {
    const { projectId: id } = z.object({ projectId }).strict().parse(req.query);
    const detail = hub.kanban.detail(taskId.parse(req.params.id), id);
    res.json({ task: taskView(detail.task, true), warnings: detail.warnings.slice(0, 100).map(warning => warning.slice(0, 2048)) });
  });
  app.post('/api/kanban/tasks', audited(store, 'create', (req, res) => {
    const input = createInput.parse(req.body);
    requireProject(hub, store, input.projectId, true);
    res.status(201).json({ task: taskView(hub.kanban.create(input.projectId, input, actor(res)), true) });
  }));
  app.post('/api/kanban/tasks/:id/:action', (req, res, next) => {
    const raw = String(req.params.action);
    const auditAction = Object.hasOwn(inputs, raw) ? raw : 'invalid_action';
    audited(store, auditAction, (req, res) => {
      const action = z.enum(['edit', 'comment', 'release', 'approve', 'reject', 'assign', 'submit', 'reopen', 'revise', 'finish']).parse(req.params.action);
      const input = inputs[action].parse(req.body);
      const id = taskId.parse(req.params.id);
      // Check the exact task/project pair before checking membership (no cross-project mutation).
      const current = hub.kanban.detail(id, input.projectId).task;
      if (current.revision !== input.expectedRevision) throw new AppError('conflict', 'Task changed; reload before retrying', 409);
      if (action === 'edit') requireProject(hub, store, input.projectId, true);
      const task = hub.kanban.administer(id, input.projectId, input.expectedRevision, { ...input, action } as KanbanAdminAction, actor(res));
      res.json({ task: taskView(task, true) });
    })(req, res, next);
  });
}

function actor(res: Response): string {
  const session = res.locals.session as BrowserSession;
  return session.authMethod === 'xauth' && session.userSub ? `xauth:${session.userSub}` : 'admin';
}
