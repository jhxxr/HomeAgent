import { VERSION } from '../shared/protocol.js';

const paths: Record<string, string> = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  devices: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  jobs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  access: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m3-12a3 3 0 0 1 0 6m0 3a5 5 0 0 1 3 3"/>',
  activity: '<path d="M9 4H5a2 2 0 0 0-2 2v14h14V6a2 2 0 0 0-2-2h-2m-4-1h4v4H9zM7 11h6m-6 4h4m9-6v12"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  logout: '<path d="M9 4H5v16h4m6-12 4 4-4 4m-6-4h10"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
};
const icon = (name: string) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.overview}</svg>`;
function editor(id: string, titleId: string, title: string, formId: string, contents: string, actions: string) {
  return `<dialog id="${id}" class="editor-dialog" aria-labelledby="${titleId}">
    <div class="editor-header"><div><p class="eyebrow">ACCESS CONTROL</p><h2 id="${titleId}">${title}</h2></div>
      <span class="badge" data-editor-dirty hidden>未保存</span><button type="button" class="secondary icon-button" data-editor-close aria-label="关闭${title}">×</button></div>
    <div class="editor-content"><form id="${formId}">${contents}</form></div>
    <div class="editor-footer">
      <div class="discard-confirmation" data-editor-discard hidden role="alert"><span>还有未保存的修改，是否放弃？</span><button type="button" class="secondary" data-keep-editing>继续编辑</button><button type="button" class="danger" data-discard-changes>放弃修改</button></div>
      <p class="editor-status" data-editor-status role="status" aria-live="polite"></p>
      <div class="actions"><button type="submit" form="${formId}" data-editor-save>保存设置</button>${actions}<button type="button" class="secondary" data-editor-reload hidden>重新加载 Server 配置</button><button type="button" class="secondary" data-editor-close>关闭</button></div>
    </div>
  </dialog>`;
}

const consoleNav = (name: string, label: string, count = '') => `<button type="button" class="console-nav-button${name === 'overview' ? ' is-selected' : ''}" data-console-view="${name}" aria-controls="console-view-${name}"${name === 'overview' ? ' aria-current="page"' : ''}>${icon(name)}<span>${label}</span>${count ? `<span id="${count}" class="console-nav-count nav-count">—</span>` : ''}</button>`;

export const dashboard = `
<div class="ha-console">
  <div class="console-topbar">
    <div class="console-brand">
      <img class="console-brand-mark" src="/assets/icon.png" width="64" height="64" alt="">
      <div><p class="console-brand-kicker">SELF-HOSTED · REMOTE MCP</p><h1>HomeAgent</h1>
        <div class="console-brand-meta"><span id="connectionStatus" class="system-status">正在同步…</span><time id="consoleClock">--:--:--</time><span id="consoleSync">每 5 秒同步</span></div>
      </div>
    </div>
    <div class="console-kpis" aria-label="当前状态">
      <article class="console-kpi"><p>在线设备</p><strong id="online">—</strong><span class="console-kpi-foot">共 <b id="total">—</b> 台已配对设备</span></article>
      <article class="console-kpi"><p>运行中任务</p><strong id="runningCount">—</strong><span class="console-kpi-foot"><b id="projectCount">—</b> 个已应用项目</span></article>
      <article class="console-kpi"><p>OAuth 客户端</p><strong id="clientCount">—</strong><span class="console-kpi-foot">OAUTH CLIENTS</span></article>
      <article class="console-kpi"><p>最近审计</p><strong id="calls">—</strong><span class="console-kpi-foot">最多 100 条记录</span></article>
    </div>
  </div>
  <nav class="console-nav" aria-label="控制台视图">
    <div class="console-view-links" role="tablist" aria-label="控制台视图">${consoleNav('overview', '运行总览')}${consoleNav('devices', '设备与项目', 'deviceCount')}${consoleNav('jobs', '任务与输出', 'jobCount')}${consoleNav('access', '客户端访问', 'authorizationCount')}${consoleNav('activity', '审计日志')}${consoleNav('settings', '令牌与会话')}</div>
    <div class="console-tools"><button id="consoleRefresh" type="button" class="secondary" aria-label="立即刷新状态">↻ <span>刷新</span></button><button id="consoleFullscreen" type="button" class="secondary" aria-label="进入全屏">⛶ <span>全屏</span></button><button id="logout" type="button" class="secondary">退出</button></div>
  </nav>
  <div class="console-view-heading"><div><p class="eyebrow">WORKSPACE</p><h2 id="viewTitle" tabindex="-1">运行总览</h2><p id="viewDescription">连接你的开发环境，掌握设备、授权和任务的运行状态。</p></div></div>
  <p id="notice" role="status" aria-live="polite" aria-atomic="true"></p>
  <noscript><p class="error card">请启用 JavaScript，以查看设备并管理工作空间。</p></noscript>
  <section id="console-view-overview" class="console-overview" data-console-panel="overview" aria-labelledby="consoleOverviewTitle">
    <div class="console-network-panel">
      <div class="console-panel-head"><div><h2 id="consoleOverviewTitle">开发网络<span class="console-heading-note">一个入口，连接你的开发环境</span></h2></div><span class="console-route-label">CLIENT → MCP → RUNNER</span></div>
      <div class="console-network-grid">
        <svg class="console-connectors" viewBox="0 0 1000 320" preserveAspectRatio="none" fill="none" aria-hidden="true">
          <path class="console-connection" d="M245 43C355 43 365 160 500 160" vector-effect="non-scaling-stroke"/>
          <path class="console-connection" d="M245 118C355 118 365 160 500 160" vector-effect="non-scaling-stroke"/>
          <path class="console-connection" d="M245 193C355 193 365 160 500 160" vector-effect="non-scaling-stroke"/>
          <path class="console-connection" d="M245 268C355 268 365 160 500 160" vector-effect="non-scaling-stroke"/>
          <path class="console-connection" d="M500 160C635 160 645 43 755 43" vector-effect="non-scaling-stroke"/>
          <path class="console-connection" d="M500 160C635 160 645 118 755 118" vector-effect="non-scaling-stroke"/>
          <path class="console-connection" d="M500 160C635 160 645 193 755 193" vector-effect="non-scaling-stroke"/>
          <path class="console-connection" d="M500 160C635 160 645 268 755 268" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="console-node-column"><div class="console-column-heading"><span><span class="console-label-desktop">01 / CLIENTS</span><span class="console-label-mobile">客户端</span></span><button type="button" class="console-text-button" data-console-view="access" aria-controls="console-view-access">管理授权 ↗</button></div><div id="consoleClients" class="console-node-list"><p class="console-empty">等待客户端数据…</p></div></div>
        <div class="console-hub-scene">
          <span class="console-hub-caption">02 / MCP SERVER</span>
          <div class="console-core-wrap"><svg id="consoleRing" class="console-orbit" viewBox="0 0 240 240" fill="none" aria-hidden="true"></svg>
            <div id="consoleHub" class="console-hub"><img class="console-core-mark" src="/assets/icon.png" width="64" height="64" alt=""><span>HomeAgent</span></div>
          </div>
          <p id="consoleActivity" class="console-core-status">等待首次同步</p><span id="consoleOnlineSummary" class="console-core-detail">连接设备后显示运行状态</span>
        </div>
        <div class="console-node-column"><div class="console-column-heading"><span><span class="console-label-desktop">03 / RUNNERS</span><span class="console-label-mobile">设备</span></span><button type="button" class="console-text-button" data-console-view="devices" aria-controls="console-view-devices">全部设备 ↗</button></div><div id="consoleRunners" class="console-node-list"><p class="console-empty">等待设备数据…</p></div></div>
      </div>
      <div class="console-status-grid">
        <article class="console-status-card"><div class="console-card-heading"><h3><span class="console-card-symbol" aria-hidden="true">↗</span>执行任务</h3><span id="consoleJobCount" class="console-count">—</span></div><div id="consoleJobs" class="console-status-list"><p class="console-empty">等待任务数据…</p></div><button type="button" class="console-text-button" data-console-view="jobs" aria-controls="console-view-jobs">查看执行记录 ↗</button></article>
        <article class="console-status-card"><div class="console-card-heading"><h3><span class="console-card-symbol" aria-hidden="true">△</span>权限提醒</h3><span id="consolePolicyCount" class="console-count">—</span></div><div id="consolePolicy" class="console-status-list"><p class="console-empty">等待权限状态…</p></div><button type="button" class="console-text-button" data-console-view="devices" aria-controls="console-view-devices">管理设备权限 ↗</button></article>
        <article class="console-status-card"><div class="console-card-heading"><h3><span class="console-card-symbol" aria-hidden="true">◎</span>调用结果</h3><span id="consoleOutcomeCount" class="console-count">—</span></div><div id="consoleOutcomes" class="console-status-list"><p class="console-empty">等待调用记录…</p></div><button type="button" class="console-text-button" data-console-view="activity" aria-controls="console-view-activity">查看审计详情 ↗</button></article>
      </div>
      <div class="console-trend-row"><div class="console-trend-copy"><h3>近 60 分钟审计活动</h3><p id="consoleSample">最近 100 条审计记录</p><div class="console-chart-legend"><span class="is-success">审计总数</span><span class="is-error">未成功</span></div></div><div class="console-chart-wrap"><svg id="consoleTimeline" viewBox="0 0 600 110" role="img" aria-label="最近审计记录的调用活动"></svg><p id="consoleTimelineEmpty" class="console-empty">近 60 分钟暂无审计记录</p></div><div class="console-latency"><span>采样耗时中位数</span><strong id="consoleLatency">—</strong><small>来自最近审计记录</small></div></div>
    </div>
    <div class="console-feed-panel"><div class="console-panel-head"><h2>活动日志<span class="console-heading-note">RECENT EVENTS</span></h2><button type="button" class="console-text-button" data-console-view="activity" aria-controls="console-view-activity">全部日志 ↗</button></div><div id="consoleFeed" class="console-feed"><p class="console-empty">连接后，工具调用和管理操作会显示在这里。</p></div></div>
  </section>
  <section id="console-view-devices" class="console-management" data-console-panel="devices" aria-label="设备与项目" hidden>
