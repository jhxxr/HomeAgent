const element = (tag, value = '', className = '') => {
  const node = document.createElement(tag); node.textContent = value;
  if (className) node.className = className;
  return node;
};
const field = (caption, name, value, type = 'text') => {
  const label = element('label', caption), input = document.createElement('input');
  input.type = type; input.name = name;
  if (type === 'checkbox') { input.checked = !!value; label.className = 'permission-switch'; }
  else input.value = value ?? '';
  label.append(input); return { label, input };
};
const select = (caption, name, options, value) => {
  const label = element('label', caption), input = document.createElement('select');
  input.name = name;
  for (const [key, text] of options) { const option = element('option', text); option.value = key; input.append(option); }
  input.value = value; label.append(input); return { label, input };
};
const multiline = (caption, name, value) => {
  const label = element('label', caption), input = document.createElement('textarea');
  input.name = name; input.rows = 3; input.value = value; label.append(input); return { label, input };
};
const button = (caption, callback, danger = false) => {
  const node = element('button', caption, danger ? 'danger' : 'secondary'); node.type = 'button';
  node.addEventListener('click', callback); return node;
};
const durationOptions = [['15', '临时 15 分钟，到期恢复原权限'], ['1', '临时 1 分钟'], ['5', '临时 5 分钟'], ['30', '临时 30 分钟'], ['60', '临时 1 小时'], ['240', '临时 4 小时'], ['1440', '临时 24 小时'], ['permanent', '永久保存']];
const date = value => value ? new Date(value).toLocaleString() : '永久';
const defaults = ['.git', '.env', '.ssh', '.aws', '.homeagent'];
export function createPermissionEditors({ api, refresh, notify }) {
  let state, deviceEditing, grantEditing, authorizationSignature;
  const $ = id => document.getElementById(id);
  const deviceForm = $('devicePermissionForm'), grantForm = $('authorizationPermissionForm');
  let projectCards = [], deviceDuration, grantControls;
  function projectCard(project) {
    const container = element('section', '', 'permission-project');
    const title = element('div', '', 'section-title');
    title.append(element('h3', '项目权限'), button('移除此项目', () => { container.remove(); projectCards = projectCards.filter(card => card.container !== container); }, true));
    const grid = element('div', '', 'permission-grid');
    const inputs = {};
    for (const [name, caption] of [['id', '项目 ID'], ['name', '项目名称'], ['root', '默认目录 / 项目根（设备上的绝对路径）']]) {
      const value = field(caption, name, project[name]); value.input.required = true; inputs[name] = value.input; grid.append(value.label);
    }
    inputs.id.pattern = '[a-zA-Z0-9_-]{1,64}';
    const preset = select('快捷设置', 'preset', [['custom', '自定义'], ['readonly', '只读'], ['development', '标准开发'], ['trusted', '完全信任此设备账户']], 'custom');
    const commandMode = select('程序执行范围', 'commandMode', [['allowlist', '仅允许指定程序 / 本机别名'], ['unrestricted', '允许任意程序（含 Shell / 解释器）']], project.commandMode ?? 'allowlist');
    const filesystem = select('文件访问范围', 'filesystemScope', [['project', '仅项目目录'], ['device', '设备范围，可使用目录外绝对路径']], project.filesystemScope ?? 'project');
    inputs.commandMode = commandMode.input; inputs.filesystemScope = filesystem.input;
    grid.append(preset.label, commandMode.label, filesystem.label);
    const commandList = multiline('允许的程序，一行一个（建议绝对路径）', 'commands', (project.commands ?? []).join('\n'));
    const denied = multiline('文件工具排除的名称，一行一个', 'deniedNames', (project.deniedNames ?? defaults).join('\n'));
    inputs.commands = commandList.input; inputs.deniedNames = denied.input;
    const common = field('Linked worktree 公共 Git 目录（可留空）', 'gitCommonDir', project.gitCommonDir ?? '');
    inputs.gitCommonDir = common.input;
    const switches = element('fieldset');
    switches.append(element('legend', '写入与 Git'));
    for (const [name, caption] of [['readOnly', '只读（禁止写入、执行和 Git 修改）'], ['allowGitWrite', '允许 Git 本地修改'], ['allowGitNetwork', '允许 Git fetch / pull，使用本机凭据及 SSH 配置'], ['allowGitPush', '另外允许 Git push']]) {
      const value = field(caption, name, project[name], 'checkbox'); inputs[name] = value.input; switches.append(value.label);
    }
    preset.input.addEventListener('change', () => {
      const mode = preset.input.value;
      if (mode === 'custom') return;
      inputs.readOnly.checked = mode === 'readonly';
      inputs.commandMode.value = mode === 'trusted' ? 'unrestricted' : 'allowlist';
      inputs.filesystemScope.value = mode === 'trusted' ? 'device' : 'project';
      inputs.allowGitWrite.checked = mode !== 'readonly';
      inputs.allowGitNetwork.checked = mode !== 'readonly';
      inputs.allowGitPush.checked = mode === 'trusted';
      inputs.deniedNames.value = mode === 'trusted' ? '' : defaults.join('\n');
    });
    container.append(title, grid, commandList.label, denied.label, common.label, switches);
    const lines = input => input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    return { container, value: () => ({
      id: inputs.id.value.trim(), name: inputs.name.value.trim(), root: inputs.root.value.trim(),
      readOnly: inputs.readOnly.checked, commands: lines(inputs.commands),
      commandMode: inputs.commandMode.value, filesystemScope: inputs.filesystemScope.value,
      allowGitWrite: inputs.allowGitWrite.checked, allowGitNetwork: inputs.allowGitNetwork.checked, allowGitPush: inputs.allowGitPush.checked,
      deniedNames: lines(inputs.deniedNames), ...(inputs.gitCommonDir.value.trim() ? { gitCommonDir: inputs.gitCommonDir.value.trim() } : {}),
    }) };
  }
  function openDevice(id) {
    const device = state.devices.find(device => device.id === id);
    if (!device?.allowRemotePermissions) { notify('此 Runner 未启用 Web 权限管理；升级 Runner，或检查 allowRemotePermissions。', true); return; }
    deviceEditing = { id, revision: device.permissions?.revision ?? 0 };
    const policy = device.permissions;
    const selected = policy?.expiresAt && policy.expiresAt <= Date.now() ? policy.fallbackProjects : policy?.projects;
    const projects = selected ?? device.permissionBaseline ?? [];
    $('devicePermissionTitle').textContent = `设备权限：${device.name}`;
    $('devicePermissionProjects').replaceChildren(); projectCards = [];
    for (const project of projects) { const card = projectCard(project); projectCards.push(card); $('devicePermissionProjects').append(card.container); }
    $('devicePermissionDuration').replaceChildren();
    deviceDuration = select('本次设置有效时间', 'duration', durationOptions, '15');
    $('devicePermissionDuration').append(deviceDuration.label);
    $('devicePermissionPanel').hidden = false; $('devicePermissionPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('addPermissionProject').addEventListener('click', () => {
    const card = projectCard({ id: `project-${projectCards.length + 1}`, name: '新项目', root: '', deniedNames: defaults });
    projectCards.push(card); $('devicePermissionProjects').append(card.container);
  });
  $('closeDevicePermission').addEventListener('click', () => { $('devicePermissionPanel').hidden = true; deviceEditing = undefined; });
  $('restoreLocalPermissions').addEventListener('click', async () => {
    if (!deviceEditing || !confirm('恢复此设备的 Runner 本地配置？正在进行的调用和托管任务将停止。')) return;
    try {
      const result = await api(`/api/devices/${deviceEditing.id}/permissions`, { expectedRevision: deviceEditing.revision, projects: null, durationMinutes: null });
      $('devicePermissionPanel').hidden = true; deviceEditing = undefined; await refresh(); notify(result.message);
    } catch (error) { notify(error.message, true); }
  });
  deviceForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!deviceEditing) return;
    const projects = projectCards.map(card => card.value());
    if (!projects.length) { notify('至少保留一个项目；也可以恢复本地配置。', true); return; }
    if (!confirm('保存设备权限？会取消此设备正在进行的调用并停止托管任务。任意程序可使用运行账户的全部权限，系统权限不会自动提升。')) return;
    const submit = deviceForm.querySelector('button[type=submit]'); submit.disabled = true;
    try {
      const result = await api(`/api/devices/${deviceEditing.id}/permissions`, { expectedRevision: deviceEditing.revision, projects, durationMinutes: deviceDuration.input.value === 'permanent' ? null : Number(deviceDuration.input.value) });
      $('devicePermissionPanel').hidden = true; deviceEditing = undefined; await refresh(); notify(result.message);
    } catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; }
  });
  function openAuthorization(id) {
    const grant = state.authorizations.find(grant => grant.id === id); if (!grant) return;
    grantEditing = { id, revision: grant.revision };
    $('authorizationPermissionTitle').textContent = `客户端权限：${state.clients.find(client => client.id === grant.clientId)?.name ?? grant.clientId}`;
    const form = grantForm; form.replaceChildren();
    const controls = { scopes: [], projects: [], devices: [], tools: [] };
    const scopeField = element('fieldset'); scopeField.append(element('legend', '工具权限类别'));
    for (const scope of ['read', 'write', 'execute', 'git']) {
      const value = field(scope, scope, grant.permissions.scopes.includes(scope), 'checkbox');
      controls.scopes.push([scope, value.input]); scopeField.append(value.label);
    }
    const targets = element('fieldset'); targets.append(element('legend', '设备与项目（不会自动授权后续新增项目）'));
    for (const device of state.devices) {
      const container = element('div', '', 'permission-target');
      const deviceInput = field(device.name, device.id, grant.permissions.devices.includes(device.id), 'checkbox');
      controls.devices.push([device.id, deviceInput.input]); container.append(deviceInput.label);
      for (const project of device.projects) {
        const value = field(`${project.name} (${project.id})`, project.id, grant.permissions.projectGrants[device.id]?.includes(project.id), 'checkbox');
        controls.projects.push([device.id, project.id, value.input]); container.append(value.label);
      }
      targets.append(container);
    }
    const advanced = element('fieldset'); advanced.append(element('legend', '高级权限（同时受设备权限上限控制）'));
    const machine = field('允许文件工具访问项目外的绝对路径', 'machineAccess', grant.permissions.machineAccess, 'checkbox');
    const execution = field('允许使用设备的“任意程序”执行模式', 'unrestrictedExecution', grant.permissions.unrestrictedExecution, 'checkbox');
    controls.machine = machine.input; controls.execution = execution.input; advanced.append(machine.label, execution.label);
    const toolsField = element('fieldset'), toolsList = element('div', '', 'permission-tools');
    toolsField.append(element('legend', '具体工具'));
    const all = field('全部工具（包含以后新增的工具）', 'allTools', grant.permissions.tools === null, 'checkbox');
    controls.allTools = all.input; toolsField.append(all.label);
    for (const tool of state.permissionTools) {
      const value = field(tool.name, tool.name, grant.permissions.tools === null || grant.permissions.tools.includes(tool.name), 'checkbox');
      value.label.title = tool.description; controls.tools.push([tool.name, value.input]); toolsList.append(value.label);
      value.input.addEventListener('change', () => { all.input.checked = false; });
    }
    all.input.addEventListener('change', () => { for (const [, input] of controls.tools) input.checked = all.input.checked; });
    toolsField.append(toolsList);
    const duration = select('本次修改有效时间', 'duration', durationOptions, '15'); controls.duration = duration.input;
    const actions = element('div', '', 'actions'), save = element('button', '保存客户端权限'); save.type = 'submit';
    actions.append(save, button('关闭', () => { $('authorizationPermissionPanel').hidden = true; grantEditing = undefined; }));
    if (grant.temporaryExpiresAt) actions.append(button('立即收回临时权限', async () => {
      try {
        await api(`/api/authorizations/${id}/permissions`, { expectedRevision: grant.revision, restoreTemporary: true });
        $('authorizationPermissionPanel').hidden = true; grantEditing = undefined; await refresh(); notify('已恢复原有永久权限');
      } catch (error) { notify(error.message, true); }
    }, true));
    const trusted = button('勾选完整开发与设备访问', () => {
      for (const [, input] of controls.scopes) input.checked = true;
      controls.machine.checked = true; controls.execution.checked = true; all.input.checked = true;
      for (const [, input] of controls.tools) input.checked = true;
    });
    form.append(scopeField, targets, advanced, trusted, toolsField, duration.label, actions);
    grantControls = controls;
    $('authorizationPermissionPanel').hidden = false; $('authorizationPermissionPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  grantForm.addEventListener('submit', async event => {
    event.preventDefault(); if (!grantEditing) return;
    if (!confirm('更新这个客户端的现有授权？会取消其正在进行的调用，并停止该授权启动的托管任务。到期后恢复原永久权限。')) return;
    const controls = grantControls;
    const devices = controls.devices.filter(([, input]) => input.checked).map(([id]) => id);
    const projects = Object.fromEntries(devices.map(id => [id, controls.projects.filter(([deviceId, , input]) => deviceId === id && input.checked).map(([, projectId]) => projectId)]));
    const submit = grantForm.querySelector('button[type=submit]'); submit.disabled = true;
    try {
      await api(`/api/authorizations/${grantEditing.id}/permissions`, {
        expectedRevision: grantEditing.revision, durationMinutes: controls.duration.value === 'permanent' ? null : Number(controls.duration.value),
        permissions: { scopes: controls.scopes.filter(([, input]) => input.checked).map(([scope]) => scope), devices, projectGrants: projects, tools: controls.allTools.checked ? null : controls.tools.filter(([, input]) => input.checked).map(([name]) => name), machineAccess: controls.machine.checked, unrestrictedExecution: controls.execution.checked },
      });
      $('authorizationPermissionPanel').hidden = true; grantEditing = undefined; await refresh(); notify('现有客户端权限已更新，无需重新复制令牌');
    } catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; }
  });
  function update(next) {
    state = next;
    const signature = JSON.stringify(state.authorizations);
    if (signature === authorizationSignature) return;
    authorizationSignature = signature; $('authorizations').replaceChildren();
    for (const grant of state.authorizations) {
      const row = document.createElement('tr'), client = state.clients.find(client => client.id === grant.clientId)?.name ?? grant.clientId;
      const values = [client, grant.kind, grant.permissions.scopes.join(', ') || '全部禁用', `${grant.permissions.machineAccess ? '目录外文件 ' : ''}${grant.permissions.unrestrictedExecution ? '任意程序 ' : ''}${grant.permissions.tools === null ? '全部工具' : `${grant.permissions.tools.length} 个工具`}`, grant.temporaryExpiresAt ? `临时至 ${date(grant.temporaryExpiresAt)}` : '永久权限'];
      for (const value of values) row.append(element('td', value));
      const cell = document.createElement('td'); cell.append(button('修改现有授权', () => openAuthorization(grant.id))); row.append(cell); $('authorizations').append(row);
    }
    if (!state.authorizations.length) { const row = document.createElement('tr'), cell = element('td', '暂无有效授权；创建令牌或完成一次 OAuth 后可在此修改。'); cell.colSpan = 6; row.append(cell); $('authorizations').append(row); }
  }
  return { update, openDevice, openAuthorization };
}
