import { summarizeConsole, auditTimeline, jobLabel } from './console-model.js';

const svgNS = 'http://www.w3.org/2000/svg';
const views = new Set(['overview', 'devices', 'jobs', 'access', 'activity', 'settings']);
const hashViews = { 'devices-section': 'devices', 'jobs-section': 'jobs', 'access-section': 'access', 'audit-section': 'activity', audit: 'activity' };
const time = value => new Date(value).toLocaleTimeString([], { hour12: false });
const number = value => new Intl.NumberFormat().format(value);
const duration = value => value === null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
function node(tag, value = '', className = '') {
  const el = document.createElement(tag);
  if (value !== '') el.textContent = value;
  if (className) el.className = className;
  return el;
}
function svg(tag, attributes) {
  const el = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  return el;
}

/** Presentation only: all operational actions still use the dashboard's existing APIs. */
export function createConsole({ onDevice, onAuthorization, onJob, onRefresh, onError, onViewChange = () => {} }) {
  const $ = id => document.getElementById(id);
  let snapshot, summary, lastSync = 0, syncOK = false, currentView = 'overview';
  const signatures = new Map();
  const tickMarks = [];
  for (const tab of document.querySelectorAll('.console-nav [data-console-view]')) {
    tab.id = `console-tab-${tab.dataset.consoleView}`; tab.setAttribute('role', 'tab');
  }
  for (const panel of document.querySelectorAll('[data-console-panel]')) {
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `console-tab-${panel.dataset.consolePanel}`);
    panel.tabIndex = 0;
  }
  const ring = $('consoleRing');
  for (let i = 0; i < 64; i++) {
    const angle = (i / 64) * Math.PI * 2;
    const mark = svg('line', {
      x1: 120 + Math.sin(angle) * 101, y1: 120 - Math.cos(angle) * 101,
      x2: 120 + Math.sin(angle) * 110, y2: 120 - Math.cos(angle) * 110,
      class: `console-ring-tick tone-${i % 4}`, 'stroke-linecap': 'round',
    });
    tickMarks.push(mark); ring.append(mark);
  }

  function showView(view, updateHash = true) {
    if (!views.has(view)) return;
    const activePanel = document.activeElement?.closest('[data-console-panel]');
    currentView = view;
    document.body.dataset.consoleView = view;
    for (const panel of document.querySelectorAll('[data-console-panel]')) panel.hidden = panel.dataset.consolePanel !== view;
    for (const button of document.querySelectorAll('.console-nav [data-console-view]')) {
      const selected = button.dataset.consoleView === view;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-selected', String(selected));
      button.removeAttribute('aria-current');
      button.tabIndex = selected ? 0 : -1;
    }
    if (activePanel && activePanel.dataset.consolePanel !== view) document.getElementById(`console-view-${view}`).focus();
    if (updateHash && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    onViewChange(view);
  }
  function readHash() {
    const hash = location.hash.slice(1);
    const requested = hash.replace('console-view-', '');
    const next = hashViews[requested] ?? (views.has(requested) ? requested : 'overview');
    showView(next, location.hash !== `#${next}`);
  }
  for (const button of document.querySelectorAll('[data-console-view]')) button.addEventListener('click', () => showView(button.dataset.consoleView));
  document.querySelector('.console-nav').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...document.querySelectorAll('.console-nav [data-console-view]')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    showView(buttons[next].dataset.consoleView); buttons[next].focus();
  });
  window.addEventListener('hashchange', readHash);
  showView('overview', false); readHash();

  $('consoleRefresh').addEventListener('click', async () => {
    const button = $('consoleRefresh'); button.disabled = true;
    try { await onRefresh(); }
    catch (error) { setSync(false); onError(error.message, true); }
    finally { button.disabled = false; }
  });
  function fullscreenLabel() {
    const active = !!document.fullscreenElement;
    $('consoleFullscreen').textContent = active ? '退出全屏' : '全屏展示';
    $('consoleFullscreen').setAttribute('aria-pressed', String(active));
    $('consoleFullscreen').setAttribute('aria-label', active ? '退出全屏' : '进入全屏');
  }
  if (!document.fullscreenEnabled) $('consoleFullscreen').hidden = true;
  $('consoleFullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      fullscreenLabel();
    } catch { onError('浏览器未允许全屏，可以使用浏览器的全屏功能。', true); }
  });
  document.addEventListener('fullscreenchange', fullscreenLabel);

  function renderIfChanged(key, value, render) {
    const signature = JSON.stringify(value);
    if (signatures.get(key) === signature) return;
    const focusKey = document.activeElement?.dataset.consoleKey;
    signatures.set(key, signature); render();
    if (focusKey) [...document.querySelectorAll('[data-console-key]')].find(item => item.dataset.consoleKey === focusKey)?.focus();
  }
  function empty(target, message, label, callback) {
    const content = node('div', '', 'console-empty');
    content.append(node('span', '○', 'console-empty-symbol'), node('p', message));
    if (callback) {
      const button = node('button', label, 'console-text-button');
      button.type = 'button'; button.addEventListener('click', callback); content.append(button);
    }
    target.replaceChildren(content);
  }
  function networkNode({ id, name, meta, count, index, kind, active, label, onClick }) {
    const item = node('button', '', `console-node tone-${index % 4} ${kind}${active ? ' is-active' : ''}`);
    item.type = 'button'; item.title = `${name} · ${meta}`;
    item.dataset.consoleKey = id;
    item.setAttribute('aria-label', label);
    const icon = node('span', '', 'console-node-icon'); icon.setAttribute('aria-hidden', 'true');
    const glyph = svg('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    glyph.append(svg('path', { d: kind === 'is-client' ? 'M8 5 2 12l6 7m8-14 6 7-6 7M14 3l-4 18' : 'M4 3h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm8 13v5m-4 0h8' }));
    icon.append(glyph);
    const copy = node('span', '', 'console-node-copy');
    copy.append(node('span', name, 'console-node-name'), node('span', meta, 'console-node-meta'));
    item.append(icon, copy, node('span', number(count), 'console-node-count'));
    item.addEventListener('click', onClick); return item;
  }
  function renderClients() {
    const target = $('consoleClients'); target.replaceChildren();
    if (!summary.clients.length) return empty(target, '还没有客户端授权', '连接 AI 客户端 ↗', () => showView('access'));
    summary.clients.slice(0, 4).forEach((client, index) => {
      target.append(networkNode({ id: `client:${client.id}`, name: client.name, meta: `${client.kind === 'pat' ? 'Token' : client.kind === 'mixed' ? 'OAuth / Token' : 'OAuth'} · ${client.projectCount} 个授权项目`,
        count: client.grantIds.length, index, kind: 'is-client', active: false,
        label: `${client.name}，${client.grantIds.length} 项授权，查看客户端权限`,
        onClick: () => onAuthorization(client.grantIds[0]),
      }));
    });
    if (summary.clients.length > 4) {
      const more = node('button', `还有 ${summary.clients.length - 4} 个客户端 · 查看全部 ↗`, 'console-overflow');
      more.type = 'button'; more.addEventListener('click', () => showView('access')); target.append(more);
    }
  }
  function renderRunners() {
    const target = $('consoleRunners'); target.replaceChildren();
    if (!summary.runners.length) return empty(target, '等待第一台 Runner', '添加设备 ↗', () => showView('devices'));
    summary.runners.slice(0, 4).forEach((runner, index) => {
      const status = runner.paused ? '已暂停' : runner.online ? '在线' : '离线';
      const version = runner.runnerVersion ? ` · v${runner.runnerVersion}` : '';
      target.append(networkNode({ id: `device:${runner.id}`, name: runner.name, meta: `${status} · ${runner.projects.length} 个项目${version}`, count: runner.recentCount,
        index, kind: runner.paused ? 'is-paused' : runner.online ? 'is-online' : 'is-offline',
        active: runner.online && !runner.paused && runner.recentCount > 0,
        label: `${runner.name}，${status}，打开设备设置`, onClick: () => onDevice(runner.id),
      }));
    });
    if (summary.runners.length > 4) {
      const more = node('button', `还有 ${summary.runners.length - 4} 台设备 · 查看全部 ↗`, 'console-overflow');
      more.type = 'button'; more.addEventListener('click', () => showView('devices')); target.append(more);
    }
  }
  function miniRow(title, meta, tone = 'muted', callback) {
    const row = node(callback ? 'button' : 'div', '', 'console-mini-row');
    if (callback) { row.type = 'button'; row.addEventListener('click', callback); }
    const dot = node('span', '', `console-state-dot tone-${tone}`); dot.setAttribute('aria-hidden', 'true');
    const copy = node('span', '', 'console-mini-copy');
    copy.append(node('span', title, 'console-mini-title'), node('span', meta, 'console-mini-meta'));
    row.append(dot, copy); return row;
  }
  function renderJobs() {
    const target = $('consoleJobs'); target.replaceChildren();
    const jobs = summary.activeJobs;
    if (!jobs.length && !summary.unconfirmedJobs.length) return empty(target, '当前没有执行中的任务', '查看任务记录 ↗', () => showView('jobs'));
    for (const job of jobs.slice(0, 2)) {
      const device = snapshot.devices.find(item => item.id === job.deviceId);
      target.append(miniRow(job.executable, `${jobLabel(job.state)} · ${device?.name ?? job.deviceId.slice(0, 8)} / ${job.projectId}`, 'success', () => {
        showView('jobs'); Promise.resolve(onJob(job)).catch(error => onError(error.message, true));
      }));
    }
    if (summary.unconfirmedJobs.length) target.append(miniRow(`${summary.unconfirmedJobs.length} 个任务状态待确认`, 'Runner 离线或未报告，保留上次记录', 'pending', () => showView('jobs')));
    else if (jobs.length > 2) target.append(miniRow(`另有 ${jobs.length - 2} 个任务执行中`, '查看全部任务', 'muted', () => showView('jobs')));
  }
  function renderPolicy() {
    const target = $('consolePolicy'); target.replaceChildren();
    if (!summary.policyAlerts.length) return empty(target, '当前无权限配置提醒', '管理客户端权限 ↗', () => showView('access'));
    for (const alert of summary.policyAlerts.slice(0, 2)) target.append(miniRow(alert.title, alert.detail, alert.tone, () => {
      if (alert.deviceId) onDevice(alert.deviceId);
      else if (alert.authorizationId) onAuthorization(alert.authorizationId);
      else showView('access');
    }));
    if (summary.policyAlerts.length > 2) target.append(node('p', `另有 ${summary.policyAlerts.length - 2} 项提醒 · 在设备与权限中查看`, 'console-mini-meta'));
  }
  function renderOutcomes() {
    const target = $('consoleOutcomes'); target.replaceChildren();
    if (!summary.outcomes.total) return empty(target, '等待第一条审计记录');
    const counts = node('div', '', 'console-outcome-counts');
    const ok = node('span', '', 'tone-success'), other = node('span', '', 'tone-error');
    ok.append(node('strong', number(summary.outcomes.ok)), node('span', '成功'));
    other.append(node('strong', number(summary.outcomes.other)), node('span', '未成功'));
    counts.append(ok, other); target.append(counts);
    const dots = node('div', '', 'console-outcome-dots'); dots.setAttribute('aria-hidden', 'true');
    for (const event of snapshot.audit.slice(0, 32).reverse()) dots.append(node('span', '', `console-state-dot tone-${event.status === 'ok' ? 'success' : 'error'}`));
    target.append(dots, node('p', '按最近审计样本统计，含管理操作', 'console-mini-meta'));
  }
  function renderTimeline() {
    const chart = $('consoleTimeline'); chart.replaceChildren();
    const data = auditTimeline(snapshot.audit);
    const width = chart.clientWidth || 600, height = chart.clientHeight || 110;
    const left = 24, right = width - 12, top = 12, bottom = height - 23;
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const max = Math.max(1, ...data.buckets.map(bucket => bucket.total));
    for (const y of [top, (top + bottom) / 2, bottom]) chart.append(svg('line', { x1: left, x2: right, y1: y, y2: y, class: 'console-chart-grid' }));
    for (const [y, value] of [[top + 3, max], [bottom + 3, 0]]) {
      const label = svg('text', { x: 16, y, class: 'console-chart-label', 'text-anchor': 'end' });
      label.textContent = value; chart.append(label);
    }
    if (data.total) {
      const points = key => data.buckets.map((bucket, i) => `${left + (i / (data.buckets.length - 1)) * (right - left)},${bottom - (bucket[key] / max) * (bottom - top)}`).join(' ');
      chart.append(svg('polygon', { points: `${left},${bottom} ${points('total')} ${right},${bottom}`, class: 'console-chart-area' }));
      chart.append(svg('polyline', { points: points('total'), class: 'console-chart-total', fill: 'none' }));
      if (data.other) chart.append(svg('polyline', { points: points('other'), class: 'console-chart-errors', fill: 'none' }));
    }
    for (const [x, value, anchor] of [[left, data.start, 'start'], [(left + right) / 2, (data.start + data.end) / 2, 'middle'], [right, data.end, 'end']]) {
      const label = svg('text', { x, y: height - 4, class: 'console-chart-label', 'text-anchor': anchor });
      label.textContent = new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); chart.append(label);
    }
    chart.setAttribute('aria-label', `最近60分钟的返回样本中有 ${data.total} 条审计记录，其中 ${data.other} 条未成功。每3分钟一组，样本最多100条。`);
    $('consoleTimelineEmpty').hidden = data.total > 0;
  }
  function renderFeed() {
    const target = $('consoleFeed'); target.replaceChildren();
    if (!snapshot.audit.length) return empty(target, '暂无操作记录，连接设备或客户端后会在这里显示。');
    for (const event of snapshot.audit.slice(0, 6)) {
      const row = node('div', '', 'console-feed-row');
      const at = node('time', time(event.at)); at.dateTime = new Date(event.at).toISOString();
      const device = snapshot.devices.find(item => item.id === event.deviceId);
      const context = event.deviceId ? `${device?.name ?? event.deviceId.slice(0, 8)}${event.projectId ? ` / ${event.projectId}` : ''}` : event.principal;
      const status = event.status === 'ok' ? '成功' : event.status === 'denied' ? '已拒绝' : '未成功';
      const state = node('span', status, `console-event-status tone-${event.status === 'ok' ? 'success' : 'error'}`); state.title = event.status;
      const tool = node('span', event.tool, 'console-event-tool'); tool.title = event.tool;
      const detail = node('span', context, 'console-event-context'); detail.title = context;
      row.append(at, state, tool, detail, node('span', duration(event.durationMs), 'console-event-duration'));
      target.append(row);
    }
  }
  function tick() {
    const now = Date.now();
    $('consoleClock').textContent = new Date(now).toLocaleString([], { hour12: false });
    const fresh = syncOK && lastSync && now - lastSync < 20000;
    const events = fresh ? summary?.recentEvents.filter(event => event.at >= now - 15000 && event.at <= now) ?? [] : [];
    const calls = events.filter(event => event.deviceId && !/^(admin|device|authorization|oauth_client|token)\./.test(event.tool));
    const linked = calls.some(event => snapshot?.devices.some(device => device.id === event.deviceId && device.online && !device.paused));
    $('consoleHub').classList.toggle('is-active', linked);
    document.querySelector('.console-hub-scene').classList.toggle('is-active', linked);
    document.querySelector('.console-network-panel').classList.toggle('is-active', linked);
    tickMarks.forEach((mark, index) => mark.classList.toggle('is-lit', index < Math.min(64, events.length)));
    $('consoleActivity').textContent = !lastSync ? '等待连接 Server' : !fresh ? '状态待同步 · 显示上次记录' : events.length ? `近 15 秒 · ${events.length} 条审计记录` : '连接就绪 · 等待调用';
    $('consoleSync').textContent = !lastSync ? '正在连接' : fresh ? `已同步 ${time(lastSync)} · 5 秒刷新` : `上次同步 ${time(lastSync)}`;
    $('consoleSync').classList.toggle('tone-error', !fresh && !!lastSync);
    // A failed poll must never leave a Runner or packet looking live.
    for (const item of $('consoleRunners').children) {
      const id = item.dataset.deviceId;
      if (!id) continue;
      const runner = snapshot?.devices.find(device => device.id === id);
      const active = !!runner?.online && !runner.paused && calls.some(event => event.deviceId === id);
      item.classList.toggle('is-active', active);
      const count = item.querySelector('.console-node-count');
      if (count) count.textContent = number(events.filter(event => event.deviceId === id).length);
    }
    const paths = [...document.querySelectorAll('.console-connection')];
    const grid = document.querySelector('.console-network-grid');
    const bounds = grid.getBoundingClientRect?.();
    const hubBounds = $('consoleHub').getBoundingClientRect?.();
    paths.forEach((path, index) => {
      const item = index < 4 ? summary?.clients[index] : summary?.runners[index - 4];
      path.setAttribute('visibility', item ? 'visible' : 'hidden');
      const active = !!item && (index < 4
        ? calls.some(event => snapshot.tokens.some(token => !token.revoked && token.expires > now && token.clientId === item.id && token.id === event.principal))
        : item.online && !item.paused && calls.some(event => event.deviceId === item.id));
      path.classList.toggle('is-active', !!active);
      const target = (index < 4 ? $('consoleClients') : $('consoleRunners')).querySelectorAll('.console-node')[index % 4];
      if (bounds?.width && bounds.height && hubBounds && target) {
        const targetBounds = target.getBoundingClientRect();
        const hubX = (hubBounds.left + hubBounds.width / 2 - bounds.left) / bounds.width * 1000;
        const hubY = (hubBounds.top + hubBounds.height / 2 - bounds.top) / bounds.height * 320;
        const targetX = ((index < 4 ? targetBounds.right : targetBounds.left) - bounds.left) / bounds.width * 1000;
        const targetY = (targetBounds.top + targetBounds.height / 2 - bounds.top) / bounds.height * 320;
        path.setAttribute('d', index < 4
          ? `M${targetX} ${targetY}C${targetX + 80} ${targetY} ${hubX - 80} ${hubY} ${hubX} ${hubY}`
          : `M${hubX} ${hubY}C${hubX + 80} ${hubY} ${targetX - 80} ${targetY} ${targetX} ${targetY}`);
      }
    });
    if (!fresh && lastSync) {
      $('connectionStatus').textContent = '同步中断 · 显示上次状态';
      $('connectionStatus').className = 'system-status error';
    }
  }
  function setSync(ok) { syncOK = ok; tick(); }
  function update(state) {
    snapshot = state; lastSync = Date.now(); syncOK = true;
    summary = summarizeConsole(state, lastSync);
    renderIfChanged('clients', summary.clients.map(({ lastUsed, ...client }) => client), renderClients);
    renderIfChanged('runners', summary.runners.map(runner => [runner.id, runner.name, runner.online, runner.paused, runner.runnerVersion, runner.projects.map(project => project.id)]), () => {
      renderRunners();
      [...$('consoleRunners').querySelectorAll('.console-node')].forEach((item, index) => { item.dataset.deviceId = summary.runners[index].id; });
    });
    renderIfChanged('jobs', [summary.activeJobs, summary.unconfirmedJobs, state.devices.map(item => [item.id, item.name])], renderJobs);
    renderIfChanged('policy', summary.policyAlerts, renderPolicy);
    renderIfChanged('outcomes', state.audit, renderOutcomes);
    renderIfChanged('feed', [state.audit, state.devices.map(item => [item.id, item.name])], renderFeed);
    renderTimeline();
    $('consoleLatency').textContent = duration(summary.medianDuration);
    $('consoleSample').textContent = `${number(state.audit.length)} / 100 条样本`;
    if ($('consoleOnlineSummary')) $('consoleOnlineSummary').textContent = `${state.devices.filter(item => item.online && !item.paused).length} 台可用 · ${summary.projects} 个项目`;
    if ($('consoleJobCount')) $('consoleJobCount').textContent = number(summary.activeJobs.length);
    if ($('consolePolicyCount')) $('consolePolicyCount').textContent = number(summary.policyAlerts.length);
    if ($('consoleOutcomeCount')) $('consoleOutcomeCount').textContent = number(summary.outcomes.total);
    if ($('runningCount')) $('runningCount').textContent = number(summary.activeJobs.length);
    tick();
  }
  tick();
  setInterval(tick, 1000);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
    if (snapshot && $('consoleTimeline').clientWidth) renderTimeline();
  }).observe($('consoleTimeline'));
  return { update, setSync, showView, get view() { return currentView; } };
}