<section data-view="devices" id="devices-section" aria-label="设备与项目" hidden>
        <details class="card onboarding-card"><summary>${icon('plus')}添加一台开发设备<span>查看连接步骤</span></summary><div class="onboarding-steps"><div><span class="step-number">1</span><h3>在开发机器上登录</h3><p>安装 Runner 后，执行登录命令。</p><code>homeagent login</code></div><div><span class="step-number">2</span><h3>在浏览器中批准</h3><p>打开终端里的链接，填写项目目录和访问权限。</p></div><div><span class="step-number">3</span><h3>启动 Runner</h3><p>设备主动连接，不需要开放入站端口。</p><code>homeagent run</code></div></div><details class="pair-fallback"><summary>使用一次性配对码</summary><form id="pair"><label>终端显示的 10 位配对码<input name="code" required maxlength="10" pattern="[A-Fa-f0-9]{10}" placeholder="输入配对码" autocomplete="off"></label><button>核对并批准</button></form><p id="pairResult" role="status"></p></details></details>
        <div class="toolbar"><label class="search-field">${icon('search')}<input id="deviceSearch" type="search" placeholder="搜索设备或项目" aria-label="搜索设备或项目"></label><label class="filter-field"><span class="sr-only">设备状态</span><select id="deviceFilter"><option value="all">全部状态</option><option value="online">在线</option><option value="offline">离线</option><option value="paused">已暂停</option></select></label><span id="updated" class="toolbar-note">正在加载…</span></div><div id="devices" class="device-grid" aria-live="polite"></div>
      </section>
  </section>
  <section id="console-view-jobs" class="console-management" data-console-panel="jobs" aria-label="任务与输出" hidden>
