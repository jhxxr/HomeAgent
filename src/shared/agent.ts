export const MACHINE_SCOPES = ['read', 'write', 'execute', 'git'] as const;
export const TASK_SCOPES = ['tasks:self', 'tasks:dispatch', 'tasks:review', 'calendar:read'] as const;
export const SCOPES = [...MACHINE_SCOPES, ...TASK_SCOPES] as const;
export const AGENT_ROLES = ['worker', 'supervisor', 'observer'] as const;
export const BINDING_MODES = ['bound_projects', 'none'] as const;
export type AgentRole = typeof AGENT_ROLES[number];
export type BindingMode = typeof BINDING_MODES[number];
export type TaskScope = typeof TASK_SCOPES[number];
