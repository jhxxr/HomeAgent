const form = document.getElementById('oauth-consent');
const status = document.getElementById('consent-status');
let submitting = false;
if (form) {
  const summary = document.getElementById('consent-summary');
  const count = name => form.querySelectorAll(`input[name=${name}]:checked`).length;
  const sync = () => {
    if (!summary) return;
    summary.textContent = `已选 ${count('scopes')} 项权限 · ${count('devices')} 台设备 · ${count('projects')} 个项目`;
  };
  form.addEventListener('change', sync);
  sync();
  form.addEventListener('submit', event => {
    if (submitting) { event.preventDefault(); return; }
    const decision = event.submitter?.value;
    if (!['allow', 'deny'].includes(decision)) {
      event.preventDefault();
      status.textContent = '请选择允许或拒绝。';
      return;
    }
    submitting = true;
    // Disabled submit buttons are omitted from native form data.
    const input = document.createElement('input');
    input.type = 'hidden'; input.name = 'decision'; input.value = decision;
    form.append(input);
    for (const button of form.querySelectorAll('button[type=submit]')) button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = decision === 'allow' ? '正在保存授权，请稍候…' : '正在拒绝授权，请稍候…';
  });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
}
const callback = document.getElementById('oauth-callback');
if (callback) window.location.replace(callback.href);