<section data-view="jobs" id="jobs-section" aria-label="任务与输出" hidden>
        <section class="card table-card"><div class="section-title"><div><h2>任务与执行记录</h2><p>查看命令输出，或停止正在运行的任务。</p></div><label class="filter-field"><span class="sr-only">任务状态</span><select id="jobFilter"><option value="all">全部任务</option><option value="running">运行中</option><option value="exited">已完成</option><option value="failed">异常结束</option></select></label></div><div class="scroll"><table><thead><tr><th>开始时间</th><th>程序 / 任务</th><th>设备 / 项目</th><th>状态</th><th>输出</th><th>操作</th></tr></thead><tbody id="jobs"></tbody></table></div><p class="table-footnote">设备离线时，显示最近一次观察到的状态。</p></section>
        <section id="jobOutputPanel" class="card output-card" hidden><div class="section-title"><div><p class="eyebrow">RUNNER OUTPUT</p><h2 id="jobOutputTitle">任务输出</h2></div><div class="actions"><button id="jobOutputNext" class="secondary">读取下一段</button><button id="closeJobOutput" class="secondary">关闭输出</button></div></div><pre id="jobOutput" tabindex="0" aria-label="任务输出"></pre></section>
      </section>
  </section>
  <section id="console-view-access" class="console-management" data-console-panel="access" aria-label="客户端访问" hidden>
