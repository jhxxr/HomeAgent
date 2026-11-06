import { taskStates, taskState, leaseLabel, relativeTime, parseTargetPaths, taskInstruction, mergeTaskPage, taskPermissions, fileComparison, dragTransition } from './kanban-model.js';

const $ = id => document.getElementById(id);
function el(tag, value = '', className = '') { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; }
function button(label, click, className = 'secondary') { const node = el('button', label, className); node.type = 'button'; node.addEventListener('click', click); return node; }
const stamp = at => at ? new Date(at).toLocaleString('zh-CN') : '—';
const statusBadge = status => { const state = taskState(status); return el('span', `${state.symbol} ${state.label}`, `kb-state kb-state-${status}`); };

export function createKanban({ api, notify, ask, copy }) {
  let dragTask, moveAction, eligible = [], moveTicket = 0;
  let visible = false, snapshot, projects = [], projectId = '', columns = {}, mode = 'board', mobile = 'todo';
  let generation = 0, inFlight, current, editing, editDraft = '', reasonAction, busy = false, lastSync = 0, searchTimer;
  let detailGeneration = 0, projectSignature = '', filterSignature = '', renderedSignature = '', lastBoardSignature = '';
  const cards = new Map(), lists = new Map();
  const project = () => projects.find(item => item.id === projectId);
  const deviceName = id => snapshot?.devices.find(device => device.id === id)?.name ?? project()?.devices.find(device => device.id === id)?.name ?? id?.slice(0, 8) ?? '未指定设备';
  const clientName = id => {
    if (!id) return '尚未认领';
    if (id === 'admin') return '管理员';
    const token = snapshot?.tokens?.find(item => item.id === id);
    return snapshot?.clients?.find(client => client.id === token?.clientId)?.name ?? token?.clientId ?? id;
  };
  const query = () => new URLSearchParams({ projectId, query: $('kbSearch').value.trim(), deviceId: $('kbDevice').value, assignee: $('kbAssignee').value });
  const setError = (id, message = '') => { $(id).textContent = message; $(id).hidden = !message; };
  const syncText = () => { $('kbSync').textContent = lastSync ? `同步于 ${new Date(lastSync).toLocaleTimeString('zh-CN')}` : '等待同步'; };
  function chooseOptions(select, choices, placeholder) {
    const selected = select.value;
    select.replaceChildren(new Option(placeholder, ''), ...choices.map(item => new Option(item.name, item.id)));
    if (choices.some(item => item.id === selected)) select.value = selected;
  }
  function filters() {
    const choices = project()?.devices ?? [];
    const owners = new Map((snapshot?.tokens ?? []).map(token => [token.id, { id: token.id, name: clientName(token.id) }]));
    for (const column of Object.values(columns)) for (const task of column.items) if (task.assignee) owners.set(task.assignee, { id: task.assignee, name: clientName(task.assignee) });
    for (const id of [$('kbAssignee').value]) if (id && !owners.has(id)) owners.set(id, { id, name: id });
    const signature = JSON.stringify([choices, [...owners.values()]]);
    if (signature === filterSignature) return;
    filterSignature = signature;
    chooseOptions($('kbDevice'), choices.map(device => ({ id: device.id, name: `${device.name}${device.paused ? ' · 暂停' : device.online ? '' : ' · 离线'}` })), '全部设备');
    chooseOptions($('kbAssignee'), [...owners.values()], '全部客户端');
  }
  function describeProject() {
    const selected = project();
    $('kbCreate').disabled = !selected?.available;
    $('kbEmpty').hidden = !!selected;
    $('kbWorkspace').hidden = !selected;
    $('kbProjectInfo').textContent = selected ? `${selected.name} · ${selected.id} · ${selected.devices.length} 台关联设备${selected.available ? ' · 任务按项目共享' : ' · 项目暂不可用，仅保留历史管理'}` : '任务按项目共享，设备离线时也可查看已有工作。';
  }
  function invalidate() {
    generation++; detailGeneration++; inFlight = undefined; columns = {}; cards.clear(); renderedSignature = ''; lastBoardSignature = ''; filterSignature = ''; lastSync = 0;
    for (const list of lists.values()) list.replaceChildren(el('p', '正在读取任务…', 'kb-column-empty'));
    $('kbRows').replaceChildren(); $('kbListMore').replaceChildren(); $('kbMobileTabs').replaceChildren();
    syncText(); setError('kbError'); describeProject();
  }
  async function refreshProjects(ticket) {
    const data = await api('/api/kanban/projects');
    if (ticket !== generation || !visible) return false;
    projects = data.projects;
    const signature = JSON.stringify(projects);
    if (signature !== projectSignature) {
      projectSignature = signature;
      $('kbProject').replaceChildren(...projects.map(item => new Option(`${item.name} · ${item.id.slice(0, 12)}${item.available ? '' : '（历史）'}`, item.id)));
      if (!projects.length) $('kbProject').append(new Option('暂无项目', ''));
    }
    if (!projects.some(item => item.id === projectId)) { projectId = projects[0]?.id ?? ''; invalidate(); }
    $('kbProject').value = projectId;
    filters(); describeProject(); return true;
  }
  async function refresh() {
    if (!visible || document.hidden || !snapshot || dragTask) return;
    if (inFlight) return inFlight;
    const ticket = generation;
    const work = async () => {
      try {
        if (!await refreshProjects(ticket)) return;
        if (!projectId || !visible) return;
        const selected = projectId, params = query().toString(), requestGeneration = generation;
        const response = await api(`/api/kanban/board?${params}`);
        if (requestGeneration !== generation || selected !== projectId || !visible) return;
        const signature = JSON.stringify(response.columns);
        if (signature !== lastBoardSignature) {
          // Keep explicitly loaded history visible when another card changes during polling.
          for (const state of taskStates) {
            const desired = columns[state.id]?.items.length ?? 0, page = response.columns[state.id];
            while (page.nextCursor && page.items.length < desired) {
              const nextParams = new URLSearchParams(params); nextParams.set('status', state.id); nextParams.set('cursor', page.nextCursor);
              const next = await api(`/api/kanban/tasks?${nextParams}`);
              if (requestGeneration !== generation || selected !== projectId || !visible) return;
              page.items = mergeTaskPage(page.items, next.items); page.nextCursor = next.nextCursor; page.total = next.total;
            }
          }
          columns = response.columns; lastBoardSignature = signature;
          filters(); render();
        } else updateClocks();
        lastSync = Date.now(); syncText(); setError('kbError');
        if (current && $('kbTaskDialog').open && !busy) await refreshDetail(false);
      } catch (error) {
        if (ticket === generation || !lastSync) { setError('kbError', `同步失败：${error.message}。已有内容已保留，可点击刷新重试。`); syncText(); }
      }
    };
    const promise = work().finally(() => { if (inFlight === promise) inFlight = undefined; });
    inFlight = promise; return promise;
  }
  function updateClocks() {
    for (const record of cards.values()) {
      record.updated.textContent = relativeTime(record.task.updatedAt);
      record.lease.textContent = leaseLabel(record.task);
      record.lease.hidden = !record.lease.textContent;
    }
  }
  function makeCard(task) {
    const card = button('', () => { if (!dragTask) void openTask(card.dataset.taskId); }, 'kb-card'); card.dataset.taskId = task.id;
    card.draggable = true; card.title = '拖动到其他状态，或点击查看详情';
    card.addEventListener('dragstart', event => {
      const task = cards.get(card.dataset.taskId)?.task; if (!task || busy) { event.preventDefault(); return; }
      dragTask = task; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id); card.classList.add('kb-dragging');
      for (const state of taskStates) { const action = dragTransition(task.status, state.id); $(`kbColumn-${state.id}`).classList.toggle('kb-drop-allowed', action !== null && action !== 'invalid'); }
    });
    card.addEventListener('dragend', clearDrag);
    const top = el('div', '', 'kb-card-top'), title = el('strong', '', 'kb-card-title'), description = el('p', '', 'kb-card-description');
    const owner = el('p', '', 'kb-card-owner'), files = el('p', '', 'kb-card-files'), lease = el('p', '', 'kb-card-lease');
    const updated = el('span', '', 'kb-card-updated'), foot = el('div', '', 'kb-card-foot'), warning = el('p', '', 'kb-card-warning');
    foot.append(updated, el('span', '查看详情 ↗')); card.append(top, title, description, files, owner, lease, warning, foot);
    return { card, top, title, description, files, owner, lease, updated, warning };
  }
  function render() {
    const signature = JSON.stringify([columns, mode, mobile, snapshot?.devices.map(device => [device.id, device.name, device.online]), snapshot?.authorizations]);
    if (renderedSignature === signature) { updateClocks(); return; } renderedSignature = signature;
    const retained = new Set();
    for (const state of taskStates) {
      const column = columns[state.id] ?? { items: [], total: 0 };
      $(`kbCount-${state.id}`).textContent = String(column.total);
      const list = lists.get(state.id); list.querySelectorAll('.kb-column-empty,.kb-load').forEach(node => node.remove());
      for (const task of column.items) {
        retained.add(task.id);
        let record = cards.get(task.id); if (!record) { record = makeCard(task); cards.set(task.id, record); }
        record.task = task; record.card.setAttribute('aria-label', `${task.id} ${task.title}，${state.label}，查看详情`);
        record.top.replaceChildren(el('span', task.id), el('span', task.requiresReview ? '需要审核' : '直接交付', 'kb-review-label'));
        record.title.textContent = task.title; record.description.textContent = task.description || '暂无补充说明';
      const actualCount = task.actualPathsTotal ?? task.actualPaths.length, targetCount = task.targetPathsTotal ?? task.targetPaths.length;
        record.files.textContent = actualCount ? `已修改 ${actualCount} 个文件` : targetCount ? `预计 ${targetCount} 个文件` : '尚未指定文件范围';
        record.owner.textContent = task.assignee ? `${clientName(task.assignee)} · ${deviceName(task.assigneeDevice)}` : '尚未认领 · 等待客户端接手';
        record.warning.textContent = task.reviewStalePaths?.length ? '△ 审核后文件再次修改' : '';
        record.warning.hidden = !record.warning.textContent;
        record.updated.title = stamp(task.updatedAt);
        // Avoid replacing live buttons on unchanged refreshes; retain keyboard focus.
        const position = column.items.indexOf(task);
        if (list.children[position] !== record.card) list.insertBefore(record.card, list.children[position] ?? null);
      }
      if (!column.items.length) list.append(el('p', column.total ? '暂无可显示任务' : state.id === 'todo' ? '新任务从这里开始。\n点击「新建任务」安排下一项工作。' : '这里还没有任务', 'kb-column-empty'));
      if (column.nextCursor) list.append(button(`加载更多 · 还有 ${Math.max(0, column.total - column.items.length)} 项`, event => void more(state.id, event.currentTarget), 'secondary kb-load'));
    }
    for (const [id, record] of cards) if (!retained.has(id)) { record.card.remove(); cards.delete(id); }
    $('kbMobileTabs').replaceChildren(...taskStates.map(state => {
      const tab = button(`${state.symbol} ${state.label} ${columns[state.id]?.total ?? 0}`, () => { mobile = state.id; setMode(mode); }, 'secondary');
      tab.dataset.status = state.id; return tab;
    }));
    renderList(); updateClocks(); setMode(mode);
  }
  function renderList() {
    const rows = taskStates.flatMap(state => (columns[state.id]?.items ?? []).map(task => {
      const row = document.createElement('tr'), name = document.createElement('td'), status = document.createElement('td');
      name.append(button(task.title, () => void openTask(task.id), 'kb-row-title'), el('small', task.id)); status.append(statusBadge(task.status));
      row.append(name, status, el('td', task.assignee ? `${clientName(task.assignee)} / ${deviceName(task.assigneeDevice)}` : '尚未认领'), el('td', `${task.actualPathsTotal ?? task.actualPaths.length} / ${task.targetPathsTotal ?? task.targetPaths.length} 实际 / 预计`), el('td', stamp(task.updatedAt))); return row;
    }));
    if (!rows.length) { const row = document.createElement('tr'), cell = el('td', '没有符合条件的任务。试试其他筛选，或新建任务。'); cell.colSpan = 5; row.append(cell); rows.push(row); }
    $('kbRows').replaceChildren(...rows);
    $('kbListMore').replaceChildren(...taskStates.filter(state => columns[state.id]?.nextCursor).map(state => button(`加载更多${state.label}`, event => void more(state.id, event.currentTarget))));
  }
  function setMode(next) {
    mode = next; $('kbColumns').hidden = next !== 'board'; $('kbList').hidden = next !== 'list'; $('kbMobileTabs').hidden = next !== 'board';
    $('kbBoardMode').setAttribute('aria-pressed', String(next === 'board')); $('kbListMode').setAttribute('aria-pressed', String(next === 'list'));
    for (const state of taskStates) $(`kbColumn-${state.id}`).classList.toggle('kb-mobile-current', state.id === mobile);
    for (const tab of $('kbMobileTabs').children) tab.setAttribute('aria-pressed', String(tab.dataset.status === mobile));
  }
  async function more(status, source) {
    source.disabled = true; const ticket = generation;
    const params = query(); params.set('status', status); params.set('cursor', columns[status].nextCursor);
    try {
      const response = await api(`/api/kanban/tasks?${params}`);
      if (ticket !== generation) return;
      columns[status] = { ...response, items: mergeTaskPage(columns[status].items, response.items) }; render();
    } catch (error) { notify(error.message, true); } finally { source.disabled = false; }
  }
  function clearDrag() {
    dragTask = undefined;
    document.querySelectorAll('.kb-dragging,.kb-drop-allowed,.kb-drop-over').forEach(node => node.classList.remove('kb-dragging', 'kb-drop-allowed', 'kb-drop-over'));
  }
  for (const state of taskStates) {
    const column = el('section', '', 'kb-column'); column.id = `kbColumn-${state.id}`; column.dataset.status = state.id;
    column.addEventListener('dragover', event => {
      if (!dragTask) return;
      event.preventDefault(); const action = dragTransition(dragTask.status, state.id);
      event.dataTransfer.dropEffect = action === 'invalid' || !action ? 'none' : 'move';
      column.classList.toggle('kb-drop-over', action !== 'invalid' && !!action);
    });
    column.addEventListener('dragleave', event => { if (!column.contains(event.relatedTarget)) column.classList.remove('kb-drop-over'); });
    column.addEventListener('drop', event => {
      event.preventDefault(); const task = dragTask; clearDrag(); if (task) void moveTask(task, state.id);
    });
    const header = el('header', '', 'kb-column-head'), title = el('h3', `${state.symbol} ${state.label}`), count = el('span', '0', 'kb-count'); count.id = `kbCount-${state.id}`;
    title.append(count); header.append(title, el('p', state.hint)); const list = el('div', '', 'kb-card-list'); lists.set(state.id, list); column.append(header, list); $('kbColumns').append(column);
  }
  function showTab(name) {
    for (const tab of document.querySelectorAll('[data-kb-tab]')) { const selected = tab.dataset.kbTab === name; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; $(tab.getAttribute('aria-controls')).hidden = !selected; }
  }
  for (const tab of document.querySelectorAll('[data-kb-tab]')) {
    tab.addEventListener('click', () => showTab(tab.dataset.kbTab));
    tab.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const tabs = [...document.querySelectorAll('[data-kb-tab]')], index = tabs.indexOf(tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3; showTab(tabs[next].dataset.kbTab); tabs[next].focus(); });
  }
  async function openTask(id) {
    const ticket = ++detailGeneration;
    try {
      const data = await api(`/api/kanban/tasks/${encodeURIComponent(id)}?${new URLSearchParams({ projectId })}`);
      if (ticket !== detailGeneration) return;
      current = data.task; reasonAction = undefined; $('kbReasonForm').hidden = true; $('kbComment').value = ''; $('kbConflict').hidden = true; setError('kbTaskError');
      renderDetail(data.warnings); showTab('details'); if (!$('kbTaskDialog').open) $('kbTaskDialog').showModal(); return true;
    } catch (error) { notify(error.message, true); return false; }
  }
  async function refreshDetail(force) {
    if (!current) return;
    const id = current.id, ticket = detailGeneration;
    const data = await api(`/api/kanban/tasks/${encodeURIComponent(id)}?${new URLSearchParams({ projectId: current.projectId })}`);
    if (!current || current.id !== id || ticket !== detailGeneration || busy) return;
    if (!force && data.task.revision !== current.revision && ($('kbComment').value || reasonAction || $('kbEditDialog').open || $('kbMoveDialog').open)) { $('kbConflict').hidden = false; return; }
    if (!force && data.task.revision === current.revision) {
      current.leaseExpiresAt = data.task.leaseExpiresAt;
      const lease = $('kbLeaseDetail'); if (lease && current.status === 'in_progress') lease.textContent = `${stamp(current.leaseExpiresAt)} · ${leaseLabel(current)}`;
      return;
    }
    if (force || JSON.stringify(data.task) !== JSON.stringify(current)) { current = data.task; renderDetail(data.warnings); $('kbConflict').hidden = true; }
  }
  function section(container, heading, value) { const block = el('div', '', 'kb-detail-block'); block.append(el('h3', heading), el('p', value || '未提供', 'kb-prewrap')); container.append(block); }
  function renderDetail(warnings = []) {
    $('kbTaskId').textContent = `${current.id} · ${current.projectId}`; $('kbTaskTitle').textContent = current.title;
    $('kbTaskStatus').replaceChildren(statusBadge(current.status), el('span', current.requiresReview ? '需要人工审核' : '无需审核'), el('span', `更新于 ${stamp(current.updatedAt)}`));
    const details = $('kbDetails'); details.replaceChildren(); section(details, '描述与验收要求', current.description);
    const meta = el('dl', '', 'kb-metadata');
    for (const [label, value] of [['认领客户端', clientName(current.assignee)], ['执行设备', current.assigneeDevice ? deviceName(current.assigneeDevice) : '未指定'], ['租约到期', current.status === 'in_progress' ? `${stamp(current.leaseExpiresAt)} · ${leaseLabel(current)}` : '—'], ['创建者', clientName(current.createdBy)], ['创建时间', stamp(current.createdAt)]]) { const valueNode = el('dd', value); if (label === '租约到期') valueNode.id = 'kbLeaseDetail'; meta.append(el('dt', label), valueNode); }
    details.append(meta); for (const warning of warnings) details.append(el('p', warning, 'kb-alert'));
    const evidence = $('kbEvidence'); evidence.replaceChildren();
    evidence.append(el('p', '以下摘要、哈希和测试信息由客户端上报，不代表 Server 已独立验证。审核通过仅更新任务状态，不会自动提交 Git。', 'kb-evidence-note'));
    if (current.reviewStalePaths?.length) evidence.append(el('p', `△ 提交审核后再次修改：${current.reviewStalePaths.join('、')}。请重新检查或退回修改。`, 'kb-alert'));
    section(evidence, 'AI 工作摘要', current.evidence?.aiSummary); section(evidence, '拟提交信息', current.proposedCommitMessage);
    const comparison = fileComparison(current), files = el('div', '', 'kb-file-list'); files.append(el('h3', '文件范围'));
    for (const file of comparison) { const row = el('div', '', 'kb-file-row'); row.append(el('code', file.path), el('span', file.actual ? file.expected ? '预计 · 已修改' : '范围外新增修改' : '预计 · 尚未记录修改')); files.append(row); }
    if (!comparison.length) files.append(el('p', '尚未上报文件范围。'));
    if ((current.actualPathsTotal ?? 0) > current.actualPaths.length) files.append(el('p', `实际修改共 ${current.actualPathsTotal} 个路径，此处显示前 ${current.actualPaths.length} 个。`, 'muted'));
    evidence.append(files);
    const hashEntries = Object.entries(current.reviewFingerprints ?? {}), hashTotal = current.reviewFingerprintsTotal ?? hashEntries.length;
    const hashes = el('details', '', 'kb-hashes'); hashes.append(el('summary', `客户端上报的文件哈希 (${hashTotal})`));
    if (hashTotal > hashEntries.length) hashes.append(el('p', `此处显示前 ${hashEntries.length} 项，共 ${hashTotal} 项。`));
    for (const [path, hash] of Object.entries(current.reviewFingerprints ?? {})) { const row = el('div', '', 'kb-file-row'); row.append(el('code', path), el('code', hash)); hashes.append(row); } evidence.append(hashes);
    section(evidence, '测试执行证据', current.evidence?.testJobId ? `客户端上报任务 ${current.evidence.testJobId} · ${current.evidence.testPassed === true ? '上报通过，未独立验证' : current.evidence.testPassed === false ? '上报失败' : '未提供结果'}` : '未关联测试执行记录');
    const activity = $('kbActivity'); activity.replaceChildren();
    if (current.messagesTruncated) activity.append(el('p', `显示最近 ${current.messages.length} 条，共 ${current.messagesTotal} 条记录。`, 'muted'));
    const log = el('ol', '', 'kb-activity');
    const events = [{ from: current.createdBy, text: '创建任务', at: current.createdAt }, ...current.messages];
    for (const message of events) { const item = el('li'); item.append(el('strong', message.from === '[system]' ? '系统' : clientName(message.from)), el('time', stamp(message.at)), el('p', message.text, 'kb-prewrap')); log.append(item); } activity.append(log);
    const actions = $('kbTaskActions'); actions.replaceChildren(button('复制任务指令', () => void copy(taskInstruction(current), '任务指令已复制')));
    const allowed = taskPermissions(current, project()?.available);
    if (allowed.edit) actions.append(button('编辑任务', () => openEditor(current)));
    if (allowed.release) actions.append(button('释放认领', () => reason('release'), 'danger'));
    if (allowed.review) actions.append(button('退回修改', () => reason('reject'), 'secondary'), button('通过审核', () => void approve(), 'primary'));
    const move = el('details', '', 'kb-move-menu'); move.append(el('summary', '移动到…'));
    for (const target of taskStates) {
      const transition = dragTransition(current.status, target.id);
      if (transition && transition !== 'invalid') move.append(button(`${target.symbol} ${target.label}`, () => void moveTask(current, target.id)));
    }
    actions.append(move);
  }
  async function moveTask(task, target) {
    if (busy) return;
    const action = dragTransition(task.status, target);
    if (!action) return;
    if (action === 'invalid') { notify('此状态不能直接移动到目标列。请先分配执行，再提交审核。', true); return; }
    if (!current || current.id !== task.id || !$('kbTaskDialog').open) {
      if (!await openTask(task.id)) return;
    }
    if (!current || current.id !== task.id || current.revision !== task.revision) { notify('任务已有新进展，已加载最新内容。请重新选择目标状态。', true); return; }
    if (['release', 'reject', 'reopen', 'revise'].includes(action)) { reason(action); return; }
    if (action === 'approve') { await approve(); return; }
    if (action === 'finish') {
      if (await ask({ title: '跳过审核并完成任务？', description: `「${task.title}」仍在进行中。此操作会跳过审核，标记完成，但不会停止命令或提交 Git。`, confirmLabel: '跳过审核并完成', danger: true })) await mutate('finish', { skipReview: true }, task);
      return;
    }
    await openMove(action);
  }
  async function openMove(action) {
    moveAction = action; const ticket = ++moveTicket;
    setError('kbMoveError'); $('kbMoveSubmit').disabled = action === 'assign';
    $('kbMoveTitle').textContent = action === 'assign' ? '分配任务并开始进行' : '提交审核';
    $('kbMoveDescription').textContent = `${current.id} · ${current.title}`;
    $('kbAssignFields').hidden = action !== 'assign'; $('kbSubmitFields').hidden = action !== 'submit';
    for (const node of $('kbAssignFields').querySelectorAll('select')) node.disabled = action !== 'assign';
    for (const node of $('kbSubmitFields').querySelectorAll('input,textarea')) node.disabled = action !== 'submit';
    $('kbSubmitMessage').value = current.proposedCommitMessage ?? ''; $('kbSubmitSummary').value = current.evidence?.aiSummary ?? '';
    $('kbAssignClient').replaceChildren(new Option('正在读取获授权客户端…', '')); $('kbAssignDevice').replaceChildren();
    $('kbMoveDialog').showModal();
    if (action === 'assign') {
      try {
        const data = await api(`/api/kanban/assignees?${new URLSearchParams({ projectId: current.projectId })}`);
        if (ticket !== moveTicket || !$('kbMoveDialog').open) return;
        eligible = data.assignees;
        $('kbAssignClient').replaceChildren(...eligible.map(item => new Option(item.name, item.id)));
        if (!eligible.length) { $('kbAssignClient').append(new Option('暂无获授权的客户端', '')); setError('kbMoveError', '请先在客户端访问中授予项目写入和任务认领权限。任务尚未移动。'); }
        assignmentDevices();
      } catch (error) { setError('kbMoveError', error.message); }
    }
  }
  function assignmentDevices() {
    const devices = eligible.find(item => item.id === $('kbAssignClient').value)?.devices ?? [];
    $('kbAssignDevice').replaceChildren(...devices.map(device => new Option(device.name, device.id)));
    $('kbMoveSubmit').disabled = !devices.length;
  }
  $('kbAssignClient').addEventListener('change', assignmentDevices);
  function closeMove(event) { event?.preventDefault(); if (busy) return; moveTicket++; $('kbMoveDialog').close(); moveAction = undefined; }
  for (const id of ['kbCloseMove', 'kbCancelMove']) $(id).addEventListener('click', closeMove);
  $('kbMoveDialog').addEventListener('cancel', closeMove);
  $('kbMoveForm').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !moveAction) return;
    $('kbMoveSubmit').disabled = true;
    const extras = moveAction === 'assign' ? { assignee: $('kbAssignClient').value, deviceId: $('kbAssignDevice').value } : { proposedCommitMessage: $('kbSubmitMessage').value.trim(), aiSummary: $('kbSubmitSummary').value.trim() };
    const succeeded = await mutate(moveAction, extras);
    if (succeeded) { moveTicket++; $('kbMoveDialog').close(); moveAction = undefined; }
    else setError('kbMoveError', $('kbTaskError').textContent + ($('kbConflict').hidden ? '' : ' 请关闭此窗口，在详情中加载最新任务后重试。'));
    $('kbMoveSubmit').disabled = false;
  });
  function reason(action) {
    reasonAction = action; $('kbReasonForm').hidden = false; $('kbReason').value = '';
    const labels = { release: '释放认领', reject: '退回待办', reopen: '重新打开', revise: '继续修改' };
    $('kbReasonLabel').textContent = `${labels[action]}的原因`;
    $('kbReasonHelp').textContent = action === 'revise' ? '任务将交回原客户端和设备继续处理。原授权仍需有效，旧审核证据会清除；不会自动执行命令。' : '任务将回到待办并清除认领和旧审核证据。不会停止已运行的命令，也不会撤销已有文件修改。';
    $('kbReasonSubmit').textContent = `确认${labels[action]}`; $('kbReason').focus();
  }
  async function approve() {
    const task = current;
    if (!await ask({ title: '通过此任务的审核？', description: `「${task.title}」将标记为已完成。${task.reviewStalePaths?.length ? '注意：审核后有文件再次修改。' : ''}摘要与哈希由客户端上报；此操作不会提交 Git。`, confirmLabel: '通过审核' })) return;
    await mutate('approve', {}, task);
  }
  function prepareMutation() { generation++; inFlight = undefined; lastBoardSignature = ''; }
  async function mutate(action, extras = {}, task = current) {
    if (busy || !task) return false; busy = true; prepareMutation();
    $('kbTaskDialog').querySelectorAll('button[type=submit],#kbTaskActions button,#kbReasonForm button').forEach(node => { node.disabled = true; });
    setError('kbTaskError');
    try {
      const response = await api(`/api/kanban/tasks/${encodeURIComponent(task.id)}/${action}`, { projectId: task.projectId, expectedRevision: task.revision, ...extras });
      if (current?.id === task.id) { current = response.task; $('kbConflict').hidden = true; renderDetail(); }
      notify('任务已更新'); lastBoardSignature = ''; void refresh(); return true;
    } catch (error) { if (error.code === 'conflict') $('kbConflict').hidden = false; setError('kbTaskError', error.message); return false; }
    finally { busy = false; $('kbTaskDialog').querySelectorAll('button').forEach(node => { node.disabled = false; }); }
  }
  $('kbCommentForm').addEventListener('submit', async event => { event.preventDefault(); const value = $('kbComment').value.trim(); if (value && await mutate('comment', { message: value })) $('kbComment').value = ''; });
  $('kbReasonForm').addEventListener('submit', async event => { event.preventDefault(); const value = $('kbReason').value.trim(); if (value && await mutate(reasonAction, { reason: value })) { reasonAction = undefined; $('kbReasonForm').hidden = true; } });
  $('kbReasonCancel').addEventListener('click', () => { reasonAction = undefined; $('kbReasonForm').hidden = true; });
  $('kbReloadTask').addEventListener('click', () => void refreshDetail(true).catch(error => setError('kbTaskError', error.message)));
  async function closeTask(event) {
    event?.preventDefault(); if (busy) return;
    if (($('kbComment').value || reasonAction && $('kbReason').value) && !await ask({ title: '放弃未发送的内容？', description: '尚未发送的备注或操作原因将不会保存。', confirmLabel: '放弃并关闭' })) return;
    $('kbTaskDialog').close(); current = undefined; detailGeneration++;
  }
  $('kbCloseTask').addEventListener('click', closeTask); $('kbTaskDialog').addEventListener('cancel', closeTask);
  const draft = () => JSON.stringify([$('kbTitle').value, $('kbDescription').value, $('kbPaths').value, $('kbReview').checked]);
  function openEditor(task) {
    editing = task ? { ...task } : { projectId, revision: undefined };
    $('kbEditTitle').textContent = task ? '编辑任务' : '新建任务'; $('kbSave').textContent = task ? '保存修改' : '创建任务';
    $('kbEditProject').textContent = `${project()?.name ?? editing.projectId} · ${editing.projectId}`;
    $('kbTitle').value = task?.title ?? ''; $('kbDescription').value = task?.description ?? ''; $('kbPaths').value = (task?.targetPaths ?? []).join('\n'); $('kbReview').checked = task?.requiresReview ?? true;
    setError('kbEditError'); $('kbEditReload').hidden = true; editDraft = draft(); $('kbEditDialog').showModal(); $('kbTitle').focus();
  }
  async function closeEdit(event) { event?.preventDefault(); if (busy) return; if (draft() !== editDraft && !await ask({ title: '放弃未保存的修改？', description: '当前任务草稿尚未保存。', confirmLabel: '放弃并关闭' })) return; $('kbEditDialog').close(); editing = undefined; }
  $('kbCreate').addEventListener('click', () => openEditor());
  for (const id of ['kbCloseEdit', 'kbCancelEdit']) $(id).addEventListener('click', closeEdit);
  $('kbEditDialog').addEventListener('cancel', closeEdit);
  $('kbEditReload').addEventListener('click', async () => { if (!editing?.id || !await ask({ title: '用最新任务替换当前草稿？', description: '请先复制需要保留的文本；此操作会重置表单。', confirmLabel: '加载最新' })) return; try { const data = await api(`/api/kanban/tasks/${editing.id}?${new URLSearchParams({ projectId: editing.projectId })}`); $('kbEditDialog').close(); openEditor(data.task); } catch (error) { setError('kbEditError', error.message); } });
  $('kbEditForm').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !editing) return;
    let input;
    try { input = { projectId: editing.projectId, title: $('kbTitle').value.trim(), description: $('kbDescription').value, targetPaths: parseTargetPaths($('kbPaths').value), requiresReview: $('kbReview').checked }; if (!input.title) throw new Error('请输入任务标题。'); }
    catch (error) { setError('kbEditError', error.message); return; }
    busy = true; prepareMutation(); $('kbSave').disabled = true; const target = editing;
    try {
      const response = await api(target.id ? `/api/kanban/tasks/${target.id}/edit` : '/api/kanban/tasks', { ...input, ...(target.id ? { expectedRevision: target.revision } : {}) });
      $('kbEditDialog').close(); editing = undefined; notify(target.id ? '任务已保存' : '任务已创建，等待客户端认领');
      if (current?.id === response.task.id) { current = response.task; renderDetail(); }
      lastBoardSignature = ''; void refresh();
    } catch (error) { setError('kbEditError', error.message); $('kbEditReload').hidden = error.code !== 'conflict'; }
    finally { busy = false; $('kbSave').disabled = false; }
  });
  $('kbProject').addEventListener('change', () => { projectId = $('kbProject').value; $('kbDevice').value = ''; $('kbAssignee').value = ''; invalidate(); filters(); void refresh(); });
  for (const id of ['kbDevice', 'kbAssignee']) $(id).addEventListener('change', () => { invalidate(); void refresh(); });
  $('kbSearch').addEventListener('input', () => { clearTimeout(searchTimer); generation++; inFlight = undefined; searchTimer = setTimeout(() => { lastBoardSignature = ''; void refresh(); }, 250); });
  $('kbRefresh').addEventListener('click', () => void refresh());
  $('kbBoardMode').addEventListener('click', () => setMode('board')); $('kbListMode').addEventListener('click', () => setMode('list'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  return {
    setVisible(value) { const changed = visible !== value; visible = value; if (changed && value) void refresh(); if (!value) { generation++; detailGeneration++; inFlight = undefined; } },
    update(value) { snapshot = value; if (visible) { filters(); void refresh(); } },
  };
}
