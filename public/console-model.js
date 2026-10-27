// All figures describe the bounded snapshot returned by /api/state.
const activeStates = new Set(['starting', 'running', 'stopping']);
const asArray = value => Array.isArray(value) ? value : [];
const inWindow = (entry, start, end) => Number.isFinite(entry.at) && entry.at >= start && entry.at <= end;
function permissionLabel(permissions = {}) {
  const scopes = asArray(permissions.scopes).slice().sort().join(',');
  if (permissions.tools !== null || permissions.machineAccess) return '自定义权限';
  if (scopes === 'read' && !permissions.unrestrictedExecution) return '只读查看';
  if (scopes === 'execute,git,read,write' && permissions.unrestrictedExecution) return '完整开发';
  return '自定义权限';
}

export function jobLabel(state) {
  return { starting: '启动中', running: '运行中', stopping: '停止中', exited: '已结束', failed: '失败', stopped: '已停止', timed_out: '已超时', interrupted: '已中断' }[state] ?? state ?? '未知';
}

export function summarizeConsole(state = {}, now = Date.now()) {
  const devices = asArray(state.devices), audit = asArray(state.audit), jobs = asArray(state.jobs);
  const grants = asArray(state.authorizations).filter(grant => !grant.revoked && (grant.expires === undefined || grant.expires > now));
  const tokens = asArray(state.tokens).filter(token => !token.revoked && token.expires > now);
  const registered = new Map(asArray(state.clients).map(client => [client.id, client.name]));
  const recentEvents = audit.filter(entry => inWindow(entry, now - 15000, now));
  const groups = new Map();
  for (const grant of grants) {
    const id = grant.clientId;
    let group = groups.get(id);
    if (!group) {
      group = { id, name: registered.get(id) || id, kinds: new Set(), grantIds: [], projects: new Set(), labels: new Set() };
      groups.set(id, group);
    }
    group.kinds.add(grant.kind); group.grantIds.push(grant.id);
    for (const [deviceId, projects] of Object.entries(grant.permissions?.projectGrants ?? {})) {
      for (const projectId of asArray(projects)) group.projects.add(JSON.stringify([deviceId, projectId]));
    }
    group.labels.add(permissionLabel(grant.permissions));
  }
  const clients = [...groups.values()].map(group => {
    const used = tokens.filter(token => token.clientId === group.id && group.grantIds.includes(token.family)).map(token => token.lastUsed).filter(value => Number.isFinite(value) && value > 0 && value <= now);
    const scopeLabel = group.labels.size === 1 ? [...group.labels][0] : '多组权限';
    return { id: group.id, name: group.name, kind: group.kinds.size > 1 ? 'mixed' : [...group.kinds][0], grantIds: group.grantIds, projectCount: group.projects.size, scopeLabel, lastUsed: used.length ? Math.max(...used) : null };
  }).sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  const runners = devices.map(device => ({ ...device, recentCount: recentEvents.filter(entry => entry.deviceId === device.id).length }))
    .sort((a, b) => Number(!!b.online && !b.paused) - Number(!!a.online && !a.paused));
  const activeJobs = jobs.filter(job => activeStates.has(job.state) && job.available && job.observation === 'live');
  const unconfirmedJobs = jobs.filter(job => activeStates.has(job.state) && !(job.available && job.observation === 'live'));
  const policyAlerts = [];
  for (const device of devices) {
    const name = device.name || device.id;
    if (device.permissionError) policyAlerts.push({ id: `error:${device.id}`, title: name, detail: `权限应用失败：${device.permissionError}`, tone: 'error', deviceId: device.id, priority: 0 });
    else if (device.permissionAppliedRevision !== (device.permissions?.revision ?? 0)) policyAlerts.push({ id: `pending:${device.id}`, title: name, detail: '权限已保存，等待 Runner 应用', tone: 'pending', deviceId: device.id, priority: 1 });
    if (device.permissions?.expiresAt > now) policyAlerts.push({ id: `temporary-device:${device.id}`, title: name, detail: `临时权限至 ${new Date(device.permissions.expiresAt).toLocaleString('zh-CN')}`, tone: 'pending', deviceId: device.id, priority: 2 });
    if (!asArray(device.permissions?.projects ?? device.projects).length) policyAlerts.push({ id: `projects:${device.id}`, title: name, detail: '尚未配置可访问项目', tone: 'muted', deviceId: device.id, priority: 3 });
  }
  for (const grant of grants) {
    if (grant.temporaryExpiresAt > now) policyAlerts.push({ id: `temporary-grant:${grant.id}`, title: registered.get(grant.clientId) || grant.clientId, detail: `临时授权至 ${new Date(grant.temporaryExpiresAt).toLocaleString('zh-CN')}`, tone: 'pending', authorizationId: grant.id, priority: 2 });
  }
  policyAlerts.sort((a, b) => a.priority - b.priority);
  const durations = audit.map(entry => entry.durationMs).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianDuration = !durations.length ? null : durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
  const ok = audit.filter(entry => entry.status === 'ok').length;
  return { clients, runners, activeJobs, unconfirmedJobs, policyAlerts, outcomes: { ok, other: audit.length - ok, total: audit.length }, medianDuration, recentEvents, projects: devices.reduce((count, device) => count + asArray(device.projects).length, 0) };
}

export function auditTimeline(audit = [], { now = Date.now(), bins = 20, windowMs = 3600000 } = {}) {
  if (!Number.isInteger(bins) || bins < 1 || bins > 1000 || !Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(now)) throw new RangeError('Invalid audit timeline window');
  const start = now - windowMs, width = windowMs / bins;
  const buckets = Array.from({ length: bins }, (_, index) => ({ at: start + index * width, total: 0, other: 0 }));
  let total = 0, other = 0;
  for (const entry of asArray(audit)) {
    if (!inWindow(entry, start, now)) continue;
    const bucket = buckets[Math.min(bins - 1, Math.floor((entry.at - start) / width))];
    bucket.total++; total++;
    if (entry.status !== 'ok') { bucket.other++; other++; }
  }
  return { start, end: now, buckets, total, other };
}