<section data-view="access" id="access-section" aria-label="客户端访问" hidden>
        <div class="info-banner">${icon('link')}<div><strong>优先使用 OAuth 连接</strong><p>在 AI 客户端填写下方 MCP 地址，按提示选择项目并授权。需要 Bearer Token 的客户端，可在下方创建令牌。</p></div></div>
        <section class="card connect-card"><div class="connect-heading"><span class="feature-icon">${icon('link')}</span><div><h2>让 AI 接入你的工作空间</h2><p>在 Claude、ChatGPT 或 Cursor 中添加 MCP 连接，使用 OAuth 完成授权。</p></div></div><div class="endpoint-row"><code id="endpoint">正在获取 MCP 地址…</code><button id="copyEndpoint" class="secondary" type="button">复制地址</button></div><div class="connect-footer"><span>${icon('shield')}每个客户端只访问你授权的项目</span><a href="/.well-known/oauth-authorization-server" target="_blank" rel="noreferrer">OAuth 元数据 ${icon('arrow')}</a></div></section>
        <section class="card table-card"><div class="section-title"><div><h2>客户端授权</h2><p>按项目管理访问范围，调整权限无需重新复制令牌。</p></div><span class="badge">按项目授权</span></div><div class="scroll"><table><thead><tr><th>客户端</th><th>类型</th><th>访问权限</th><th>项目范围</th><th>有效时间</th><th>操作</th></tr></thead><tbody id="authorizations"></tbody></table></div></section>
        <details class="card token-create" open><summary>创建客户端令牌<span>Bearer Token</span></summary><p>只选择客户端需要的项目；后续新增的项目不会自动授权。</p><form id="token"><div class="form-grid"><label>客户端名称<input name="name" required maxlength="100" placeholder="例如 Cursor 工作站" autocomplete="off"></label><label>有效天数<input name="days" type="number" min="1" max="365" value="30" required></label><label>访问权限<select name="access"><option value="read">只读查看</option><option value="full">完整开发</option></select></label></div><div class="form-section-label">授权的设备与项目</div><div id="tokenDevices" class="project-targets"></div><p id="tokenStatus" role="status" class="muted"></p><div class="form-submit"><span>令牌仅在创建后显示一次，请妥善保存。</span><button>创建令牌</button></div></form><section id="newTokenPanel" hidden><p class="success">令牌已创建，请复制保存。隐藏后无法再次查看。</p><pre id="newToken"></pre><div class="actions"><button id="copyToken" class="secondary">复制令牌</button><button id="hideToken" class="secondary">隐藏令牌</button></div></section></details>
      </section>
  </section>
  <section id="console-view-activity" class="console-management" data-console-panel="activity" aria-label="审计日志" hidden>
