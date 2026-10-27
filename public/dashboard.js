import { createPermissionEditors } from './permissions.js';
import { createProjectTargets, rolePermissions } from './ui.js';

const $ = id => document.getElementById(id);
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
const date = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚未使用';
const fullDate = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未使用';
const bytes = value => { const count = value ?? 0; return count < 1024 ? `${count} B` : count < 1048576 ? `${(count / 1024).toFixed(1)} KB` : `${(count / 1048576).toFixed(1)} MB`; };
const active = job => ['starting', 'running', 'stopping'].includes(job.state);
const views = {
  overview: ['概览', '连接你的开发环境，掌握设备、授权和任务的运行状态。'],
  devices: ['设备与项目', '管理连接的机器，为每个项目配置清晰的访问边界。'],
  jobs: ['任务中心', '查看命令执行状态、读取输出，随时停止运行中的任务。'],
  access: ['客户端访问', '连接 AI 客户端，管理项目授权和访问令牌。'],
  activity: ['操作记录', '追踪每一次调用的来源、结果和耗时。'],
  settings: ['连接与安全', '管理登录会话、客户端和令牌的生命周期。'],
};
const legacyViews = { 'devices-section': 'devices', 'jobs-section': 'jobs', 'access-section': 'access', 'audit-section': 'activity' };
let csrf = '', state, selectedJob, tokenTargets, deviceChoicesSignature, refreshInFlight;
let pairing = false, creatingToken = false, noticeTimeout, confirmation, view = '';
const rendered = new Map(), jobRows = new Map();
function changed(id, value) { const signature = JSON.stringify(value); if (rendered.get(id) === signature) return false; rendered.set(id, signature); return true; }
function setText(id, value) { if ($(id)) $(id).textContent = value; }
function badge(value, tone = '') { return text('span', value, `status-badge badge ${tone}`); }
function icon() {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) node.setAttribute(name, value);
  const path = document.createElementNS(node.namespaceURI, 'path'); path.setAttribute('d', 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM8 22h8m-4-4v4M7 9l3 3-3 3m6 0h4'); node.append(path); return node;
}
function empty(title, description, reset) {
  const node = text('div', '', 'empty-state'); node.append(text('strong', title), text('p', description));
  if (reset) node.append(action('清除筛选', reset, false, { reload: false, message: '' })); return node;
}
function emptyRow(container, columns, title, description, reset) {
  const row = document.createElement('tr'), cell = document.createElement('td'); row.dataset.empty = 'true'; cell.colSpan = columns; cell.append(empty(title, description, reset)); row.append(cell); container.append(row);
}
function notify(message, error = false) {
  const notice = $('notice'); if (!notice) return;
  clearTimeout(noticeTimeout); notice.hidden = false; notice.textContent = message; notice.className = `toast ${error ? 'error' : 'success'}`;
  notice.setAttribute('role', error ? 'alert' : 'status');
  noticeTimeout = setTimeout(() => { notice.hidden = true; }, error ? 9000 : 5000);
}
function navigate() {
  const requested = location.hash.slice(1), next = Object.hasOwn(views, requested) ? requested : Object.hasOwn(legacyViews, requested) ? legacyViews[requested] : 'overview';
  const switching = view && view !== next; view = next;
  for (const panel of document.querySelectorAll('[data-view]')) panel.hidden = panel.dataset.view !== next;
  for (const link of document.querySelectorAll('[data-view-link]')) {
    const selected = link.hash === `#${next}`;
    link.classList.toggle('is-active', selected && !!link.closest('nav'));
    if (selected && link.closest('nav')) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  setText('viewTitle', views[next][0]); setText('viewDescription', views[next][1]);
  document.title = `${views[next][0]} · HomeAgent`;
  document.body.classList.remove('sidebar-open'); $('sidebarToggle')?.setAttribute('aria-expanded', 'false');
  if (switching) { window.scrollTo({ top: 0, behavior: 'instant' }); $('viewTitle')?.focus({ preventScroll: true }); }
}
window.addEventListener('hashchange', navigate);
$('sidebarToggle')?.addEventListener('click', () => { const opened = document.body.classList.toggle('sidebar-open'); $('sidebarToggle').setAttribute('aria-expanded', String(opened)); });
navigate();

/** A single native dialog keeps confirmations in context and returns focus on close. */
function ask({ title, description, confirmLabel = '确认', danger = false, value } = {}) {
  if (confirmation) return Promise.resolve(false);
  const panel = $('confirmDialog'), input = $('confirmInput'), opener = document.activeElement;
  if (!panel) return Promise.reject(new Error('确认窗口暂时不可用，请刷新页面后重试。'));
  setText('confirmTitle', title); setText('confirmDescription', description); setText('confirmSubmit', confirmLabel); setText('confirmError', '');
  $('confirmSubmit').className = danger ? 'danger' : 'primary';
  $('confirmInputField').hidden = value === undefined; input.required = value !== undefined; input.value = value ?? ''; input.setCustomValidity('');
  panel.showModal();
  if (value !== undefined) { input.focus(); input.select(); } else $('confirmCancel').focus();
  return new Promise(resolve => { confirmation = { resolve, opener, input: value !== undefined }; });
}
function finishConfirmation(value) {
  const current = confirmation; if (!current) return;
  confirmation = undefined; $('confirmDialog').close(); current.resolve(value);
  requestAnimationFrame(() => { const opener = current.opener?.id ? $(current.opener.id) : current.opener; if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true }); });
}
$('confirmForm')?.addEventListener('submit', event => {
  event.preventDefault(); if (!confirmation) return;
  const value = $('confirmInput').value.trim();
  if (confirmation.input && !value) { setText('confirmError', '请输入设备名称。'); $('confirmInput').focus(); return; }
  finishConfirmation(confirmation.input ? value : true);
});
$('confirmCancel')?.addEventListener('click', () => finishConfirmation(false));
$('confirmDialog')?.addEventListener('cancel', event => { event.preventDefault(); finishConfirmation(false); });
$('confirmDialog')?.addEventListener('click', event => {
  const panel = $('confirmDialog'), rect = panel.getBoundingClientRect();
  if (event.target === panel && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) finishConfirmation(false);
});
$('confirmDialog')?.addEventListener('close', () => { if (confirmation && !$('confirmDialog').open) finishConfirmation(false); });
async function api(url, body) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (response.status === 401) { location.href = '/login'; throw new Error('登录已过期，请重新登录。'); }
  const data = await response.json().catch(() => { throw new Error('服务暂时不可用，请稍后重试。'); });
  if (!response.ok) { const error = new Error(data.message ?? data.error ?? '请求失败，请重试。'); error.code = data.error; throw error; }
  return data;
}
function action(label, callback, danger = false, { reload = true, message = '操作已完成' } = {}) {
  const button = text('button', label, danger ? 'danger' : 'secondary'); button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    try { if (await callback() === false) return; if (reload) await refresh(); if (message) notify(message); }
    catch (error) { notify(error.name === 'TimeoutError' ? '请求超时，请检查连接后重试。' : error.message, true); }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  }); return button;
}
const permissionEditors = createPermissionEditors({ api, refresh, notify, ask });
const deviceName = id => state.devices.find(device => device.id === id)?.name ?? id?.slice(0, 8) ?? '—';
const projectName = (deviceId, projectId) => state.devices.find(device => device.id === deviceId)?.projects.find(project => project.id === projectId)?.name ?? projectId;
function renderDevices() {
  if (!state) return;
  const query = $('deviceSearch')?.value.trim().toLowerCase() ?? '', filter = $('deviceFilter')?.value ?? 'all';
  if (!changed('devices', [state.devices.map(({ lastSeen, ...device }) => device), query, filter])) return;
  const devices = state.devices.filter(device => (!query || [device.name, device.id, device.platform, ...device.projects.map(project => project.name)].join(' ').toLowerCase().includes(query)) &&
    (filter === 'all' || filter === 'paused' && device.paused || filter === 'online' && device.online && !device.paused || filter === 'offline' && !device.online && !device.paused));
  $('devices').replaceChildren();
  setText('deviceCount', state.devices.length);
  if (!devices.length) {
    $('devices').append(empty(state.devices.length ? '没有符合条件的设备' : '连接你的第一台设备', state.devices.length ? '试试其他名称或设备状态。' : '在开发机器上运行 homeagent login，完成浏览器配对后即可开始。', state.devices.length ? () => { if ($('deviceSearch')) $('deviceSearch').value = ''; if ($('deviceFilter')) $('deviceFilter').value = 'all'; renderDevices(); } : undefined)); return;
  }
  for (const device of devices) {
    const card = text('article', '', 'device device-card'), top = text('div', '', 'device-top');
    const deviceIcon = text('div', '', 'device-icon'); deviceIcon.append(icon());
    const identity = text('div', '', 'device-identity'); identity.append(text('h3', device.name, 'device-name'), text('p', device.platform ? `${device.platform} · Runner ${device.runnerVersion ?? '待确认'}` : '等待首次连接', 'device-platform'));
    top.append(deviceIcon, identity, badge(device.paused ? '已暂停' : device.online ? '在线' : '离线', device.paused ? 'paused' : device.online ? 'online' : 'offline')); card.append(top);
    const projects = text('div', '', 'device-projects');
    for (const project of device.projects) {
      const item = text('div', '', 'project-chip'), main = text('div', '', 'project-chip-main');
      main.append(text('strong', project.name), text('span', project.readOnly ? '只读' : project.commandMode === 'unrestricted' ? '完整开发' : '自定义', 'scope-label'));
      item.append(main);
      const git = project.allowGitWrite && project.allowGitNetwork && project.allowGitPush ? 'Git 已开启' : [project.allowGitWrite, project.allowGitNetwork, project.allowGitPush].some(Boolean) ? 'Git 自定义' : 'Git 已关闭';
      item.append(text('small', git));
      if (project.commandAliasNames?.length || project.environmentNames?.length) item.append(text('small', [project.commandAliasNames?.length ? `命令：${project.commandAliasNames.join('、')}` : '', project.environmentNames?.length ? `环境：${project.environmentNames.join('、')}` : ''].filter(Boolean).join(' · ')));
      projects.append(item);
    }
    if (!device.projects.length) projects.append(text('p', '尚未配置项目，打开设备设置添加项目目录。', 'muted')); card.append(projects);
    const policy = device.permissions, applied = device.permissionAppliedRevision === (policy?.revision ?? 0);
    card.append(text('p', device.permissionError ? `权限应用失败：${device.permissionError}` : !applied ? '配置已保存，等待设备应用' : policy?.expiresAt && policy.expiresAt > Date.now() ? `临时权限至 ${date(policy.expiresAt)}` : '设备权限已应用', `device-meta ${device.permissionError ? 'error' : !applied ? 'pending' : 'muted'}`));
    const details = text('details', '', 'device-details'); details.append(text('summary', '设备信息'));
    details.append(text('code', device.id, 'device-id')); if (device.runnerInstanceId) details.append(text('small', `运行实例 ${device.runnerInstanceId.slice(0, 8)}`, 'muted')); card.append(details);
    const controls = text('div', '', 'actions device-actions');
    const edit = action('设备设置', () => permissionEditors.openDevice(device.id), false, { reload: false, message: '' }); edit.id = `edit-device-${device.id}`; controls.append(edit);
    controls.append(action(device.paused ? '恢复连接' : '暂停', async () => {
      if (!device.paused && !await ask({ title: '暂停设备？', description: `暂停「${device.name}」后将停止当前托管任务，并暂时阻止新的调用。可以随时恢复连接。`, confirmLabel: '暂停设备' })) return false;
      await api(`/api/devices/${device.id}/${device.paused ? 'resume' : 'pause'}`, {});
    }));
    controls.append(action('重命名', async () => { const name = await ask({ title: '重命名设备', description: '使用容易辨认的名称，方便在任务和授权中找到这台设备。', confirmLabel: '保存名称', value: device.name }); if (name === false || name === device.name) return false; await api(`/api/devices/${device.id}/rename`, { name }); }));
    controls.append(action('撤销', async () => { if (!await ask({ title: '撤销设备连接？', description: `「${device.name}」的连接将被关闭，托管任务将停止。再次使用需要重新登录并配对。`, confirmLabel: '撤销设备', danger: true })) return false; await api(`/api/devices/${device.id}/revoke`, {}); }, true));
    for (const [index, name] of ['settings', 'connection', 'rename', 'revoke'].entries()) if (!controls.children[index].id) controls.children[index].id = `${name}-device-${device.id}`;
    card.append(controls); $('devices').append(card);
  }
}
const jobLabels = { starting: '启动中', running: '运行中', stopping: '停止中', exited: '已完成', failed: '执行失败', stopped: '已停止', timed_out: '已超时', interrupted: '已中断' };
function jobTone(job) { return active(job) ? 'running' : job.state === 'exited' ? 'success' : ['failed', 'timed_out'].includes(job.state) ? 'failed' : 'offline'; }
function renderJobs() {
  if (!state) return;
  const filter = $('jobFilter')?.value ?? 'all', matching = job => filter === 'all' || filter === 'running' && active(job) || filter === 'exited' && job.state === 'exited' || filter === 'failed' && ['failed', 'timed_out', 'interrupted'].includes(job.state);
  const current = new Set(state.jobs.map(job => `${job.deviceId}:${job.id}`));
  for (const [id, record] of jobRows) if (!current.has(id)) { record.row.remove(); jobRows.delete(id); }
  $('jobs').querySelector('[data-empty]')?.remove();
  let visible = 0;
  for (const job of state.jobs) {
    const key = `${job.deviceId}:${job.id}`; let record = jobRows.get(key);
    if (!record) {
      const row = document.createElement('tr'), cells = Array.from({ length: 5 }, () => document.createElement('td')), controls = document.createElement('td'); row.append(...cells, controls); $('jobs').append(row);
      record = { row, cells, controls }; jobRows.set(key, record);
    }
    record.job = job; record.row.hidden = !matching(job); if (!record.row.hidden) visible++;
    if (record.signature !== JSON.stringify([job, deviceName(job.deviceId), projectName(job.deviceId, job.projectId)])) {
      record.signature = JSON.stringify([job, deviceName(job.deviceId), projectName(job.deviceId, job.projectId)]);
      record.cells[0].textContent = date(job.started); record.cells[0].title = fullDate(job.started);
      record.cells[1].replaceChildren(text('strong', job.executable, 'job-program'), text('small', job.id.slice(0, 8), 'cell-subtitle job-id'));
      record.cells[2].replaceChildren(text('span', deviceName(job.deviceId)), text('small', projectName(job.deviceId, job.projectId), 'cell-subtitle'));
      const status = badge(jobLabels[job.state] ?? job.state, jobTone(job)); record.cells[3].replaceChildren(status);
      if (job.observation !== 'live') record.cells[3].append(text('small', job.observation === 'retained' ? '保留结果' : job.observation === 'missing' ? '设备未报告' : '离线，状态待确认', 'cell-subtitle'));
      record.cells[4].textContent = bytes(job.totalOutputBytes ?? job.outputBytes); if (job.truncated) record.cells[4].append(text('small', '保留首段与尾部', 'cell-subtitle'));
    }
    const signature = JSON.stringify([job.available, active(job)]);
    if (record.actions !== signature) {
      record.actions = signature; record.controls.replaceChildren();
      if (job.available) {
        record.controls.append(action('查看输出', () => readJobOutput(record.job, true), false, { reload: false, message: '' }));
        if (active(job)) record.controls.append(action('停止', async () => { if (!await ask({ title: '停止运行中的任务？', description: `将停止 ${record.job.executable} 及其托管子进程，已产生的文件修改会保留。`, confirmLabel: '停止任务', danger: true })) return false; await api(`/api/jobs/${record.job.deviceId}/${record.job.id}/stop`, {}); }, true));
      } else record.controls.append(text('span', '设备暂不可访问', 'muted'));
    }
  }
  if (!visible) emptyRow($('jobs'), 6, state.jobs.length ? '暂无符合条件的任务' : '还没有执行任务', state.jobs.length ? '可以切换状态筛选，查看其他执行记录。' : '通过 AI 客户端运行命令后，可以在这里查看状态和输出。', state.jobs.length ? () => { $('jobFilter').value = 'all'; renderJobs(); } : undefined);
  setText('jobCount', state.jobs.filter(active).length);
}
async function readJobOutput(job, reset = false) {
  if (reset) {
    selectedJob = { deviceId: job.deviceId, id: job.id, cursor: job.totalOutputBytes === undefined ? 0 : undefined, view: job.totalOutputBytes === undefined ? 'prefix' : 'tail', outputText: '' };
    $('jobOutput').textContent = ''; setText('jobOutputTitle', `${job.executable} · ${job.id.slice(0, 8)}`);
    $('jobOutputPanel').hidden = false; $('jobOutputPanel').setAttribute('aria-busy', 'true');
  }
  const current = selectedJob; if (!current) return;
  try {
    const output = await api(`/api/jobs/${current.deviceId}/${current.id}/output?view=${current.view}${current.cursor === undefined ? '' : `&cursor=${current.cursor}`}&length=65536`);
    if (selectedJob !== current) return;
    current.cursor = output.nextCursor;
    current.outputText = (current.outputText + (output.skippedBytes ? `\n[日志轮转，跳过 ${bytes(output.skippedBytes)}]\n` : '') + output.output).slice(-262144);
    $('jobOutput').textContent = current.outputText || '该任务暂时没有输出。';
    $('jobOutputNext').disabled = !!output.finished && output.nextCursor >= (output.totalOutputBytes ?? output.outputBytes);
    if (reset) $('jobOutputPanel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
  } catch (error) { if (selectedJob === current && !$('jobOutput').textContent) $('jobOutput').textContent = error.message; throw error; }
  finally { if (selectedJob === current) $('jobOutputPanel').removeAttribute('aria-busy'); }
}
function renderOverview() {
  if (!changed('overview', [state.devices.map(({ lastSeen, ...device }) => device), state.jobs])) return;
  const devices = $('overviewDevices'); if (devices) {
    devices.replaceChildren();
    for (const device of state.devices.slice(0, 3)) {
      const link = text('a', '', 'overview-item overview-row summary-device'); link.href = '#devices';
      const identity = text('div'); identity.append(text('strong', device.name), text('small', `${device.projects.length} 个项目 · ${device.platform || '等待首次连接'}`, 'cell-subtitle'));
      link.append(identity, badge(device.paused ? '已暂停' : device.online ? '在线' : '离线', device.paused ? 'paused' : device.online ? 'online' : 'offline')); devices.append(link);
    }
    if (!state.devices.length) devices.append(empty('开发环境尚未连接', '从添加设备开始，只需几步即可连接你的机器。'));
  }
  const jobs = $('overviewJobs'); if (jobs) {
    jobs.replaceChildren();
    for (const job of state.jobs.slice(0, 3)) {
      const link = text('a', '', 'overview-item overview-row summary-job'); link.href = '#jobs';
      const detail = text('div'); detail.append(text('strong', job.executable), text('small', `${deviceName(job.deviceId)} · ${date(job.started)}`, 'cell-subtitle'));
      link.append(detail, badge(jobLabels[job.state] ?? job.state, jobTone(job))); jobs.append(link);
    }
    if (!state.jobs.length) jobs.append(empty('任务记录会显示在这里', '连接 AI 客户端，开始一次开发任务。'));
  }
}
function renderAudit() {
  if (!state) return;
  const query = $('auditSearch')?.value.trim().toLowerCase() ?? '';
  if (!changed('audit', [state.audit, state.devices.map(device => [device.id, device.name]), query])) return;
  $('audit').replaceChildren(); let count = 0;
  for (const entry of state.audit) {
    if (query && ![entry.tool, entry.principal, entry.status, deviceName(entry.deviceId), entry.projectId].join(' ').toLowerCase().includes(query)) continue;
    count++; const row = document.createElement('tr');
    const at = text('td', date(entry.at)); at.title = fullDate(entry.at);
    const target = document.createElement('td'); target.append(text('span', entry.deviceId ? deviceName(entry.deviceId) : '—')); if (entry.projectId) target.append(text('small', projectName(entry.deviceId, entry.projectId), 'cell-subtitle'));
    const principal = entry.principal === 'admin' ? '管理员' : entry.principal === 'system' ? '系统' : entry.principal === 'anonymous' ? '未登录' : state.tokens.find(token => token.id === entry.principal)?.clientId ?? entry.principal;
    const actor = text('td', principal.length > 28 ? principal.slice(0, 24) + '…' : principal); actor.title = principal;
    const outcome = document.createElement('td'); outcome.append(badge(entry.status === 'ok' ? '成功' : entry.status === 'denied' ? '已拒绝' : entry.status === 'error' ? '失败' : entry.status, entry.status === 'ok' ? 'success' : 'failed'));
    row.append(at, text('td', entry.tool), target, actor, outcome, text('td', `${entry.durationMs} ms`)); $('audit').append(row);
  }
  if (!count) emptyRow($('audit'), 6, query ? '没有找到相关记录' : '暂无操作记录', query ? '试试工具名称、设备名称或调用主体。' : '客户端连接和工具调用将在这里留下记录。', query ? () => { $('auditSearch').value = ''; renderAudit(); } : undefined);
}
function requestConfirmation(title, description, confirmLabel, callback) { return async () => { if (!await ask({ title, description, confirmLabel, danger: true })) return false; return callback(); }; }
function renderSecurity() {
  if (changed('tokens', state.tokens)) {
    $('tokens').replaceChildren();
    for (const token of state.tokens) {
      const row = document.createElement('tr');
      for (const value of [token.clientId, token.kind === 'pat' ? '访问令牌' : 'OAuth', token.scopes.map(scope => ({ read: '读取', write: '写入', execute: '执行', git: 'Git' })[scope] ?? scope).join(' / '), date(token.lastUsed), date(token.expires)]) row.append(text('td', value));
      const controls = document.createElement('td');
      if (token.revoked) controls.append(badge('已撤销', 'offline'));
      else controls.append(action('撤销', requestConfirmation('撤销访问令牌？', `「${token.clientId}」将失去此令牌的访问权限，关联的在途调用和任务会停止。`, '撤销令牌', () => api(`/api/tokens/${token.tokenId}/revoke`, {})), true));
      row.append(controls); $('tokens').append(row);
    }
    if (!state.tokens.length) emptyRow($('tokens'), 6, '暂无访问令牌', '在客户端访问中创建令牌，或通过 OAuth 连接客户端。');
  }
  if (changed('sessions', state.sessions)) {
    $('sessions').replaceChildren();
    for (const session of state.sessions) {
      const row = document.createElement('tr'), agent = session.userAgent || '未知浏览器';
      const browser = agent.includes('Edg/') ? 'Microsoft Edge' : agent.includes('Firefox/') ? 'Firefox' : agent.includes('Chrome/') ? 'Chrome' : agent.includes('Safari/') ? 'Safari' : agent;
      const browserCell = text('td', browser); browserCell.title = agent;
      row.append(browserCell, text('td', date(session.lastSeen)), text('td', date(session.expires)));
      const current = document.createElement('td'); current.append(badge(session.current ? '当前会话' : '其他会话', session.current ? 'online' : 'offline')); row.append(current);
      const controls = document.createElement('td'); controls.append(action('退出会话', requestConfirmation(session.current ? '退出当前登录？' : '撤销此登录会话？', session.current ? '你需要使用管理员密码重新登录。' : '该浏览器将立即失去管理权限，需要重新登录。', '退出会话', async () => { const result = await api(`/api/sessions/${session.id}/revoke`, {}); if (result.current) location.href = '/login'; }), true)); row.append(controls); $('sessions').append(row);
    }
    if (!state.sessions.length) emptyRow($('sessions'), 5, '暂无登录会话', '登录状态将在这里显示。');
  }
  if (changed('oauthClients', state.clients)) {
    $('oauthClients').replaceChildren();
    for (const client of state.clients) {
      const row = document.createElement('tr'); row.append(text('td', client.name), text('td', client.redirects.join(', ')));
      const controls = document.createElement('td'); controls.append(action('撤销', requestConfirmation('撤销 OAuth 客户端？', `「${client.name}」的授权将被撤销，关联任务会停止。再次访问需要重新发起授权。`, '撤销客户端', () => api(`/api/clients/${client.id}/revoke`, {})), true)); row.append(controls); $('oauthClients').append(row);
    }
    if (!state.clients.length) emptyRow($('oauthClients'), 3, '暂无 OAuth 客户端', '在支持 MCP OAuth 的 AI 客户端中添加连接后，即可在这里管理。');
  }
}
function updateTokenTargets() {
  const signature = JSON.stringify(state.devices.map(device => [device.id, device.name, device.online, device.paused, device.projects.map(project => [project.id, project.name])]));
  if (signature !== deviceChoicesSignature) {
    deviceChoicesSignature = signature;
    tokenTargets = createProjectTargets($('tokenDevices'), state.devices, tokenTargets?.value(), () => {
      if (creatingToken) return;
      const selected = tokenTargets?.value() ?? {}, count = Object.values(selected).flat().length;
      setText('tokenStatus', count ? `已选择 ${Object.keys(selected).length} 台设备、${count} 个项目。` : '请至少选择一个项目。'); $('tokenStatus').className = 'muted';
    });
  }
  $('token').querySelector('button[type=submit],button:not([type])').disabled = creatingToken || !state.devices.some(device => device.projects.length);
}
function refresh() {
  if (!refreshInFlight) refreshInFlight = fetchAndRender().catch(error => { setText('connectionStatus', '连接中断'); $('connectionStatus').className = 'system-status error'; throw error; }).finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}
async function fetchAndRender() {
  state = await api('/api/state'); csrf = state.csrf;
  setText('connectionStatus', '已连接'); $('connectionStatus').className = 'system-status';
  permissionEditors.update(state);
  setText('online', state.devices.filter(device => device.online && !device.paused).length); setText('total', state.devices.length); setText('clientCount', state.clientCount); setText('calls', state.audit.length);
  setText('runningCount', state.jobs.filter(active).length); setText('projectCount', state.devices.reduce((count, device) => count + device.projects.length, 0)); setText('authorizationCount', state.authorizations.length);
  setText('endpoint', `${state.publicUrl}/mcp`); setText('updated', `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
  renderDevices(); renderJobs(); renderOverview(); renderAudit(); renderSecurity(); updateTokenTargets();
}
$('deviceSearch')?.addEventListener('input', renderDevices); $('deviceFilter')?.addEventListener('change', renderDevices); $('jobFilter')?.addEventListener('change', renderJobs); $('auditSearch')?.addEventListener('input', renderAudit);
$('refreshDashboard')?.addEventListener('click', async () => {
  const button = $('refreshDashboard'); button.disabled = true; button.setAttribute('aria-busy', 'true');
  try { await refresh(); notify('已更新到最新状态'); } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
});
$('pair').addEventListener('submit', async event => {
  event.preventDefault(); if (pairing) return;
  pairing = true; const submit = event.target.querySelector('button[type=submit],button:not([type])'); submit.disabled = true;
  setText('pairResult', '正在核对配对码…'); $('pairResult').className = 'pending';
  try {
    const code = String(new FormData(event.target).get('code')).trim().toUpperCase(), preview = await api('/api/pair/inspect', { code });
    if (!await ask({ title: '确认设备配对', description: `请核对开发机器显示的名称是否为「${preview.name}」。批准后，该设备即可领取连接凭据。`, confirmLabel: '批准配对' })) { setText('pairResult', '配对已取消。'); $('pairResult').className = 'muted'; return; }
    const value = await api('/api/pair/approve', { code }); setText('pairResult', `已批准「${value.name}」，等待设备完成连接。`); $('pairResult').className = 'success'; event.target.reset(); await refresh(); notify('配对已批准');
  } catch (error) { setText('pairResult', error.message); $('pairResult').className = 'error'; }
  finally { pairing = false; submit.disabled = false; }
});
$('token').addEventListener('submit', async event => {
  event.preventDefault(); if (creatingToken) return;
  const form = new FormData(event.target), projectGrants = tokenTargets?.value() ?? {}, devices = Object.keys(projectGrants);
  if (!devices.length) { setText('tokenStatus', '请至少选择一个项目，再创建令牌。'); $('tokenStatus').className = 'error'; $('tokenDevices').querySelector('input:not(:disabled)')?.focus(); return; }
  creatingToken = true; const submit = event.target.querySelector('button[type=submit],button:not([type])'); submit.disabled = true;
  setText('tokenStatus', '正在创建令牌…'); $('tokenStatus').className = 'pending';
  try {
    const { scopes, unrestrictedExecution, machineAccess } = rolePermissions(form.get('access'));
    const value = await api('/api/tokens', { name: String(form.get('name')).trim(), scopes, devices, projects: null, projectGrants, unrestrictedExecution, machineAccess, expiresDays: Number(form.get('days')) });
    $('newTokenPanel').hidden = false; setText('newToken', value.token); setText('tokenStatus', '令牌已创建，请复制下方令牌。'); $('tokenStatus').className = 'success';
    $('newTokenPanel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
    await refresh().catch(() => notify('令牌已创建，暂时无法刷新状态。请先复制保存令牌。', true));
  } catch (error) { setText('tokenStatus', error.message); $('tokenStatus').className = 'error'; }
  finally { creatingToken = false; submit.disabled = !state?.devices.some(device => device.projects.length); }
});
$('logout').addEventListener('click', async () => { try { await api('/logout', {}); location.href = '/login'; } catch (error) { notify(error.message, true); } });
$('jobOutputNext').addEventListener('click', async () => { const button = $('jobOutputNext'); button.disabled = true; try { await readJobOutput(); } catch (error) { notify(error.message, true); button.disabled = false; } });
$('closeJobOutput').addEventListener('click', () => { selectedJob = undefined; $('jobOutputPanel').hidden = true; });
async function copy(value, message) {
  try { await navigator.clipboard.writeText(value); notify(message); }
  catch { notify('复制未成功，请选中内容手动复制。', true); }
}
$('copyEndpoint').addEventListener('click', () => { if ($('endpoint').textContent) void copy($('endpoint').textContent, 'MCP 地址已复制'); });
$('copyToken').addEventListener('click', () => { if ($('newToken').textContent) void copy($('newToken').textContent, '令牌已复制'); });
$('hideToken').addEventListener('click', () => { setText('newToken', ''); $('newTokenPanel').hidden = true; });
async function poll() {
  try { await refresh(); }
  catch (error) { setText('connectionStatus', '连接中断'); $('connectionStatus').className = 'system-status error'; notify(error.name === 'TimeoutError' ? '连接超时，正在自动重试。' : error.message, true); }
  setTimeout(poll, document.hidden ? 15000 : 5000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh().catch(() => {}); });
$('token').querySelector('button[type=submit],button:not([type])').disabled = true;
void poll();
