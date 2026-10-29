import {
  element, field, select, durationField, durationMinutes, createEditorDialog,
  createProjectTargets, accessRole, rolePermissions, projectAccess, nextProjectId, devicePolicyStatus, gitPermissions, projectTargetsSignature,
} from './ui.js';

const defaults = ['.git', '.env', '.ssh', '.aws', '.homeagent'];
const scopeLabels = { read: '读取文件与状态', write: '修改项目文件', execute: '执行与管理任务', git: 'Git 操作' };
const date = value => new Date(value).toLocaleString();
const button = (caption, callback, danger = false) => {
  const node = element('button', caption, danger ? 'danger' : 'secondary');
  node.type = 'button'; node.addEventListener('click', callback); return node;
};
function multiline(caption, name, value) {
  const label = element('label', caption), input = document.createElement('textarea');
  input.name = name; input.rows = 3; input.value = value; label.append(input);
  return { label, input };
}
function details(title) {
  const node = document.createElement('details'); node.className = 'advanced-settings';
  node.append(element('summary', title)); return node;
}
function jsonObject(control, section) {
  try {
    const value = JSON.parse(control.value || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    control.setCustomValidity(''); return value;
  } catch {
    section.open = true;
    control.setCustomValidity('请输入有效的 JSON 对象。'); control.reportValidity(); control.focus();
    throw new Error('高级配置中的 JSON 格式不正确，输入内容已保留。');
  }
}

export function createPermissionEditors({ api, refresh, notify, ask }) {
  const $ = id => document.getElementById(id);
  const deviceForm = $('devicePermissionForm'), grantForm = $('authorizationPermissionForm');
  let state, deviceEditing, grantEditing, projectCards = [], deviceDuration, grantControls, authorizationSignature;
  const deviceDialog = createEditorDialog($('devicePermissionPanel'), deviceForm, () => { deviceEditing = undefined; });
  const grantDialog = createEditorDialog($('authorizationPermissionPanel'), grantForm, () => { grantEditing = undefined; });

  function showEmptyProjects() {
    if (!projectCards.length) $('devicePermissionProjects').replaceChildren(element('p', '尚未添加项目。点击“添加项目”配置目录与权限。', 'muted'));
  }

  function projectCard(project) {
    const container = element('section', '', 'permission-project');
    const title = element('div', '', 'section-title'), heading = element('h3', project.name || '新项目');
    title.append(heading, button('移除项目', () => {
      container.remove(); projectCards = projectCards.filter(card => card.container !== container); showEmptyProjects(); deviceDialog.changed();
    }, true));
    const grid = element('div', '', 'permission-grid'), inputs = {};
    for (const [name, caption] of [['name', '项目名称'], ['root', '项目目录']]) {
      const control = field(caption, name, project[name]);
      control.input.required = true; control.input.maxLength = name === 'name' ? 128 : 4096;
      if (name === 'root') {
        control.input.spellcheck = false; control.input.autocomplete = 'off';
        control.label.classList.add('project-path-field');
        control.label.append(element('small', '填写被控设备上的绝对路径。', 'field-hint'));
      }
      inputs[name] = control.input; grid.append(control.label);
    }
    inputs.root.placeholder = '例如 E:/Projects/my-app 或 /home/me/projects/my-app';
    inputs.name.addEventListener('input', () => { heading.textContent = inputs.name.value || '新项目'; });
    const mode = select('访问权限', 'access', [['read', '只读查看'], ['full', '完整开发'], ['custom', '高级自定义']], projectAccess(project));
    const git = field('允许 Git 操作（提交、拉取、推送）', 'git', !!project.allowGitWrite && !!project.allowGitNetwork && !!project.allowGitPush, 'checkbox');
    const mixedGit = [project.allowGitWrite, project.allowGitNetwork, project.allowGitPush].some(Boolean) && !git.input.checked;
    git.input.indeterminate = mixedGit;
    let gitChanged = false;
    const description = element('p', '', 'permission-description');
    grid.append(mode.label);
    const advanced = details('高级设置 · 执行规则与保护目录'), advancedGrid = element('div', '', 'permission-grid');
    const id = field('项目 ID（客户端授权使用）', 'id', project.id);
    id.input.required = true; id.input.pattern = '[a-zA-Z0-9_-]{1,64}'; id.input.maxLength = 64; inputs.id = id.input;
    const execution = select('允许执行的程序', 'commandMode', [['allowlist', '仅允许指定程序或别名'], ['unrestricted', '允许全部程序']], project.commandMode ?? 'allowlist');
    execution.label.append(element('small', '允许全部程序后，无需逐个添加 Python、Conda 等解释器路径。当前客户端也需要勾选“允许全部程序”。', 'field-hint'));
    const filesystem = select('文件访问范围', 'filesystemScope', [['project', '项目目录内'], ['device', '允许设备范围的绝对路径']], project.filesystemScope ?? 'project');
    filesystem.label.append(element('small', '全设备范围控制文件路径和命令工作目录；运行任意 Python/Conda 解释器还需开启程序执行规则，并在客户端授权中允许对应能力。', 'field-hint'));
    const commandList = multiline('允许的程序，一行一个', 'commands', (project.commands ?? []).join('\n'));
    const denied = multiline('排除的文件或目录名称，一行一个', 'deniedNames', (project.deniedNames ?? defaults).join('\n'));
    const common = field('Linked worktree 公共 Git 目录（可留空）', 'gitCommonDir', project.gitCommonDir ?? '');
    const aliases = multiline('命令别名（JSON 对象）', 'commandAliases', JSON.stringify(project.commandAliases ?? {}, null, 2));
    const environments = multiline('环境配置（JSON 对象，保存在 Server）', 'environmentProfiles', JSON.stringify(project.environmentProfiles ?? {}, null, 2));
    grid.append(execution.label, filesystem.label);
    advancedGrid.append(id.label);
    advanced.append(advancedGrid, denied.label, common.label, aliases.label, environments.label);
    for (const control of [aliases.input, environments.input]) control.addEventListener('input', () => control.setCustomValidity(''));
    function describe() {
      const readonly = mode.input.value === 'read';
      git.input.disabled = readonly;
      execution.input.disabled = readonly;
      commandList.label.hidden = readonly || execution.input.value === 'unrestricted';
      commandList.input.disabled = commandList.label.hidden;
      description.textContent = readonly ? '可读取项目文件；不能修改文件、运行命令或修改 Git。'
        : execution.input.value === 'unrestricted' ? '设备允许全部程序；当前客户端授权也须允许执行。程序使用 Runner 账户的系统权限。Git 由下面一个开关统一控制。'
          : '仅允许下方列出的程序或高级设置中的命令别名。选择“允许全部程序”即可免去逐个配置。';
    }
    mode.input.addEventListener('change', () => {
      if (mode.input.value === 'read') { git.input.checked = false; git.input.indeterminate = false; gitChanged = true; }
      else if (mode.input.value === 'full') { execution.input.value = 'unrestricted'; filesystem.input.value = 'project'; }
      else advanced.open = true;
      describe();
    });
    for (const control of [execution.input, filesystem.input, commandList.input]) control.addEventListener('change', () => { mode.input.value = 'custom'; describe(); });
    git.input.addEventListener('change', () => { gitChanged = true; git.input.indeterminate = false; });
    describe();
    container.append(title, grid, description, commandList.label, git.label, advanced);
    const lines = input => input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    return {
      container, id: () => inputs.id.value,
      value() {
        const root = inputs.root.value.trim();
        if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(root)) {
          inputs.root.setCustomValidity('请输入被控端上的绝对目录路径。'); inputs.root.reportValidity(); inputs.root.focus();
          throw new Error('请检查项目目录，使用被控端上的绝对路径。');
        }
        inputs.root.setCustomValidity('');
        const readonly = mode.input.value === 'read';
        const gitFlags = !gitChanged && mixedGit && !readonly
          ? { allowGitWrite: !!project.allowGitWrite, allowGitNetwork: !!project.allowGitNetwork, allowGitPush: !!project.allowGitPush }
          : gitPermissions(!readonly && git.input.checked);
        return {
          id: inputs.id.value.trim(), name: inputs.name.value.trim(), root, readOnly: readonly,
          commands: lines(commandList.input), commandMode: mode.input.value === 'full' ? 'unrestricted' : execution.input.value,
          filesystemScope: filesystem.input.value, ...gitFlags, deniedNames: lines(denied.input),
          commandAliases: jsonObject(aliases.input, advanced), environmentProfiles: jsonObject(environments.input, advanced),
          ...(common.input.value.trim() ? { gitCommonDir: common.input.value.trim() } : {}),
        };
      },
    };
  }

  function renderDevice(id) {
    const device = state.devices.find(device => device.id === id);
    if (!device) return;
    const policy = device.permissions;
    const projects = (policy?.expiresAt && policy.expiresAt <= Date.now() ? policy.fallbackProjects : policy?.projects) ?? [];
    deviceEditing = { id, revision: policy?.revision ?? 0, stale: false };
    $('devicePermissionTitle').textContent = `设备设置 · ${device.name}`;
    $('devicePermissionProjects').replaceChildren(); projectCards = [];
    for (const project of projects) {
      const card = projectCard(project); projectCards.push(card); $('devicePermissionProjects').append(card.container);
    }
    showEmptyProjects();
    deviceDuration = durationField(policy?.expiresAt);
    $('devicePermissionDuration').replaceChildren(deviceDuration.label);
    deviceDialog.open();
    deviceDialog.status(device.online ? '选择项目目录和访问权限，保存后会停止该设备当前的托管任务。' : '设备离线。可以保存到 Server，设备上线后自动应用。');
  }
  function openDevice(id) { if (deviceEditing) deviceDialog.guard(() => renderDevice(id)); else renderDevice(id); }
  $('addPermissionProject').addEventListener('click', () => {
    const card = projectCard({ id: nextProjectId(projectCards.map(card => card.id())), name: '新项目', root: '', readOnly: true, deniedNames: defaults });
    if (!projectCards.length) $('devicePermissionProjects').replaceChildren();
    projectCards.push(card); $('devicePermissionProjects').append(card.container); deviceDialog.changed();
    card.container.querySelector('input[name=root]').focus();
  });
  deviceDialog.reload.addEventListener('click', () => deviceEditing && deviceDialog.guard(() => renderDevice(deviceEditing.id)));
  async function saveDevice(clear = false) {
    if (!deviceEditing || deviceEditing.saving || deviceEditing.stale) return;
    if (!clear && !deviceDialog.dirty()) return;
    if (clear && !await ask({ title: '清空设备项目？', description: '将收回此设备的全部项目访问，并停止设备上的托管任务。项目文件会保留。', confirmLabel: '清空全部项目', danger: true })) return;
    const editing = deviceEditing;
    try {
      const projects = clear ? [] : projectCards.map(card => card.value());
      if (new Set(projects.map(project => project.id)).size !== projects.length) throw new Error('项目 ID 重复，请在高级设置中修改。');
      editing.saving = true; deviceDialog.busy(true); deviceDialog.status('正在保存到 Server…', 'pending');
      const result = await api(`/api/devices/${editing.id}/permissions`, { expectedRevision: editing.revision, projects, durationMinutes: clear ? null : durationMinutes(deviceDuration.input) });
      editing.revision = result.revision; editing.saved = true;
      if (clear) {
        projectCards = []; showEmptyProjects(); deviceDuration.input.value = 'permanent'; deviceDuration.input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      deviceDialog.markSaved(); deviceDialog.status('Server 已保存，等待 Runner 应用…', 'pending');
      await refresh().catch(() => deviceDialog.status('Server 已保存，暂时无法刷新应用状态。可稍后重新检查。', 'pending'));
    } catch (error) {
      deviceDialog.status(error.message, 'error');
      if (error.code === 'revision_conflict') { editing.stale = true; deviceDialog.stale(true); deviceDialog.reload.hidden = false; }
    } finally {
      editing.saving = false; deviceDialog.busy(false);
      if (editing.stale) deviceDialog.save.disabled = true;
      if (state) update(state);
    }
  }
  deviceForm.addEventListener('input', event => { if (event.target.name === 'root') event.target.setCustomValidity(''); });
  deviceForm.addEventListener('submit', event => { event.preventDefault(); void saveDevice(); });
  $('clearDeviceProjects').addEventListener('click', () => void saveDevice(true));

  function renderAuthorization(id) {
    const grant = state.authorizations.find(grant => grant.id === id);
    if (!grant) return;
    grantEditing = { id, revision: grant.revision, stale: false, targetsSignature: projectTargetsSignature(state.devices) };
    $('authorizationPermissionTitle').textContent = `客户端权限 · ${state.clients.find(client => client.id === grant.clientId)?.name ?? grant.clientId}`;
    grantForm.replaceChildren();
    const role = select('访问权限', 'access', [['read', '只读查看'], ['full', '完整开发'], ['custom', '高级自定义']], accessRole(grant.permissions));
    const roleDescription = element('p', '', 'permission-description permission-role-description');
    const describeRole = () => { roleDescription.textContent = role.input.value === 'read'
      ? '可读取所选项目文件和任务状态，不能修改文件或启动程序。'
      : role.input.value === 'full' ? '可读写文件、执行程序和使用 Git；项目外工作目录还需勾选下方的设备范围绝对路径。实际能力仍受设备的项目设置限制。'
        : '使用下方的权限类别和工具清单，配置客户端可以执行的操作。'; };
    describeRole();
    const targets = element('div', '', 'project-targets'), targetLegend = element('p', '选择访问范围。勾选设备会选中这里列出的全部项目；暂不可用项目保留原授权，但不能访问。后续新增项目需要单独授权。', 'permission-description');
    const advanced = details('高级权限与具体工具'), scopeField = element('fieldset'), toolsField = element('fieldset');
    const controls = { scopes: [], tools: [], role, targets: createProjectTargets(targets, state.devices, grant.permissions.projectGrants, () => {}, true) };
    scopeField.append(element('legend', '权限类别'));
    for (const scope of ['read', 'write', 'execute', 'git']) {
      const control = field(scopeLabels[scope], scope, grant.permissions.scopes.includes(scope), 'checkbox');
      controls.scopes.push([scope, control.input]); scopeField.append(control.label);
    }
    const machine = field('允许使用设备范围的绝对路径', 'machineAccess', grant.permissions.machineAccess, 'checkbox');
    const execution = field('允许全部程序', 'unrestrictedExecution', grant.permissions.unrestrictedExecution, 'checkbox');
    execution.label.append(element('small', '设备项目也选择“允许全部程序”时生效；无需逐个填写解释器路径。勾选时同时开启执行任务权限。', 'field-hint'));
    machine.label.append(element('small', '允许项目目录外的文件路径和命令工作目录；设备项目也需设置为全设备范围。', 'field-hint'));
    controls.machine = machine.input; controls.execution = execution.input;
    toolsField.append(element('legend', '具体工具'));
    const all = field('允许全部工具（仍受项目权限限制）', 'allTools', grant.permissions.tools === null, 'checkbox');
    controls.allTools = all.input; toolsField.append(all.label);
    const toolList = element('div', '', 'permission-tools');
    for (const tool of state.permissionTools) {
      const control = field(tool.name, tool.name, grant.permissions.tools === null || grant.permissions.tools.includes(tool.name), 'checkbox');
      control.label.title = tool.description; controls.tools.push([tool.name, control.input]); toolList.append(control.label);
      control.input.addEventListener('change', () => { all.input.checked = false; });
    }
    all.input.addEventListener('change', () => { for (const [, input] of controls.tools) input.checked = all.input.checked; });
    toolsField.append(toolList); advanced.append(scopeField, toolsField);
    for (const input of [machine.input, execution.input]) input.addEventListener('change', () => {
      if (input === execution.input && input.checked) controls.scopes.find(([scope]) => scope === 'execute')[1].checked = true;
      role.input.value = 'custom'; describeRole();
    });
    advanced.addEventListener('change', () => { role.input.value = 'custom'; describeRole(); });
    role.input.addEventListener('change', () => {
      describeRole();
      if (role.input.value === 'custom') { advanced.open = true; return; }
      const selected = rolePermissions(role.input.value);
      for (const [scope, input] of controls.scopes) input.checked = selected.scopes.includes(scope);
      machine.input.checked = selected.machineAccess; execution.input.checked = selected.unrestrictedExecution;
      all.input.checked = true; for (const [, input] of controls.tools) input.checked = true;
    });
    controls.duration = durationField(grant.temporaryExpiresAt).input;
    const durationLabel = controls.duration.parentElement;
    grantForm.append(role.label, roleDescription, execution.label, machine.label, targetLegend, targets, durationLabel, advanced);
    grantControls = controls;
    $('cancelTemporaryAuthorization').hidden = !grant.temporaryExpiresAt;
    grantDialog.open();
    grantDialog.status('完整开发可读写文件、运行程序和使用 Git，实际能力仍受所选项目设置限制。保存会停止此授权的托管任务。');
  }
  function openAuthorization(id) { if (grantEditing) grantDialog.guard(() => renderAuthorization(id)); else renderAuthorization(id); }
  grantDialog.reload.addEventListener('click', () => grantEditing && grantDialog.guard(() => renderAuthorization(grantEditing.id)));
  async function saveAuthorization(restoreTemporary = false) {
    if (!grantEditing || grantEditing.saving || grantEditing.stale) return;
    if (!restoreTemporary && !grantDialog.dirty()) return;
    const editing = grantEditing;
    try {
      const projectGrants = grantControls.targets.value(), devices = Object.keys(projectGrants);
      if (!restoreTemporary && !devices.length) throw new Error('请至少选择一个项目；如需关闭访问，请撤销此授权。');
      const permissions = {
        scopes: grantControls.scopes.filter(([, input]) => input.checked).map(([scope]) => scope), devices, projectGrants,
        tools: grantControls.allTools.checked ? null : grantControls.tools.filter(([, input]) => input.checked).map(([name]) => name),
        machineAccess: grantControls.machine.checked, unrestrictedExecution: grantControls.execution.checked,
      };
      editing.saving = true; grantDialog.busy(true); grantDialog.status('正在保存权限…', 'pending');
      const result = await api(`/api/authorizations/${editing.id}/permissions`, {
        expectedRevision: editing.revision, ...(restoreTemporary ? { restoreTemporary: true } : { permissions, durationMinutes: durationMinutes(grantControls.duration) }),
      });
      editing.revision = result.revision; grantDialog.markSaved();
      grantDialog.status('权限已保存，无需重新复制令牌。', 'success');
      await refresh().catch(() => grantDialog.status('权限已保存，暂时无法刷新页面状态。', 'pending'));
      if (restoreTemporary) renderAuthorization(editing.id);
    } catch (error) {
      grantDialog.status(error.message, 'error');
      if (error.code === 'revision_conflict') { editing.stale = true; grantDialog.stale(true); grantDialog.reload.hidden = false; }
    } finally {
      editing.saving = false; grantDialog.busy(false);
      if (editing.stale) grantDialog.save.disabled = true;
      if (state) update(state);
    }
  }
  grantForm.addEventListener('submit', event => { event.preventDefault(); void saveAuthorization(); });
  $('cancelTemporaryAuthorization').addEventListener('click', () => grantDialog.guard(() => void saveAuthorization(true)));

  function update(next) {
    state = next;
    for (const [editing, dialog, current, revision] of [
      [deviceEditing, deviceDialog, state.devices.find(device => device.id === deviceEditing?.id), current => current.permissions?.revision ?? 0],
      [grantEditing, grantDialog, state.authorizations.find(grant => grant.id === grantEditing?.id), current => current.revision],
    ]) {
      if (!editing) continue;
      if (editing.saving) continue;
      const targetsChanged = editing === grantEditing && projectTargetsSignature(state.devices) !== editing.targetsSignature;
      if (!current || revision(current) !== editing.revision || targetsChanged) {
        editing.stale = true; dialog.stale(true); dialog.reload.hidden = !current;
        dialog.status(current ? targetsChanged ? '设备项目或应用状态已变化。你的输入已保留，请重新加载后再编辑。' : 'Server 配置已被其他操作修改。你的输入已保留，请重新加载后再编辑。' : '此设备或授权已撤销，请关闭弹窗。', 'error');
      } else if (editing === deviceEditing && editing.saved && !dialog.dirty()) {
        const status = devicePolicyStatus(current, editing.revision); dialog.status(status.text, status.tone);
      }
    }
    const signature = JSON.stringify([state.authorizations, state.clients]);
    if (signature === authorizationSignature) return;
    authorizationSignature = signature; $('authorizations').replaceChildren();
    for (const grant of state.authorizations) {
      const row = document.createElement('tr'), role = accessRole(grant.permissions);
      const values = [state.clients.find(client => client.id === grant.clientId)?.name ?? grant.clientId, grant.kind === 'pat' ? '令牌' : 'OAuth',
        role === 'read' ? '只读查看' : role === 'full' ? '完整开发' : '高级自定义',
        `${Object.keys(grant.permissions.projectGrants).length} 台设备 · ${Object.values(grant.permissions.projectGrants).flat().length} 个项目`,
        grant.temporaryExpiresAt ? `临时至 ${date(grant.temporaryExpiresAt)}` : '永久设置'];
      for (const value of values) row.append(element('td', value));
      const cell = document.createElement('td'), edit = button('修改权限', () => openAuthorization(grant.id));
      edit.id = `edit-authorization-${grant.id}`; cell.append(edit); row.append(cell); $('authorizations').append(row);
    }
    if (!state.authorizations.length) {
      const row = document.createElement('tr'), cell = element('td', '暂无授权。创建客户端令牌或完成 OAuth 连接后可在此管理。');
      cell.colSpan = 6; row.append(cell); $('authorizations').append(row);
    }
  }
  return { update, openDevice, openAuthorization };
}
