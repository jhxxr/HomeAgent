import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Principal } from '../shared/protocol.js';
import { EventEmitter } from 'node:events';
import type { AuthorizationPolicy, PermissionProject, RemotePermissions } from '../shared/permissions.js';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = (prefix = '') => prefix + randomBytes(32).toString('base64url');
export interface Device { id: string; name: string; tokenHash: string; revoked: boolean; paused: boolean; projects: unknown[]; platform: string; lastSeen: number; created: number; runnerVersion?: string; runnerInstanceId?: string; capabilities?: string[]; allowRemotePermissions?: boolean; permissionsProtocol?: 1; permissionBaseline?: PermissionProject[]; permissions?: RemotePermissions; permanentProjects?: PermissionProject[] | null; permissionAppliedRevision?: number; permissionError?: string }
export interface Pairing { id: string; codeHash: string; pollHash: string; approvalHash?: string; name: string; expires: number; state: 'pending' | 'approved' | 'claimed'; deviceId?: string }
export interface ClientToken extends Principal { tokenHash: string; kind: 'pat' | 'access' | 'refresh'; clientId: string; family: string; expires: number; created: number; revoked: boolean; lastUsed: number; scopeLimit?: string[] }
export interface BrowserSession { id: string; csrf: string; expires: number; created?: number; lastSeen?: number; userAgent?: string }
export interface Audit { id: string; at: number; principal: string; deviceId: string; projectId: string; tool: string; argsHash: string; status: string; durationMs: number }

/** Synchronous SQLite transactions keep one-time pairing/code consumption atomic. */
export class Store extends EventEmitter<{ revoked: [string]; permissionsChanged: [string] }> {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    super();
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (process.platform !== 'win32') chmodSync(filename, 0o600);
    const schema = this.db.prepare('PRAGMA user_version').get()!.user_version as number;
    if (schema > 1) { this.db.close(); throw new Error('Database schema is newer than this server; use a compatible version or restore a backup'); }
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(bucket,id));
      CREATE INDEX IF NOT EXISTS jobs_started ON records(json_extract(data,'$.started') DESC,id DESC) WHERE bucket='jobs';
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, principal TEXT NOT NULL, deviceId TEXT NOT NULL, projectId TEXT NOT NULL, tool TEXT NOT NULL, argsHash TEXT NOT NULL, status TEXT NOT NULL, durationMs INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_cursor ON audit(at DESC, id DESC);
      PRAGMA user_version=1;
    `);
  }
  get<T>(bucket: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE bucket=? AND id=?').get(bucket, id);
    return row ? JSON.parse(row.data as string) as T : undefined;
  }
  all<T>(bucket: string): T[] {
    return this.db.prepare('SELECT data FROM records WHERE bucket=?').all(bucket).map(row => JSON.parse(row.data as string) as T);
  }
  put(bucket: string, id: string, data: unknown) {
    this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET data=excluded.data').run(bucket, id, JSON.stringify(data));
  }
  delete(bucket: string, id: string) { this.db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(bucket, id); }
  transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = callback(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  mintToken(input: Omit<ClientToken, 'tokenHash' | 'created' | 'revoked' | 'lastUsed'>): string {
    const token = secret(input.kind === 'pat' ? 'ha_pat_' : 'ha_');
    this.put('tokens', hash(token), { ...input, tokenHash: hash(token), created: Date.now(), revoked: false, lastUsed: 0 });
    return token;
  }
  token(raw: string, kinds: ClientToken['kind'][] = ['pat', 'access']): ClientToken | undefined {
    return this.tokenByHash(hash(raw), kinds);
  }
  tokenByHash(tokenHash: string, kinds: ClientToken['kind'][] = ['pat', 'access']): ClientToken | undefined {
    const value = this.get<ClientToken>('tokens', tokenHash);
    if (!value || value.revoked || value.expires <= Date.now() || !kinds.includes(value.kind)) return;
    return this.resolvePermissions(value);
  }
  resolvePermissions(value: ClientToken): ClientToken {
    const policy = this.expireAuthorization(value.family);
    const temporary = policy?.temporary && policy.temporary.expiresAt > Date.now() ? policy.temporary : undefined;
    const grant = temporary?.permissions ?? policy?.permanent;
    const scopes = grant?.scopes ?? value.scopes;
    return {
      ...value,
      ...(grant ? { scopes: grant.scopes, devices: grant.devices, projects: null, projectGrants: grant.projectGrants, tools: grant.tools ?? undefined, machineAccess: grant.machineAccess, unrestrictedExecution: grant.unrestrictedExecution } : {}),
      scopes: value.scopeLimit ? scopes.filter(scope => value.scopeLimit!.includes(scope)) : scopes,
      authorizationId: value.family, authorizationExpiresAt: temporary?.expiresAt,
      authorizationRevision: policy?.revision ?? 0,
    };
  }
  expireAuthorizations() {
    for (const row of this.db.prepare("SELECT id FROM records WHERE bucket='authorizations'").all()) this.expireAuthorization(row.id as string);
  }
  private expireAuthorization(id: string) {
    const policy = this.get<AuthorizationPolicy>('authorizations', id);
    if (!policy?.temporary || policy.temporary.expiresAt > Date.now()) return policy;
    delete policy.temporary; policy.revision++;
    this.put('authorizations', id, policy);
    this.audit({ principal: 'system', deviceId: '', projectId: '', tool: 'authorization.expired', argsHash: hash(id), status: 'ok', durationMs: 0 });
    this.emit('permissionsChanged', id);
    return policy;
  }
  revokeFamily(family: string) {
    for (const token of this.all<ClientToken>('tokens')) {
      if (token.family === family) { token.revoked = true; this.put('tokens', token.tokenHash, token); }
    }
    this.emit('revoked', family);
  }
  audit(input: Omit<Audit, 'id' | 'at'>): Audit {
    const row = { ...input, id: randomUUID(), at: Date.now() };
    this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, row.at, row.principal, row.deviceId, row.projectId, row.tool, row.argsHash, row.status, row.durationMs);
    return row;
  }
  audits(limit = 100, before = Date.now() + 1, beforeId = ''): Audit[] {
    return this.db.prepare('SELECT * FROM audit WHERE at < ? OR (at = ? AND id < ?) ORDER BY at DESC, id DESC LIMIT ?').all(before, before, beforeId, limit) as unknown as Audit[];
  }
  prune(retentionDays: number) {
    const now = Date.now();
    this.db.prepare('DELETE FROM audit WHERE at < ?').run(now - retentionDays * 86400000);
    for (const bucket of ['sessions', 'pairings', 'codes', 'authRequests']) {
      this.db.prepare("DELETE FROM records WHERE bucket=? AND CAST(json_extract(data,'$.expires') AS INTEGER) < ?").run(bucket, now);
    }
    // Keep consumed refresh tokens until their original expiry to detect replay.
    this.db.prepare("DELETE FROM records WHERE bucket='tokens' AND CAST(json_extract(data,'$.expires') AS INTEGER) < ?").run(now);
    this.db.prepare("DELETE FROM records WHERE bucket='jobs' AND CAST(json_extract(data,'$.observedAt') AS INTEGER) < ?").run(now - retentionDays * 86400000);
    this.db.exec("DELETE FROM records AS policy WHERE bucket='authorizations' AND NOT EXISTS (SELECT 1 FROM records AS token WHERE token.bucket='tokens' AND json_extract(token.data,'$.family')=policy.id)");
  }
  close() { this.db.close(); }
}
