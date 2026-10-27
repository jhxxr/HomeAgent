import { escapeHtml as h } from './security.js';

interface ScopeChoice { id: string; checked: boolean }
interface DeviceChoice { id: string; name: string; checked: boolean }
interface ProjectChoice {
  value: string; deviceId: string; deviceName: string;
  projectId: string; projectName: string; checked: boolean;
}

const scopeMeta: Record<string, { label: string; description: string }> = {
  read: { label: '读取项目', description: '查看目录、文件、Git 历史，以及任务状态和输出。' },
  write: { label: '修改文件', description: '创建、移动和编辑所选项目中的文件与目录。' },
  execute: { label: '运行程序', description: '在设备上执行命令、读取输出和停止托管任务。' },
  git: { label: 'Git 操作', description: '暂存、提交和切换分支，以及拉取和推送代码。' },
};

const initial = (name: string) => (name.trim()[0] ?? 'A').toUpperCase();

const option = (name: string, value: string, checked: boolean, title: string, hint: string, tag = '') =>
  `<label class="consent-option"><input type="checkbox" name="${name}" value="${h(value)}"${checked ? ' checked' : ''}>`
  + `<span class="consent-option-text"><strong>${h(title)}</strong><small>${h(hint)}</small></span>`
  + `${tag ? `<code>${h(tag)}</code>` : ''}</label>`;

export function consentFormView(input: {
  clientName: string; redirectUri: string; requestId: string; csrf: string; message: string;
  scopes: ScopeChoice[]; devices: DeviceChoice[]; projects: ProjectChoice[];
}) {
  const scopeRows = input.scopes.map(scope => {
    const meta = scopeMeta[scope.id] ?? { label: scope.id, description: '' };
    return option('scopes', scope.id, scope.checked, meta.label, meta.description, scope.id);
  }).join('');
  const deviceRows = input.devices
    .map(device => option('devices', device.id, device.checked, device.name, '已配对设备'))
    .join('');
  const projectGroups = input.devices.map(device => ({
    device, rows: input.projects.filter(project => project.deviceId === device.id),
  })).filter(group => group.rows.length).map(group =>
    `<div class="consent-device"><p class="consent-device-label">${h(group.device.name)}<span>${group.rows.length} 个项目</span></p>`
    + `<div class="consent-options">${group.rows.map(project => option('projects', project.value, project.checked, project.projectName, `${project.deviceName} · ${project.projectId}`)).join('')}</div></div>`
  ).join('');
  const message = input.message ? `<p class="consent-alert" role="alert">${h(input.message)}</p>` : '';
  return `<div class="consent-page">
  <div class="consent-hero">
    <div class="consent-avatar" aria-hidden="true">${h(initial(input.clientName))}</div>
    <p class="consent-kicker">CONNECT YOUR CLIENT</p>
    <h1 class="consent-title">连接 ${h(input.clientName)}</h1>
    <p class="consent-lede">选择客户端能访问的项目与工具权限。你可以随时在控制台调整或收回授权。</p>
    <div class="consent-redirect"><span>授权完成后返回</span><code>${h(input.redirectUri)}</code></div>
  </div>
  <section class="consent-card">
    <form id="oauth-consent" method="post" action="/consent">
      <input type="hidden" name="request" value="${h(input.requestId)}">
      <input type="hidden" name="_csrf" value="${h(input.csrf)}">
      ${message}
      <section class="consent-group">
        <div class="consent-group-head"><h2><span class="consent-step" aria-hidden="true">01</span> 工具权限</h2><span>允许客户端执行哪些操作</span></div>
        <div class="consent-options">${scopeRows}</div>
      </section>
      <section class="consent-group">
        <div class="consent-group-head"><h2><span class="consent-step" aria-hidden="true">02</span> 选择设备</h2><span>授权将在哪些设备上生效</span></div>
        <div class="consent-options">${deviceRows || '<p class="consent-empty">还没有可授权的设备。请先在开发机器运行 <code>homeagent login</code>。</p>'}</div>
      </section>
      <section class="consent-group">
        <div class="consent-group-head"><h2><span class="consent-step" aria-hidden="true">03</span> 选择项目</h2><span>仅开放选中的项目</span></div>
        <div class="consent-projects">${projectGroups || '<p class="consent-empty">设备还没有配置项目。请先在控制台的「设备与项目」中添加项目目录。</p>'}</div>
      </section>
      <div class="consent-footer">
        <p class="consent-summary" id="consent-summary" aria-live="polite"></p>
        <p class="consent-status" id="consent-status" role="status" aria-live="polite"></p>
        <div class="consent-actions">
          <button type="submit" name="decision" value="deny" class="secondary">取消</button>
          <button type="submit" name="decision" value="allow">允许访问</button>
        </div>
        <p class="consent-fineprint">执行命令会使用被控端运行账户的系统权限。新增项目不会自动加入本次授权。</p>
      </div>
    </form>
  </section>
  <p class="consent-footnote">授权记录可在控制台查看；新增项目不会自动获得访问权限。</p>
</div>
<script src="/assets/consent.js" defer></script>`;
}

export function consentResultView(input: { kind: 'saved' | 'denied' | 'submitted'; redirect?: string }) {
  if (input.kind === 'submitted') {
    return `<div class="consent-page consent-page-narrow"><section class="consent-card consent-result"><span class="consent-icon neutral" aria-hidden="true"></span><p class="consent-kicker">AUTHORIZATION USED</p><h1>授权已提交</h1><p>授权码已使用或已过期，请返回客户端查看连接状态。如未连接，请从客户端重新发起授权。</p><a class="button secondary" href="/">返回控制台</a></section></div>`;
  }
  const saved = input.kind === 'saved';
  return `<div class="consent-page consent-page-narrow"><section class="consent-card consent-result"><span class="consent-icon ${saved ? 'ok' : 'no'}" aria-hidden="true"></span><p class="consent-kicker">${saved ? 'AUTHORIZATION COMPLETE' : 'AUTHORIZATION DENIED'}</p><h1>${saved ? '授权已保存' : '已拒绝授权'}</h1><p id="consent-status" role="status" aria-live="polite">${saved ? '权限已应用，正在返回客户端。若没有自动跳转，请点击下面的按钮。' : '客户端不会获得任何权限，正在返回客户端。若没有自动跳转，请点击下面的按钮。'}</p><a id="oauth-callback" href="${h(input.redirect ?? '/')}" rel="noreferrer" class="button">返回客户端</a>${saved ? '<p class="consent-footnote">你可以在控制台的「客户端访问」中调整或收回这项授权。</p>' : ''}</section></div><script src="/assets/consent.js" defer></script>`;
}

export function consentProblemView(message: string) {
  return `<div class="consent-page consent-page-narrow"><section class="consent-card consent-result"><span class="consent-icon no" aria-hidden="true"></span><p class="consent-kicker">AUTHORIZATION FAILED</p><h1>授权未完成</h1><p class="consent-alert" role="alert">${h(message)}</p><p>请返回 AI 客户端，重新发起连接或授权。不要重复提交旧页面。</p><a class="button secondary" href="/">返回控制台</a></section></div>`;
}
