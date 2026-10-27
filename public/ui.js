export const element = (tag, text = '', className = '') => {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
};
export const fullScopes = ['read', 'write', 'execute', 'git'];
export function accessRole(permissions) {
  const scopes = [...permissions.scopes].sort().join(',');
  if (permissions.tools !== null || permissions.machineAccess) return 'custom';
  if (scopes === 'read' && !permissions.unrestrictedExecution) return 'read';
  if (scopes === [...fullScopes].sort().join(',') && permissions.unrestrictedExecution) return 'full';
  return 'custom';
}
export function rolePermissions(role) {
  return { scopes: role === 'full' ? [...fullScopes] : ['read'], tools: null, machineAccess: false, unrestrictedExecution: role === 'full' };
}
export function initialDuration(expires, now = Date.now()) {
  return expires && expires > now ? String(Math.max(1, Math.ceil((expires - now) / 60000))) : 'permanent';
}
export function nextProjectId(ids) {
  let n = 1;
  while (ids.includes(`project-${n}`)) n++;
  return `project-${n}`;
}
export function projectAccess(project) {
  if (project.readOnly) return 'read';
  return project.commandMode === 'unrestricted' && project.filesystemScope === 'project' ? 'full' : 'custom';
}
export function gitPermissions(enabled) {
  return { allowGitWrite: enabled, allowGitNetwork: enabled, allowGitPush: enabled };
}
export function devicePolicyStatus(device, revision) {
  if (!device) return { tone: 'error', text: '设备已撤销。请关闭弹窗。' };
  if (device.permissionError) return { tone: 'error', text: `Server 已保存，Runner 应用失败：${device.permissionError}。请修正配置后再次保存。` };
  if (!device.online || device.paused) return { tone: 'pending', text: '已保存到 Server，设备上线并恢复运行后自动应用。' };
  if (device.permissionAppliedRevision !== revision) return { tone: 'pending', text: '已保存到 Server，正在等待 Runner 应用…' };
  return { tone: 'success', text: '设置已保存，Runner 已应用。' };
}
export function field(caption, name, value, type = 'text') {
  const label = element('label', caption), input = document.createElement('input');
  input.type = type; input.name = name;
  if (type === 'checkbox') { input.checked = !!value; label.className = 'permission-switch'; }
  else input.value = value ?? '';
  label.append(input);
  return { label, input };
}
export function select(caption, name, options, value) {
  const label = element('label', caption), input = document.createElement('select');
  input.name = name;
  for (const [key, text] of options) { const option = element('option', text); option.value = key; input.append(option); }
  input.value = value; label.append(input);
  return { label, input };
}
export function durationField(expires) {
  const current = initialDuration(expires);
  const options = [['permanent', '永久保存'], ['15', '临时 15 分钟'], ['60', '临时 1 小时'], ['240', '临时 4 小时'], ['1440', '临时 24 小时']];
  if (!options.some(([value]) => value === current)) options.splice(1, 0, [current, `临时 ${current} 分钟（当前剩余时间）`]);
  return select('有效时间', 'duration', options, current);
}
export const durationMinutes = input => input.value === 'permanent' ? null : Number(input.value);

