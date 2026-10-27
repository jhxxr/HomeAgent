import { z } from 'zod';
import { remotePermissionsSchema } from './permissions.js';

export const VERSION = '0.4.1';
export const RUNNER_PROTOCOL = 2;
export const MAX_FRAME = 2 * 1024 * 1024;
export const SCOPES = ['read', 'write', 'execute', 'git'] as const;
export type Scope = typeof SCOPES[number];
export const principalSchema = z.object({
  id: z.string().max(200),
  scopes: z.array(z.enum(SCOPES)),
  devices: z.array(z.string()).nullable(),
  projects: z.array(z.string()).nullable(),
  projectGrants: z.record(z.string(), z.array(z.string())).optional(),
  tools: z.array(z.string().max(64)).max(100).optional(),
  authorizationId: z.string().max(200).optional(),
  authorizationExpiresAt: z.number().int().positive().optional(),
  authorizationRevision: z.number().int().min(0).optional(),
  machineAccess: z.boolean().optional(),
  unrestrictedExecution: z.boolean().optional(),
});
export type Principal = z.infer<typeof principalSchema>;
export function projectGranted(principal: Principal, deviceId: string, projectId: string): boolean {
  return (!principal.devices || principal.devices.includes(deviceId))
    && (!principal.projects || principal.projects.includes(projectId))
    && (!principal.projectGrants || !!principal.projectGrants[deviceId]?.includes(projectId));
}
export const projectViewSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().max(128),
  readOnly: z.boolean(),
  allowGitWrite: z.boolean().default(false),
  allowGitNetwork: z.boolean().default(false),
  allowGitPush: z.boolean().default(false),
  commandMode: z.enum(['allowlist', 'unrestricted']).default('allowlist'),
  filesystemScope: z.enum(['project', 'device']).default('project'),
  commands: z.array(z.string().max(512)).max(64),
  commandAliasNames: z.array(z.string().max(64)).max(64).optional(),
  environmentNames: z.array(z.string().max(64)).max(64).optional(),
});
export const resultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string().max(MAX_FRAME) })).max(8),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
export type ToolResult = z.infer<typeof resultSchema>;
export const jobViewSchema = z.object({
  id: z.string().uuid(), owner: z.string().min(1).max(200), projectId: z.string().min(1).max(64),
  executable: z.string().max(512), revision: z.number().int().min(0),
  started: z.number().int().positive(), finished: z.number().int().positive().optional(),
  state: z.enum(['starting', 'running', 'stopping', 'exited', 'failed', 'stopped', 'timed_out', 'interrupted']),
  exitCode: z.number().int().nullable().optional(), signal: z.string().max(64).nullable().optional(),
  outputBytes: z.number().int().min(0).max(64 * 1024 * 1024), truncated: z.boolean(),
  totalOutputBytes: z.number().int().min(0).optional(),
  authorizationId: z.string().max(200).optional(),
  authorizationExpiresAt: z.number().int().positive().optional(),
  authorizationRevision: z.number().int().min(0).optional(),
});
export type JobView = z.infer<typeof jobViewSchema>;
export const terminalJob = (job: Pick<JobView, 'state'>) => !['starting', 'running', 'stopping'].includes(job.state);
export const agentMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'), protocol: z.literal(RUNNER_PROTOCOL),
    name: z.string().min(1).max(128), platform: z.string().max(64),
    version: z.string().max(32), projects: z.array(projectViewSchema).max(100),
    instanceId: z.string().uuid(),
    capabilities: z.array(z.string().max(64)).max(64),
  }).strict(),
  z.object({ type: z.literal('permissions_applied'), revision: z.number().int().min(0), projects: z.array(projectViewSchema).max(100), error: z.string().max(512).optional() }),
  z.object({ type: z.literal('result'), id: z.string().uuid(), result: resultSchema }),
  z.object({ type: z.literal('job_update'), job: jobViewSchema }),
  z.object({ type: z.literal('jobs_snapshot'), snapshotId: z.string().uuid(), page: z.number().int().min(0).max(100), done: z.boolean(), jobs: z.array(jobViewSchema).max(100) }),
]);
export const relayMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), protocol: z.literal(RUNNER_PROTOCOL), deviceId: z.string(), permissions: remotePermissionsSchema, authorizations: z.array(z.object({ id: z.string().max(200), revision: z.number().int().min(0) })).max(10000) }),
  z.object({ type: z.literal('permissions'), permissions: remotePermissionsSchema }),
  z.object({ type: z.literal('authorization_changed'), authorizationId: z.string().max(200) }),
  z.object({
    type: z.literal('call'), id: z.string().uuid(), tool: z.string().max(64),
    args: z.record(z.string(), z.unknown()), principal: principalSchema,
  }),
  z.object({ type: z.literal('cancel'), id: z.string().uuid() }),
]);
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type RelayMessage = z.infer<typeof relayMessageSchema>;
export function result(value: unknown, isError = false): ToolResult {
  const structuredContent = value && typeof value === 'object' ? Array.isArray(value) ? { items: value } : value as Record<string, unknown> : undefined;
  const output: ToolResult = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError } : {}) };
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_FRAME - 4096) return { content: [{ type: 'text', text: JSON.stringify({ error: 'result_limit', message: 'Result exceeds the transport limit; narrow the query or requested range' }) }], isError: true };
  return output;
}
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
