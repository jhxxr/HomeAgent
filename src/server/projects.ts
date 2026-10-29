import type { Principal } from '../shared/protocol.js';
import { projectGranted } from '../shared/protocol.js';
import type { AuthorizationPolicy } from '../shared/permissions.js';
import type { ClientToken, Device, Store } from './store.js';

interface ProjectIdentity { id: string; name: string }

/** Saved identities outlive temporary unavailability, but not permanent removal. */
export function configuredProjects(device: Device, now = Date.now()): ProjectIdentity[] {
  if (!device.permissions) return device.projects as ProjectIdentity[];
  const policy = device.permissions;
  const current = policy.expiresAt && policy.expiresAt <= now ? policy.fallbackProjects : policy.projects;
  const permanent = device.permanentProjects ?? policy.fallbackProjects;
  return [...new Map([...permanent, ...current].map(project => [project.id, project])).values()];
}

export function projectCatalog(device: Device) {
  const policy = device.permissions;
  const active = policy ? policy.expiresAt && policy.expiresAt <= Date.now() ? policy.fallbackProjects : policy.projects : device.projects as ProjectIdentity[];
  const applied = device.permissionAppliedRevision === (policy?.revision ?? 0) && !device.permissionError;
  return configuredProjects(device).map(({ id, name }) => ({
    id, name, status: !active.some(project => project.id === id) ? 'fallback' as const
      : applied && (device.projects as ProjectIdentity[]).some(project => project.id === id) ? 'applied' as const : 'pending' as const,
  }));
}

/** Bootstrap old records from saved identities and explicit credential references. */
export function knownProjectIds(store: Store, device: Device): Set<string> {
  const ids = new Set(device.knownProjectIds ?? []);
  for (const project of [...configuredProjects(device), ...(device.permissions?.projects ?? []), ...(device.permissions?.fallbackProjects ?? [])]) ids.add(project.id);
  const include = (principal: Principal) => {
    for (const id of principal.projectGrants?.[device.id] ?? principal.projects ?? []) {
      if (projectGranted(principal, device.id, id)) ids.add(id);
    }
  };
  for (const token of store.all<ClientToken>('tokens')) include(token);
  for (const policy of store.all<AuthorizationPolicy>('authorizations')) {
    for (const grant of [policy.permanent, policy.temporary?.permissions]) {
      if (grant) include({ id: '', ...grant, tools: grant.tools ?? undefined, projects: null });
    }
  }
  return ids;
}
