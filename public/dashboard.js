let csrf = '', state, deviceChoicesSignature = '', selectedJob;
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
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status === 401) { location.href = '/login'; throw new Error('需要重新登录'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? data.error ?? '请求失败');
  return data;
}
function action(label, callback, danger = false) {
  const button = text('button', label, danger ? 'danger' : 'secondary');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await callback(); await refresh(); notify('操作已完成'); } catch (error) { notify(error.message, true); }
    finally { button.disabled = false; }
  });
  return button;
}
async function readJobOutput(job, reset = false) {
  if (reset) {
    selectedJob = { deviceId: job.deviceId, id: job.id, cursor: job.totalOutputBytes === undefined ? 0 : undefined, view: job.totalOutputBytes === undefined ? 'prefix' : 'tail' };
    $('jobOutput').textContent = '';
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
async function refresh() {
  state = await api('/api/state'); csrf = state.csrf;
  $('online').textContent = state.devices.filter(device => device.online).length;
  $('total').textContent = state.devices.length;
  $('clientCount').textContent = state.clientCount;
  $('calls').textContent = state.audit.length;
  $('endpoint').textContent = `${state.publicUrl}/mcp`;
  $('updated').textContent = `更新于 ${new Date().toLocaleTimeString()}`;
  if (changed('devices', state.devices.map(({ lastSeen, ...device }) => device))) {
  $('devices').replaceChildren();
  if (!state.devices.length) $('devices').append(text('p', '暂无设备。先运行 Runner 配对命令。', 'muted'));
  for (const device of state.devices) {
    const card = text('article', '', 'device');
    const title = text('div', '', 'section-title');
    title.append(text('h3', device.name), text('span', device.paused ? '已暂停' : device.online ? '在线' : '离线', device.online && !device.paused ? 'badge online' : 'badge'));
    card.append(title, text('code', device.id), text('p', device.platform ? `${device.platform} · Runner ${device.runnerVersion ?? '未知'} · 实例 ${(device.runnerInstanceId ?? '未知').slice(0, 8)}` : '等待 Runner 首次连接', 'muted'));
    for (const project of device.projects) {
      card.append(text('p', `${project.name} · ${project.id} · ${project.readOnly ? '只读' : '可写'} · 直接命令 ${project.commands.length} 个 · 别名 ${project.commandAliasNames?.length ?? 0} 个 · Git 提交${project.allowGitWrite ? '已启用' : '未启用'}`));
      if (project.commandAliasNames?.length) card.append(text('p', `允许的命令别名：${project.commandAliasNames.join(', ')}`, 'muted'));
      if (project.environmentNames?.length) card.append(text('p', `本机环境配置：${project.environmentNames.join(', ')}`, 'muted'));
    }
    const buttons = text('div', '', 'actions');
    buttons.append(action(device.paused ? '恢复' : '暂停', () => api(`/api/devices/${device.id}/${device.paused ? 'resume' : 'pause'}`, {})));
    buttons.append(action('重命名', async () => { const name = prompt('设备名称', device.name); if (name?.trim()) await api(`/api/devices/${device.id}/rename`, { name: name.trim() }); }));
    buttons.append(action('撤销设备', async () => { if (confirm(`撤销 ${device.name}？连接将关闭，运行中的托管进程会停止，重新使用需要配对。`)) await api(`/api/devices/${device.id}/revoke`, {}); }, true));
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
      controls.append(action('读取输出', () => readJobOutput(job, true)));
      if (['starting', 'running'].includes(job.state)) controls.append(action('停止', () => api(`/api/jobs/${job.deviceId}/${job.id}/stop`, {}), true));
    } else controls.append(text('span', 'Runner 不可访问', 'muted'));
    }
  }
  if (!state.jobs.length && !$('jobs').querySelector('[data-empty]')) { const row = document.createElement('tr'); row.dataset.empty = 'true'; const cell = text('td', '暂无任务。启动命令后在此观察状态。'); cell.colSpan = 6; row.append(cell); $('jobs').append(row); }
  // Preserve form selections across background refresh.
  const signature = JSON.stringify(state.devices.map(device => [device.id, device.name]));
  if (signature !== deviceChoicesSignature) {
    deviceChoicesSignature = signature;
    const checked = new Set([...$('tokenDevices').querySelectorAll('input:checked')].map(input => input.value));
    $('tokenDevices').replaceChildren();
    for (const device of state.devices) {
      const label = text('label', ''), input = document.createElement('input');
      input.type = 'checkbox'; input.name = 'devices'; input.value = device.id; input.checked = checked.has(device.id);
      label.append(input, document.createTextNode(device.name)); $('tokenDevices').append(label);
    }
  }
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
  try {
    const code = new FormData(event.target).get('code'), preview = await api('/api/pair/inspect', { code });
    if (!confirm(`确认配对设备“${preview.name}”？请与 Runner 输出的名称核对。`)) return;
    const value = await api('/api/pair/approve', { code }); $('pairResult').textContent = `已批准 ${value.name}，等待 Runner 领取凭据。`; event.target.reset(); await refresh();
  }
  catch (error) { notify(error.message, true); }
});
$('token').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target), projects = String(form.get('projects')).split(',').map(value => value.trim()).filter(Boolean);
  try {
    const value = await api('/api/tokens', { name: form.get('name'), scopes: form.getAll('scopes'), devices: form.getAll('devices'), projects: projects.length ? projects : null, expiresDays: Number(form.get('days')) });
    $('newToken').hidden = false; $('newToken').textContent = value.token; $('tokenHint').hidden = false;
    await refresh(); notify('令牌已创建');
  } catch (error) { notify(error.message, true); }
});
$('logout').addEventListener('click', async () => { try { await api('/logout', {}); location.href = '/login'; } catch (error) { notify(error.message, true); } });
$('jobOutputNext').addEventListener('click', async () => { try { await readJobOutput(); } catch (error) { notify(error.message, true); } });
try { await refresh(); } catch (error) { notify(error.message, true); }
setInterval(() => { void refresh().catch(error => notify(error.message, true)); }, 5000);
