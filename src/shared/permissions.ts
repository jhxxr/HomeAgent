import { z } from 'zod';

export const commandAliasesSchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.object({
  executable: z.string().min(1).max(4096), args: z.array(z.string().max(8192)).max(256).default([]),
}).strict()).refine(value => Object.keys(value).length <= 64, 'At most 64 command aliases per project').default({});
export const environmentProfilesSchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.object({
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32768)).default({}),
  inherit: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(100).default([]),
}).strict()).refine(value => Object.keys(value).length <= 64, 'At most 64 environment profiles per project').default({});

export const permissionProjectSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().min(1).max(128),
  root: z.string().min(1).max(4096),
  readOnly: z.boolean().default(false),
  commands: z.array(z.string().min(1).max(512)).max(64).default([]),
  commandMode: z.enum(['allowlist', 'unrestricted']).default('allowlist'),
  filesystemScope: z.enum(['project', 'device']).default('project'),
  allowGitWrite: z.boolean().default(false),
  allowGitNetwork: z.boolean().default(false),
  allowGitPush: z.boolean().default(false),
  commandAliases: commandAliasesSchema,
  environmentProfiles: environmentProfilesSchema,
  gitCommonDir: z.string().min(1).max(4096).optional(),
  deniedNames: z.array(z.string().min(1).max(128)).max(64).default(['.git', '.env', '.ssh', '.aws', '.homeagent']),
}).strict();
export const remotePermissionsSchema = z.object({
  revision: z.number().int().min(0),
  projects: z.array(permissionProjectSchema).max(100),
  expiresAt: z.number().int().positive().nullable(),
  fallbackProjects: z.array(permissionProjectSchema).max(100),
}).strict();
export type RemotePermissions = z.infer<typeof remotePermissionsSchema>;
export type PermissionProject = z.infer<typeof permissionProjectSchema>;
export const grantPermissionsSchema = z.object({
  scopes: z.array(z.enum(['read', 'write', 'execute', 'git'])).max(4),
  devices: z.array(z.string().uuid()).max(100),
  projectGrants: z.record(z.string().uuid(), z.array(z.string().min(1).max(64)).max(100)),
  tools: z.array(z.string().min(1).max(64)).max(100).nullable().default(null),
  machineAccess: z.boolean().default(false),
  unrestrictedExecution: z.boolean().default(false),
}).strict();
export type GrantPermissions = z.infer<typeof grantPermissionsSchema>;
export interface AuthorizationPolicy {
  revision: number;
  permanent?: GrantPermissions;
  temporary?: { permissions: GrantPermissions; expiresAt: number };
}
export const permissionDuration = z.number().int().min(1).max(10080).nullable();
