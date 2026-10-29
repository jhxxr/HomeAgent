export function assistConnectCommand(link) {
  const url = new URL(link);
  if (!/^https?:\/\/[a-z0-9.\-\[\]:]+\/assist#id=[a-f0-9-]{36}&token=[a-zA-Z0-9_-]{32,128}$/.test(url.href)) throw new Error('邀请链接格式无效，无法生成连接命令');
  return `homeagent assist "${url.href}"`;
}

export function createAssistControls({ api, refresh, notify, ask, copy }) {
  const $ = id => document.getElementById(id);
  const labels = { pending: '等待本机激活', active: '协助中', ended: '已结束', confirmed: '托管任务已停止', failed: '停止失败，访问已封锁', unconfirmed: '停止未确认' };
  const cell = text => { const node = document.createElement('td'); node.textContent = text; return node; };
  const button = (label, run) => {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'secondary'; node.textContent = label;
    node.addEventListener('click', async () => { node.disabled = true; try { await run(); await refresh(); } catch (error) { notify(error.message, true); } finally { node.disabled = false; } }); return node;
  };
  $('assistInviteForm')?.addEventListener('submit', async event => {
    event.preventDefault(); const submit = event.target.querySelector('button[type="submit"]'); submit.disabled = true;
    const form = new FormData(event.target), scopes = ['read']; if (form.has('write')) scopes.push('write'); if (form.has('execute')) scopes.push('execute');
    try {
      if (scopes.includes('execute') && !await ask({ title: '允许邀请请求程序执行？', description: '朋友仍需本机批准程序。解释器/构建工具拥有 Runner 账户权限，项目路径限制不是沙箱。', confirmLabel: '继续创建', danger: true })) return;
      const created = await api('/api/assist/invites', { authorizationId: form.get('authorizationId'), operatorName: String(form.get('operatorName')).trim(), maxDurationMinutes: Number(form.get('maxDurationMinutes')), scopes });
      const command = assistConnectCommand(created.link);
      $('assistCommand').textContent = command; $('assistLink').textContent = created.link; $('assistLinkPanel').hidden = false; await refresh(); notify('邀请已生成，可复制连接命令私下分享');
    } catch (error) { notify(error.message, true); } finally { submit.disabled = false; }
  });
  $('copyAssistCommand')?.addEventListener('click', () => copy($('assistCommand').textContent, '连接命令已复制'));
  $('copyAssistLink')?.addEventListener('click', () => copy($('assistLink').textContent, '邀请链接已复制'));
  $('hideAssistLink')?.addEventListener('click', () => { $('assistCommand').textContent = ''; $('assistLink').textContent = ''; $('assistLinkPanel').hidden = true; });
  return {
    update(state) {
      if (!$('assistAuthorization')) return;
      const selected = $('assistAuthorization').value;
      $('assistAuthorization').replaceChildren();
      for (const authorization of state.authorizations.filter(item => item.permissions.scopes.includes('read') && (!item.permissions.tools || item.permissions.tools.includes('list_devices')))) {
        const option = document.createElement('option'); option.value = authorization.id; option.textContent = `${authorization.clientId} · ${authorization.kind}`; $('assistAuthorization').append(option);
      }
      if ([...$('assistAuthorization').options].some(option => option.value === selected)) $('assistAuthorization').value = selected;
      $('assistInviteForm').querySelector('button[type="submit"]').disabled = !$('assistAuthorization').options.length;
      $('assistSessions').replaceChildren();
      for (const session of state.assistSessions ?? []) {
        const row = document.createElement('tr'), controls = cell('');
        if (session.state !== 'ended') controls.append(button('结束协助', async () => { if (await ask({ title: '结束远程协助？', description: '先阻止新操作，再等待 Runner 清理任务。已经发生的修改不会回滚。', confirmLabel: '结束', danger: true })) await api(`/api/assist/sessions/${session.sessionId}/end`, {}); }));
        const projects = session.approval.projects ?? [{ id: 'assist', name: 'Remote Assist', scopes: session.approval.scopes }];
        const summary = `${projects.length} 个项目 · ${projects.map(project => `${project.name}（${project.id}）：${project.scopes.join('/')}`).join('；')}`;
        row.append(cell(`${session.operatorId} · ${summary}`), cell(`${labels[session.state]} · ${labels[session.cleanup] ?? '等待清理确认'}`), cell(new Date(session.approval.expiresAt).toLocaleString()), controls); $('assistSessions').append(row);
      }
      if (!(state.assistSessions ?? []).length) { const row = document.createElement('tr'), empty = cell('暂无远程协助会话'); empty.colSpan = 4; row.append(empty); $('assistSessions').append(row); }
      $('assistInvites').replaceChildren();
      for (const invite of (state.assistInvites ?? []).filter(item => item.state === 'pending' && item.expiresAt > Date.now())) {
        const item = document.createElement('p'); item.textContent = `${invite.operatorName} · 邀请至 ${new Date(invite.expiresAt).toLocaleTimeString()} `;
        item.append(button('撤销邀请', () => api(`/api/assist/invites/${invite.id}/revoke`, {}))); $('assistInvites').append(item);
      }
    },
  };
}