<section data-view="activity" id="audit-section" aria-label="审计日志" hidden><section class="card table-card"><div class="section-title"><div><h2>工作空间操作记录</h2><p>记录操作主体和结果，不保存文件内容或命令输出。</p></div><a class="button secondary" href="/api/audit?limit=1000" target="_blank" rel="noreferrer">查看 JSON ${icon('arrow')}</a></div><div class="toolbar"><label class="search-field">${icon('search')}<input id="auditSearch" type="search" placeholder="搜索工具、设备或操作结果" aria-label="搜索审计日志"></label></div><div class="scroll"><table><thead><tr><th>时间</th><th>工具</th><th>设备 / 项目</th><th>主体</th><th>结果</th><th>耗时</th></tr></thead><tbody id="audit"></tbody></table></div></section></section>
  </section>
  <section id="console-view-settings" class="console-management" data-console-panel="settings" aria-label="令牌与会话" hidden>
<section data-view="settings" aria-label="令牌与登录管理" hidden><section class="card table-card"><div class="section-title"><div><h2>客户端令牌</h2><p>管理有效期，或撤销不再需要的令牌。</p></div><a href="#access" data-view-link>创建令牌 ${icon('arrow')}</a></div><div class="scroll"><table><thead><tr><th>客户端</th><th>类型</th><th>权限</th><th>最近使用</th><th>到期时间</th><th>操作</th></tr></thead><tbody id="tokens"></tbody></table></div></section><section class="card table-card"><div class="section-title"><div><h2>管理员登录会话</h2><p>查看当前浏览器，并结束其他设备上的登录。</p></div></div><div class="scroll"><table><thead><tr><th>浏览器</th><th>最近使用</th><th>到期时间</th><th>状态</th><th>操作</th></tr></thead><tbody id="sessions"></tbody></table></div></section><section class="card table-card"><div class="section-title"><div><h2>OAuth 客户端</h2><p>已注册的客户端及回调地址。</p></div></div><div class="scroll"><table><thead><tr><th>客户端</th><th>回调地址</th><th>操作</th></tr></thead><tbody id="oauthClients"></tbody></table></div></section></section>
  </section>
  <footer class="workspace-footer console-footer"><span>HomeAgent <span class="footer-dot">·</span> 你的机器，你来掌控</span><span>单管理员工作空间 <span class="footer-dot">·</span> v${VERSION}</span></footer>
</div>
${editor('devicePermissionPanel', 'devicePermissionTitle', '设备设置', 'devicePermissionForm',
  `<p class="editor-intro">为这台设备配置项目目录与访问权限，保存后由 Runner 应用。</p><div id="devicePermissionProjects"></div><button type="button" id="addPermissionProject" class="secondary">${icon('plus')}添加项目</button><div id="devicePermissionDuration"></div>`,
  '<button type="button" id="clearDeviceProjects" class="danger">清空全部项目</button>')}
${editor('authorizationPermissionPanel', 'authorizationPermissionTitle', '客户端权限', 'authorizationPermissionForm', '', '<button type="button" id="cancelTemporaryAuthorization" class="secondary" hidden>收回临时权限</button>')}
<dialog id="confirmDialog" class="confirm-dialog" aria-labelledby="confirmTitle" aria-describedby="confirmDescription"><form id="confirmForm"><span class="confirm-symbol">${icon('shield')}</span><h2 id="confirmTitle">确认操作</h2><p id="confirmDescription"></p><label id="confirmInputField" hidden>设备名称<input id="confirmInput" name="name" maxlength="128" autocomplete="off"></label><p id="confirmError" class="error" role="alert"></p><div class="actions"><button id="confirmCancel" type="button" class="secondary">取消</button><button id="confirmSubmit" type="submit">确认</button></div></form></dialog>
<script type="module" src="/assets/dashboard.js"></script>`;
