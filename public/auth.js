const loginForm = document.getElementById('loginForm');
const password = document.getElementById('adminPassword');
const toggle = document.querySelector('.password-toggle');
if (password && toggle) {
  toggle.addEventListener('click', () => {
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    toggle.textContent = visible ? '隐藏' : '显示';
    toggle.setAttribute('aria-pressed', String(visible));
    password.focus();
  });
}
if (loginForm) {
  const error = document.getElementById('loginError');
  const submit = loginForm.querySelector('button[type=submit]');
  let submitting = false;
  const busy = value => {
    submitting = value;
    if (value) loginForm.setAttribute('aria-busy', 'true');
    else loginForm.removeAttribute('aria-busy');
    submit.disabled = value;
    submit.textContent = value ? '正在登录…' : '登录';
  };
  const clearError = () => {
    error.hidden = true;
    error.textContent = '';
    password.removeAttribute('aria-invalid');
    password.setAttribute('aria-describedby', 'passwordHelp');
  };
  password.addEventListener('input', clearError);
  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    clearError();
    const body = new URLSearchParams(new FormData(loginForm));
    busy(true);
    try {
      const response = await fetch(loginForm.action, {
        method: 'POST', body, credentials: 'same-origin', mode: 'same-origin',
        signal: AbortSignal.timeout(15000),
      });
      // A redirect confirms that /login accepted the password. The target may
      // itself be a missing or expired OAuth page; show that page as requested.
      if (response.redirected) {
        const destination = new URL(response.url);
        if (destination.origin !== location.origin) throw new Error('invalid_destination');
        location.assign(destination.href);
        return;
      }
      const message = response.status === 401 ? '管理员密码不正确，请重新输入。'
        : response.status === 429 ? '尝试次数过多，请稍后再试。'
        : response.status === 403 ? '登录请求已失效，请刷新页面后重试。'
        : response.status >= 500 ? '服务暂时不可用，请稍后重试。'
        : '暂时无法登录，请检查密码后重试。';
      error.textContent = message;
      if (response.status === 401) {
        password.setAttribute('aria-invalid', 'true');
        password.focus();
        password.select();
      }
    } catch (failure) {
      error.textContent = failure.name === 'TimeoutError' || failure.name === 'AbortError'
        ? '连接超时，请检查网络后重试。'
        : failure.message === 'invalid_destination'
          ? '登录后跳转地址无效，请重新打开控制台。'
          : '无法连接到服务，请检查网络后重试。';
    }
    error.hidden = false;
    password.setAttribute('aria-describedby', 'passwordHelp loginError');
    busy(false);
  });
  window.addEventListener('pageshow', () => busy(false));
}
