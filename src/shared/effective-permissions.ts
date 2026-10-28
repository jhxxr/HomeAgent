import type { Principal } from './protocol.js';

interface ProjectAccess {
  commandMode?: 'allowlist' | 'unrestricted';
  filesystemScope?: 'project' | 'device';
  readOnly?: boolean;
}

/** The same intersection is used by discovery and by the Runner at execution. */
export function effectiveProjectAccess(project: ProjectAccess, principal: Principal) {
  const configuredMode = project.commandMode ?? 'allowlist';
  const unrestrictedExecutionGranted = principal.unrestrictedExecution === true;
  const commandMode: 'allowlist' | 'unrestricted' = configuredMode === 'unrestricted' && unrestrictedExecutionGranted ? 'unrestricted' : 'allowlist';
  return {
    commandMode,
    filesystemScope: project.filesystemScope === 'device' && principal.machineAccess ? 'device' as const : 'project' as const,
    filesystemPolicy: {
      configuredScope: project.filesystemScope ?? 'project',
      machineAccessGranted: principal.machineAccess === true,
      limitedBy: project.filesystemScope !== 'device' ? 'project' as const
        : !principal.machineAccess ? 'authorization' as const : null,
    },
    executionPolicy: {
      configuredMode, effectiveMode: commandMode,
      unrestrictedExecutionGranted,
      executeScopeGranted: principal.scopes.includes('execute'),
      readOnly: project.readOnly ?? false,
      limitedBy: configuredMode !== 'unrestricted' ? 'project' as const
        : !unrestrictedExecutionGranted ? 'authorization' as const : null,
    },
  };
}
export type ExecutionPolicy = ReturnType<typeof effectiveProjectAccess>['executionPolicy'];
export type FilesystemPolicy = ReturnType<typeof effectiveProjectAccess>['filesystemPolicy'];
