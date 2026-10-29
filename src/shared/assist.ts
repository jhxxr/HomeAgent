import { z } from 'zod';
import { permissionProjectSchema, type PermissionProject } from './permissions.js';

export const ASSIST_FEATURE = 'remote-assist-v1';
export const ASSIST_MULTI_FEATURE = 'remote-assist-multi-v1';
export const ASSIST_INVITE_MS = 10 * 60000;
export const assistScopeSchema = z.enum(['read', 'write', 'execute']);
export const assistDurationSchema = z.union([z.literal(30), z.literal(120), z.literal(480)]);
export const assistApprovalSchema = z.object({
  root: z.string().min(1).max(4096),
  scopes: z.array(assistScopeSchema).min(1).max(3).refine(value => value.includes('read') && new Set(value).size === value.length, 'Read scope and unique scopes are required'),
  commands: z.array(z.string().min(1).max(4096)).max(16).default([]),
  durationMinutes: assistDurationSchema,
  approvedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict().refine(value => value.expiresAt > value.approvedAt && value.expiresAt - value.approvedAt <= value.durationMinutes * 60000, 'Invalid local authorization duration')
  .refine(value => value.scopes.includes('execute') || value.commands.length === 0, 'Programs require explicit execute consent');
export type AssistApproval = z.infer<typeof assistApprovalSchema>;
export const assistApprovedProjectSchema = z.object({
  id: permissionProjectSchema.shape.id,
  name: permissionProjectSchema.shape.name.refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid project name'),
  root: permissionProjectSchema.shape.root,
  scopes: assistApprovalSchema.shape.scopes,
  commands: z.array(z.string().min(1).max(512)).max(16).default([]),
}).strict().refine(value => value.scopes.includes('execute') || value.commands.length === 0, 'Programs require explicit execute consent');
export type AssistApprovedProject = z.infer<typeof assistApprovedProjectSchema>;
export const assistMultiApprovalSchema = z.object({
  projects: z.array(assistApprovedProjectSchema).min(1).max(16),
  durationMinutes: assistDurationSchema,
  approvedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict()
  .refine(value => value.expiresAt > value.approvedAt && value.expiresAt - value.approvedAt <= value.durationMinutes * 60000, 'Invalid local authorization duration')
  .refine(value => new Set(value.projects.map(project => project.id)).size === value.projects.length, 'Project IDs must be unique')
  .refine(value => value.projects.reduce((total, project) => total + project.commands.length, 0) <= 64, 'At most 64 programs per session');
export type AssistMultiApproval = z.infer<typeof assistMultiApprovalSchema>;
export const assistAnyApprovalSchema = z.union([assistApprovalSchema, assistMultiApprovalSchema]);
export type AssistAnyApproval = z.infer<typeof assistAnyApprovalSchema>;
export const assistInviteViewSchema = z.object({
  id: z.string().uuid(), operatorId: z.string().min(1).max(200), operatorName: z.string().min(1).max(128),
  authorizationId: z.string().min(1).max(200), authorizationRevision: z.number().int().min(0),
  scopes: z.array(assistScopeSchema).min(1).max(3), maxDurationMinutes: assistDurationSchema,
  expiresAt: z.number().int().positive(), state: z.enum(['pending', 'claimed', 'revoked']),
}).strict();
export type AssistInviteView = z.infer<typeof assistInviteViewSchema>;
export const assistDescriptorSchema = z.object({
  sessionId: z.string().uuid(), deviceId: z.string().uuid(), inviteId: z.string().uuid(),
  operatorId: z.string().min(1).max(200), deviceOwnerId: z.string().uuid(),
  authorizationId: z.string().min(1).max(200), authorizationRevision: z.number().int().min(0),
  localConsentRevision: z.number().int().positive(), approval: assistApprovalSchema,
}).strict();
export type AssistDescriptor = z.infer<typeof assistDescriptorSchema>;
export const assistMultiDescriptorSchema = assistDescriptorSchema.extend({ approval: assistMultiApprovalSchema }).strict();
export type AssistMultiDescriptor = z.infer<typeof assistMultiDescriptorSchema>;
export const assistAnyDescriptorSchema = z.union([assistDescriptorSchema, assistMultiDescriptorSchema]);
export type AssistAnyDescriptor = Omit<AssistDescriptor, 'approval'> & { approval: AssistAnyApproval };
export const assistCleanupSchema = z.enum(['pending', 'confirmed', 'failed', 'unconfirmed']);
export type AssistCleanup = z.infer<typeof assistCleanupSchema>;
export type AssistSession = AssistAnyDescriptor & {
  state: 'pending' | 'active' | 'ended'; created: number; endedAt?: number; reason?: string;
  cleanup: AssistCleanup; runnerInstanceId?: string;
};
export interface AssistInvite extends AssistInviteView { secretHash: string; created: number }
export const assistContextSchema = z.object({ sessionId: z.string().uuid(), localConsentRevision: z.number().int().positive() }).strict();
export function assistProject(approval: AssistApproval): PermissionProject {
  return permissionProjectSchema.parse({
    id: 'assist', name: 'Remote Assist', root: approval.root,
    readOnly: !approval.scopes.includes('write') && !approval.scopes.includes('execute'),
    commands: approval.commands,
  });
}
export function approvedProjects(approval: AssistAnyApproval): AssistApprovedProject[] {
  return 'projects' in approval ? structuredClone(approval.projects) : [{ id: 'assist', name: 'Remote Assist', root: approval.root, scopes: [...approval.scopes], commands: [...approval.commands] }];
}
export function assistProjects(approval: AssistAnyApproval): PermissionProject[] {
  return approvedProjects(approval).map(project => permissionProjectSchema.parse({
    id: project.id, name: project.name, root: project.root,
    readOnly: !project.scopes.includes('write') && !project.scopes.includes('execute'),
    commands: project.commands,
  }));
}
export function assistFeature(approval: AssistAnyApproval) { return 'projects' in approval ? ASSIST_MULTI_FEATURE : ASSIST_FEATURE; }
export function approvalEqual(left: AssistAnyApproval, right: AssistAnyApproval): boolean {
  return JSON.stringify(assistAnyApprovalSchema.parse(left)) === JSON.stringify(assistAnyApprovalSchema.parse(right));
}
