const form = document.getElementById('oauth-consent');
const status = document.getElementById('consent-status');
let submitting = false;
if (form) {
  const summary = document.getElementById('consent-summary');
  const selected = name => [...form.querySelectorAll(`input[name=${name}]:checked:not(:disabled)`)];
  const sync = () => {
    const devices = new Set(selected('devices').map(input => input.value));
    for (const project of form.querySelectorAll('input[name=projects]')) {
      // Keep the choice when a device is temporarily deselected, but omit it
      // from native form data until that device is selected again.
      project.disabled = !devices.has(project.value.split(':')[0]);
    }
    for (const group of form.querySelectorAll('.consent-device')) {
      const input = group.querySelector('input[name=projects]');
      group.classList.toggle('is-unavailable', !!input?.disabled);
    }
    if (summary) summary.textContent = `已选 ${selected('scopes').length} 项权限 · ${devices.size} 台设备 · ${selected('projects').length} 个项目`;
  };
  form.addEventListener('change', () => {
    sync();
    if (status && !submitting) status.textContent = '';
  });
  sync();
  form.addEventListener('submit', event => {
    if (submitting) { event.preventDefault(); return; }
    const decision = event.submitter?.value;
    if (!['allow', 'deny'].includes(decision)) {
      event.preventDefault();
      status.textContent = '请选择允许或取消。';
      return;
    }
    if (decision === 'allow') {
      const missing = [
        ['scopes', '请至少选择一项工具权限。'],
        ['devices', '请至少选择一台设备。'],
        ['projects', '请至少选择一个项目。'],
      ].find(([name]) => !selected(name).length);
      if (missing) {
        event.preventDefault();
        status.textContent = missing[1];
        form.querySelector(`input[name=${missing[0]}]:not(:disabled)`)?.focus();
        return;
      }
    }
    submitting = true;
    // Disabled submit buttons are omitted from native form data.
    const input = document.createElement('input');
    input.type = 'hidden'; input.name = 'decision'; input.value = decision;
    form.append(input);
    for (const button of form.querySelectorAll('button[type=submit]')) button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = decision === 'allow' ? '正在保存授权，请稍候…' : '正在取消授权，请稍候…';
  });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
}
const callback = document.getElementById('oauth-callback');
if (callback) window.location.replace(callback.href);
