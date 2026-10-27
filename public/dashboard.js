import { createPermissionEditors } from './permissions.js';
import { createProjectTargets, rolePermissions } from './ui.js';
let csrf = '', state, deviceChoicesSignature = '', selectedJob, tokenTargets;
let refreshQueue = Promise.resolve(), pairing = false, creatingToken = false;
const rendered = new Map(), jobRows = new Map();
const $ = id => document.getElementById(id);
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
const date = value => value ? new Date(value).toLocaleString() : '尚未使用';
function notify(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : 'success'; }
function changed(id, value) {
  const signature = JSON.stringify(value);
  if (rendered.get(id) === signature) return false;
  rendered.set(id, signature); return true;
}
async function api(url, body) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  if (response.status === 401) { location.href = '/login'; throw new Error('需要重新登录'); }
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.message ?? data.error ?? '请求失败'); error.code = data.error; throw error; }
  return data;
}
function action(label, callback, danger = false, { reload = true, message = '操作已完成' } = {}) {
  const button = text('button', label, danger ? 'danger' : 'secondary');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (await callback() === false) return;
      if (reload) await refresh();
      if (message) notify(message);
    } catch (error) { notify(error.message, true); }
    finally { button.disabled = false; }
  });
  return button;
}
const permissionEditors = createPermissionEditors({ api, refresh, notify });
async function readJobOutput(job, reset = false) {
  if (reset) {
    selectedJob = { deviceId: job.deviceId, id: job.id, cursor: job.totalOutputBytes === undefined ? 0 : undefined, view: job.totalOutputBytes === undefined ? 'prefix' : 'tail' };
    $('jobOutput').textContent = '';
    $('jobOutputTitle').textContent = `任务输出 · ${job.executable} · ${job.id.slice(0, 8)}`;
  }
  const current = selectedJob;
  if (!current) return;
  const output = await api(`/api/jobs/${current.deviceId}/${current.id}/output?view=${current.view}${current.cursor === undefined ? '' : `&cursor=${current.cursor}`}&length=65536`);
  if (selectedJob !== current) return;
  current.cursor = output.nextCursor;
  $('jobOutputPanel').hidden = false;
  $('jobOutput').textContent = ($('jobOutput').textContent + (output.skippedBytes ? `\n[日志轮转，跳过 ${output.skippedBytes} 字节]\n` : '') + output.output).slice(-262144);
  $('jobOutputNext').disabled = !!output.finished && output.nextCursor >= (output.totalOutputBytes ?? output.outputBytes);
}
function refresh() {
  const next = refreshQueue.catch(() => {}).then(fetchAndRender);
  refreshQueue = next; return next;
}
async function fetchAndRender() {
  state = await api('/api/state'); csrf = state.csrf;
  $('connectionStatus').textContent = '已同步'; $('connectionStatus').className = 'system-status';
  permissionEditors.update(state);
  $('online').textContent = state.devices.filter(device => device.online).length;
  $('total').textContent = state.devices.length;
  $('clientCount').textContent = state.clientCount;
  $('calls').textContent = state.audit.length;
  $('endpoint').textContent = `${state.publicUrl}/mcp`;
  $('updated').textContent = `更新于 ${new Date().toLocaleTimeString()}`;
  if (changed('devices', state.devices.map(({ lastSeen, ...device }) => device))) {
  $('devices').replaceChildren();
  if (!state.devices.length) $('devices').append(text('p', '暂无设备。在被控端执行 homeagent login，打开终端中的链接添加设备。', 'muted'));
  for (const device of state.devices) {
    const card = text('article', '', 'device');
    const title = text('div', '', 'section-title');
    title.append(text('h3', device.name), text('span', device.paused ? '已暂停' : device.online ? '在线' : '离线', device.online && !device.paused ? 'badge online' : 'badge'));
    card.append(title, text('code', device.id), text('p', device.platform ? `${device.platform} · Runner ${device.runnerVersion ?? '未知'} · 实例 ${(device.runnerInstanceId ?? '未知').slice(0, 8)}` : '等待 Runner 首次连接', 'muted'));
    if (!device.projects.length) card.append(text('p', '尚无已应用项目。点击“设备设置”配置项目，等待 Runner 上线并应用。', 'muted'));
    for (const project of device.projects) {
      const git = project.allowGitWrite && project.allowGitNetwork && project.allowGitPush ? '开启' : [project.allowGitWrite, project.allowGitNetwork, project.allowGitPush].some(Boolean) ? '自定义' : '关闭';
      card.append(text('p', `${project.name} · ${project.readOnly ? '只读查看' : project.commandMode === 'unrestricted' ? '完整开发' : '自定义访问'} · Git ${git}`));
      if (project.commandAliasNames?.length) card.append(text('p', `允许的命令别名：${project.commandAliasNames.join(', ')}`, 'muted'));
      if (project.environmentNames?.length) card.append(text('p', `环境配置：${project.environmentNames.join(', ')}`, 'muted'));
    }
    const buttons = text('div', '', 'actions');
    const edit = action('设备设置', () => permissionEditors.openDevice(device.id), false, { reload: false, message: '' });
    edit.id = `edit-device-${device.id}`; buttons.append(edit);
    const policy = device.permissions, applied = device.permissionAppliedRevision === (policy?.revision ?? 0);
    card.append(text('p', device.permissionError ? `权限应用失败：${device.permissionError}` : !applied ? '权限等待 Runner 应用' : policy?.expiresAt && policy.expiresAt > Date.now() ? `临时设备权限至 ${date(policy.expiresAt)}` : '设备权限已应用', device.permissionError ? 'error' : 'muted'));
    buttons.append(action(device.paused ? '恢复' : '暂停', () => api(`/api/devices/${device.id}/${device.paused ? 'resume' : 'pause'}`, {})));
    buttons.append(action('重命名', async () => { const name = prompt('设备名称', device.name); if (!name?.trim() || name.trim() === device.name) return false; await api(`/api/devices/${device.id}/rename`, { name: name.trim() }); }));
    buttons.append(action('撤销设备', async () => { if (!confirm(`撤销 ${device.name}？连接将关闭，运行中的托管进程会停止，重新使用需要登录。`)) return false; await api(`/api/devices/${device.id}/revoke`, {}); }, true));
    card.append(buttons); $('devices').append(card);
  }
  }
  const activeJobs = new Set(state.jobs.map(job => job.id));
  for (const [id, record] of jobRows) if (!activeJobs.has(id)) { record.row.remove(); jobRows.delete(id); }
  if (state.jobs.length) $('jobs').querySelector('[data-empty]')?.remove();
  for (const job of state.jobs) {
    let record = jobRows.get(job.id);
    if (!record) {
      const row = document.createElement('tr'), cells = Array.from({ length: 5 }, () => document.createElement('td')), controls = document.createElement('td');
      row.append(...cells, controls); $('jobs').append(row);
      record = { row, cells, controls, actions: '' }; jobRows.set(job.id, record);
    }
    const suffix = job.observation === 'live' ? '' : job.observation === 'retained' ? '（保留结果）' : job.observation === 'missing' ? '（Runner 未报告）' : '（离线，未确认）';
    [date(job.started), `${job.executable} / ${job.id.slice(0, 8)}`, `${job.deviceId.slice(0, 8)} / ${job.projectId}`, `${job.state}${suffix}`, `${job.totalOutputBytes ?? job.outputBytes}${job.truncated ? '（保留首段与尾部）' : ''}`].forEach((value, index) => { record.cells[index].textContent = value; });
    const actions = JSON.stringify([job.available, ['starting', 'running'].includes(job.state)]);
    if (record.actions !== actions) {
    record.actions = actions;
    const controls = record.controls; controls.replaceChildren();
    if (job.available) {
      controls.append(action('读取输出', () => readJobOutput(job, true), false, { reload: false, message: '' }));
      if (['starting', 'running'].includes(job.state)) controls.append(action('停止', () => api(`/api/jobs/${job.deviceId}/${job.id}/stop`, {}), true));
    } else controls.append(text('span', 'Runner 不可访问', 'muted'));
    }
  }
  if (!state.jobs.length && !$('jobs').querySelector('[data-empty]')) { const row = document.createElement('tr'); row.dataset.empty = 'true'; const cell = text('td', '暂无任务。启动命令后在此观察状态。'); cell.colSpan = 6; row.append(cell); $('jobs').append(row); }
  // Preserve form selections across background refresh.
  const signature = JSON.stringify(state.devices.map(device => [device.id, device.name, device.projects.map(project => [project.id, project.name])]));
  if (signature !== deviceChoicesSignature) {
    deviceChoicesSignature = signature;
    tokenTargets = createProjectTargets($('tokenDevices'), state.devices, tokenTargets?.value());
  }
  $('token').querySelector('button').disabled = creatingToken || !state.devices.some(device => device.projects.length);
  if (changed('tokens', state.tokens)) {
  $('tokens').replaceChildren();
  for (const token of state.tokens) {
    const row = document.createElement('tr');
    for (const value of [token.clientId, token.kind, token.scopes.join(', '), date(token.lastUsed), date(token.expires)]) row.append(text('td', value));
    const cell = document.createElement('td');
    if (token.revoked) cell.append(text('span', '已撤销', 'muted'));
    else cell.append(action('撤销', () => api(`/api/tokens/${token.tokenId}/revoke`, {}), true));
    row.append(cell); $('tokens').append(row);
  }
  if (!state.tokens.length) { const row = document.createElement('tr'); const cell = text('td', '暂无客户端会话或令牌'); cell.colSpan = 6; row.append(cell); $('tokens').append(row); }
  }
  if (changed('sessions', state.sessions)) {
  $('sessions').replaceChildren();
  for (const session of state.sessions) {
    const row = document.createElement('tr');
    for (const value of [session.userAgent || '未知浏览器', date(session.lastSeen), date(session.expires), session.current ? '当前会话' : '其他登录']) row.append(text('td', value));
    const cell = document.createElement('td');
    cell.append(action('撤销登录', async () => { const value = await api(`/api/sessions/${session.id}/revoke`, {}); if (value.current) location.href = '/login'; }, true));
    row.append(cell); $('sessions').append(row);
  }
  }
  if (changed('oauthClients', state.clients)) {
  $('oauthClients').replaceChildren();
  for (const client of state.clients) {
    const row = document.createElement('tr');
    row.append(text('td', client.name), text('td', client.redirects.join(', ')));
    const cell = document.createElement('td');
    cell.append(action('撤销客户端', () => api(`/api/clients/${client.id}/revoke`, {}), true));
    row.append(cell); $('oauthClients').append(row);
  }
  if (!state.clients.length) { const row = document.createElement('tr'); const cell = text('td', '暂无 OAuth 客户端'); cell.colSpan = 3; row.append(cell); $('oauthClients').append(row); }
  }
  if (changed('audit', state.audit)) {
  $('audit').replaceChildren();
  for (const entry of state.audit) {
    const row = document.createElement('tr');
    for (const value of [date(entry.at), entry.tool, `${entry.deviceId.slice(0, 8) || '—'} / ${entry.projectId || '—'}`, entry.principal, entry.status, `${entry.durationMs} ms`]) row.append(text('td', value));
    $('audit').append(row);
  }
  }
}
$('pair').addEventListener('submit', async event => {
  event.preventDefault();
  if (pairing) return;
  pairing = true; const submit = event.target.querySelector('button'); submit.disabled = true;
  try {
    const code = new FormData(event.target).get('code'), preview = await api('/api/pair/inspect', { code });
    if (!confirm(`确认配对设备“${preview.name}”？请与 Runner 输出的名称核对。`)) return;
    const value = await api('/api/pair/approve', { code }); $('pairResult').textContent = `已批准 ${value.name}，等待 Runner 领取凭据。`; event.target.reset(); await refresh();
  }
  catch (error) { $('pairResult').textContent = error.message; $('pairResult').className = 'error'; }
  finally { pairing = false; submit.disabled = false; }
});
$('token').addEventListener('submit', async event => {
  event.preventDefault();
  if (creatingToken) return;
  const form = new FormData(event.target), projectGrants = tokenTargets?.value() ?? {}, devices = Object.keys(projectGrants);
  if (!devices.length) { $('tokenStatus').textContent = '请至少选择一个项目。'; $('tokenStatus').className = 'error'; return; }
  creatingToken = true; const submit = event.target.querySelector('button'); submit.disabled = true;
  $('tokenStatus').textContent = '正在创建令牌…'; $('tokenStatus').className = 'pending';
  try {
    const { scopes, unrestrictedExecution, machineAccess } = rolePermissions(form.get('access'));
    const value = await api('/api/tokens', { name: form.get('name'), scopes, devices, projects: null, projectGrants, unrestrictedExecution, machineAccess, expiresDays: Number(form.get('days')) });
    $('newTokenPanel').hidden = false; $('newToken').textContent = value.token;
    $('tokenStatus').textContent = '令牌已创建，请复制下方令牌。'; $('tokenStatus').className = 'success';
    await refresh().catch(() => notify('令牌已创建，但页面暂时无法刷新。请先复制保存令牌。', true));
  } catch (error) { $('tokenStatus').textContent = error.message; $('tokenStatus').className = 'error'; }
  finally { creatingToken = false; submit.disabled = false; }
});
$('logout').addEventListener('click', async () => { try { await api('/logout', {}); location.href = '/login'; } catch (error) { notify(error.message, true); } });
$('jobOutputNext').addEventListener('click', async () => {
  const submit = $('jobOutputNext'); submit.disabled = true;
  try { await readJobOutput(); } catch (error) { notify(error.message, true); submit.disabled = false; }
});
$('closeJobOutput').addEventListener('click', () => { selectedJob = undefined; $('jobOutputPanel').hidden = true; });
async function copy(value, message) {
  try { await navigator.clipboard.writeText(value); notify(message); }
  catch { notify('浏览器未允许复制，请手动选择内容复制。', true); }
}
$('copyEndpoint').addEventListener('click', () => { if ($('endpoint').textContent) void copy($('endpoint').textContent, 'MCP 地址已复制'); });
$('copyToken').addEventListener('click', () => { if ($('newToken').textContent) void copy($('newToken').textContent, '令牌已复制'); });
$('hideToken').addEventListener('click', () => { $('newToken').textContent = ''; $('newTokenPanel').hidden = true; });
async function poll() {
  try { await refresh(); }
  catch (error) { $('connectionStatus').textContent = '同步失败，稍后重试'; $('connectionStatus').className = 'error'; notify(error.message, true); }
  setTimeout(poll, 5000);
}
void poll();