/** Native dialogs provide focus trapping, inert background and accessible Escape. */
export function createEditorDialog(panel, form, onClose) {
  const status = panel.querySelector('[data-editor-status]'), dirtyLabel = panel.querySelector('[data-editor-dirty]');
  const discard = panel.querySelector('[data-editor-discard]'), reload = panel.querySelector('[data-editor-reload]');
  const save = panel.querySelector('[data-editor-save]');
  let baseline = '', busy = false, stale = false, pendingDiscard, opener, disabled = [];
  const signature = () => JSON.stringify([...form.querySelectorAll('input,select,textarea')].map(input => [input.name, input.type === 'checkbox' ? input.checked : input.value]));
  const dirty = () => signature() !== baseline;
  function changed() {
    const unsaved = dirty(); dirtyLabel.hidden = !unsaved; save.disabled = busy || stale || !unsaved;
    if (unsaved && !busy && (status.classList.contains('success') || status.classList.contains('pending'))) {
      status.textContent = '有未保存的修改。'; status.className = 'editor-status';
    }
  }
  function guard(action) {
    if (busy) return;
    if (!dirty()) return action();
    pendingDiscard = action; discard.hidden = false;
    discard.querySelector('[data-keep-editing]').focus();
  }
  function close() { guard(() => panel.close()); }
  for (const button of panel.querySelectorAll('[data-editor-close]')) button.addEventListener('click', close);
  panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
  panel.addEventListener('click', event => {
    const rect = panel.getBoundingClientRect();
    if (event.target === panel && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) close();
  });
  discard.querySelector('[data-keep-editing]').addEventListener('click', () => { discard.hidden = true; pendingDiscard = undefined; });
  discard.querySelector('[data-discard-changes]').addEventListener('click', () => {
    const action = pendingDiscard; pendingDiscard = undefined; discard.hidden = true; action?.();
  });
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
  panel.addEventListener('close', () => {
    discard.hidden = true; pendingDiscard = undefined; onClose();
    const target = opener?.id ? document.getElementById(opener.id) : opener;
    if (target?.isConnected) target.focus();
  });
  return {
    save, reload, dirty, guard, changed,
    open() {
      if (!panel.open) { opener = document.activeElement; panel.showModal(); }
      baseline = signature(); stale = false; changed(); discard.hidden = true;
      status.textContent = ''; status.className = 'editor-status'; reload.hidden = true;
      form.querySelector('input:not([type=checkbox]),select,textarea')?.focus();
    },
    markSaved() { baseline = signature(); changed(); discard.hidden = true; },
    stale(value) { stale = value; changed(); },
    status(text, tone = '') { status.textContent = text; status.className = `editor-status ${tone}`; },
    busy(value) {
      busy = value; panel.setAttribute('aria-busy', String(value));
      if (value) {
        disabled = [...panel.querySelectorAll('button,input,select,textarea')].map(node => [node, node.disabled]);
        for (const [node] of disabled) node.disabled = true;
      } else { for (const [node, wasDisabled] of disabled) node.disabled = wasDisabled; changed(); }
    },
  };
}

/** A device checkbox selects a snapshot of its current projects, never future projects. */
export function createProjectTargets(container, devices, selection = {}, onChange = () => {}) {
  const controls = [];
  container.replaceChildren();
  if (!devices.length) container.append(element('p', '请先添加设备并配置项目目录。', 'muted'));
  for (const device of devices) {
    const group = element('fieldset', '', 'project-target');
    const parent = field(device.name, 'target-device', false, 'checkbox');
    parent.input.value = device.id;
    group.append(parent.label);
    const projects = [];
    for (const project of device.projects) {
      const item = field(`${project.name} · ${project.id}`, 'target-project', !!selection[device.id]?.includes(project.id), 'checkbox');
      item.input.value = `${device.id}:${project.id}`;
      projects.push([project.id, item.input]); group.append(item.label);
    }
    if (!projects.length) { group.append(element('p', '暂无已应用项目，请先配置设备并等待 Runner 应用。', 'muted')); parent.input.disabled = true; }
    function sync() {
      const count = projects.filter(([, input]) => input.checked).length;
      parent.input.checked = count > 0;
      parent.input.indeterminate = count > 0 && count < projects.length;
    }
    parent.input.addEventListener('change', () => {
      for (const [, input] of projects) input.checked = parent.input.checked;
      sync(); onChange();
    });
    for (const [, input] of projects) input.addEventListener('change', () => { sync(); onChange(); });
    sync(); controls.push([device.id, projects]); container.append(group);
  }
  return {
    value() {
      return Object.fromEntries(controls.map(([id, projects]) => [id, projects.filter(([, input]) => input.checked).map(([id]) => id)]).filter(([, projects]) => projects.length));
    },
  };
}
