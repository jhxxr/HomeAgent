import { AppError, jobViewSchema, terminalJob, type JobView, type Principal } from '../shared/protocol.js';
import { Store } from './store.js';

export interface JobRecord extends JobView { deviceId: string; runnerInstanceId: string; observedAt: number; missingSince?: number }
export class JobMirror {
  private counts = new Map<string, number>();
  constructor(private store: Store) {}
  private key(deviceId: string, id: string) { return `${deviceId}:${id}`; }
  get(deviceId: string, id: string) { return this.store.get<JobRecord>('jobs', this.key(deviceId, id)); }
  list(principal?: Principal, options: { deviceId?: string; projectId?: string; limit?: number } = {}): JobRecord[] {
    const conditions = ["bucket='jobs'"], values: (string | number)[] = [];
    const equal = (field: string, value: string) => { conditions.push(`json_extract(data,'$.${field}')=?`); values.push(value); };
    if (options.deviceId) equal('deviceId', options.deviceId);
    if (options.projectId) equal('projectId', options.projectId);
    if (principal) {
      equal('owner', principal.id);
      conditions.push("(json_extract(data,'$.assist.sessionId') IS NULL OR json_extract(data,'$.authorizationId')=?)"); values.push(principal.authorizationId ?? '');
      if (principal.devices) { conditions.push("json_extract(data,'$.deviceId') IN (SELECT value FROM json_each(?))"); values.push(JSON.stringify(principal.devices)); }
      if (principal.projects) { conditions.push("json_extract(data,'$.projectId') IN (SELECT value FROM json_each(?))"); values.push(JSON.stringify(principal.projects)); }
      if (principal.projectGrants) {
        conditions.push("EXISTS (SELECT 1 FROM json_each(?) AS dg, json_each(dg.value) AS pg WHERE dg.key=json_extract(data,'$.deviceId') AND pg.value=json_extract(data,'$.projectId'))");
        values.push(JSON.stringify(principal.projectGrants));
      }
    }
    values.push(Math.min(10000, options.limit ?? 1000));
    return this.store.db.prepare(`SELECT data FROM records WHERE ${conditions.join(' AND ')} ORDER BY json_extract(data,'$.started') DESC,id DESC LIMIT ?`).all(...values).map(row => JSON.parse(row.data as string) as JobRecord);
  }
  private count(deviceId: string) {
    return this.store.db.prepare("SELECT count(*) AS n FROM records WHERE bucket='jobs' AND id>=? AND id<?").get(`${deviceId}:`, `${deviceId};`)!.n as number;
  }
  accept(deviceId: string, instanceId: string, job: JobView) {
    const key = this.key(deviceId, job.id), old = this.get(deviceId, job.id);
    if (old && (old.owner !== job.owner || old.projectId !== job.projectId || old.started !== job.started)) throw new AppError('job_identity_changed', 'A job cannot change its owner, project or admission time');
    if (old && (JSON.stringify(old.assist) !== JSON.stringify(job.assist) || (old.assist && (old.authorizationId !== job.authorizationId || old.authorizationRevision !== job.authorizationRevision || old.authorizationExpiresAt !== job.authorizationExpiresAt)))) throw new AppError('job_identity_changed', 'A job cannot change its assistance session or admission authorization');
    if (old && job.revision < old.revision) return;
    if (old && old.revision === job.revision && JSON.stringify(jobViewSchema.parse(old)) !== JSON.stringify(jobViewSchema.parse(job))) throw new AppError('job_revision_conflict', 'One job revision cannot describe two different execution states');
    if (old && old.finished && (!terminalJob(job) || !job.finished)) throw new AppError('job_regressed', 'A completed execution cannot become active again');
    if (!old) {
      let count = this.counts.get(deviceId) ?? this.count(deviceId);
      if (count >= 10000) count = this.count(deviceId);
      if (count >= 10000) {
        const row = this.store.db.prepare("SELECT data FROM records WHERE bucket='jobs' AND id>=? AND id<? AND json_extract(data,'$.finished') IS NOT NULL ORDER BY json_extract(data,'$.observedAt') LIMIT 1").get(`${deviceId}:`, `${deviceId};`);
        const oldest = row ? JSON.parse(row.data as string) as JobRecord : undefined;
        if (!oldest) throw new AppError('job_limit', 'Too many active job observations');
        this.store.delete('jobs', this.key(deviceId, oldest.id));
      } else count++;
      this.counts.set(deviceId, count);
    }
    this.store.put('jobs', key, { ...job, deviceId, runnerInstanceId: instanceId, observedAt: Date.now() } satisfies JobRecord);
  }
  reconcile(deviceId: string, seen: Set<string>) {
    for (const job of this.list(undefined, { deviceId, limit: 10000 })) {
      if (!seen.has(job.id) && !job.missingSince) {
        job.missingSince = Date.now();
        this.store.put('jobs', this.key(deviceId, job.id), job);
      }
    }
  }
}
