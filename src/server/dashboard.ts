function editor(id: string, titleId: string, title: string, formId: string, contents: string, actions: string) {
  return `<dialog id="${id}" class="editor-dialog" aria-labelledby="${titleId}">
    <div class="editor-header"><div><p class="eyebrow">PERMISSIONS</p><h2 id="${titleId}">${title}</h2></div>
      <span class="badge" data-editor-dirty hidden>未保存</span><button type="button" class="secondary icon-button" data-editor-close aria-label="关闭${title}">×</button></div>
    <div class="editor-content"><form id="${formId}">${contents}</form></div>
    <div class="editor-footer">
      <div class="discard-confirmation" data-editor-discard hidden role="alert"><span>有未保存的修改，是否放弃？</span><button type="button" class="secondary" data-keep-editing>继续编辑</button><button type="button" class="danger" data-discard-changes>放弃修改</button></div>
      <p class="editor-status" data-editor-status role="status" aria-live="polite"></p>
      <div class="actions"><button type="submit" form="${formId}" data-editor-save>保存设置</button>${actions}<button type="button" class="secondary" data-editor-reload hidden>重新加载 Server 配置</button><button type="button" class="secondary" data-editor-close>关闭</button></div>
    </div>
  </dialog>`;
}

export const dashboard = `
<section class="intro">
  <div><p class="eyebrow">YOUR MACHINES, YOUR CONTROL</p><h1>远程开发控制台</h1><p>连接设备，配置项目，把开发权限交给指定客户端。</p>
    <div class="hero-meta"><span id="connectionStatus" class="system-status">正在同步…</span><span>每 5 秒自动刷新</span></div></div>
  <button id="logout" class="secondary">退出登录</button>
</section>
<nav class="quick-nav" aria-label="页面导航"><a href="#devices-section">设备与项目</a><a href="#jobs-section">任务</a><a href="#access-section">客户端访问</a><a href="#audit-section">审计</a></nav>
<p id="notice" role="status" aria-live="polite"></p>
<div class="stats"><article><span id="online">—</span><p>在线设备</p></article><article><span id="total">—</span><p>已添加设备</p></article><article><span id="clientCount">—</span><p>OAuth 客户端</p></article><article><span id="calls">—</span><p>最近调用</p></article></div>
<div class="columns">
  <section class="card"><h2>添加设备</h2><p>在被控端运行 <code>homeagent login</code>，打开终端中的链接，在网页填写项目目录并批准。完成后运行 <code>homeagent run</code>。</p>
    <details><summary>使用一次性码配对</summary><form id="pair"><label>一次性码<input name="code" required maxlength="10" pattern="[A-Fa-f0-9]{10}" placeholder="终端中显示的 10 位配对码" autocomplete="off"></label><button>核对并批准</button></form></details><p id="pairResult" role="status"></p></section>
  <section class="card"><h2>连接 AI 客户端</h2><p>支持 OAuth 的客户端直接使用下面的 MCP 地址。</p><code id="endpoint"></code>
    <div class="actions"><button id="copyEndpoint" type="button" class="secondary">复制 MCP 地址</button><a href="/.well-known/oauth-authorization-server" target="_blank" rel="noreferrer">查看 OAuth 元数据</a></div><p>需要 Bearer Token 时，在“客户端访问”中创建。</p></section>
</div>
<section class="card" id="devices-section"><div class="section-title"><h2>设备与项目</h2><span id="updated"></span></div><div id="devices" class="device-grid"></div></section>
${editor('devicePermissionPanel', 'devicePermissionTitle', '设备设置', 'devicePermissionForm',
  `<p>项目目录和权限由 Server 保存。一般只需选择访问档位和 Git 开关。</p><div id="devicePermissionProjects"></div><button type="button" id="addPermissionProject" class="secondary">添加项目</button><div id="devicePermissionDuration"></div>`,
  '<button type="button" id="clearDeviceProjects" class="danger">清空全部项目</button>')}
<section class="card" id="jobs-section"><h2>任务与执行记录</h2><p>查看输出或停止设备上的任务。离线记录会保留最近一次观察到的状态。</p>
  <div class="scroll"><table><thead><tr><th>开始时间</th><th>程序 / 任务</th><th>设备 / 项目</th><th>状态</th><th>输出字节</th><th>操作</th></tr></thead><tbody id="jobs"></tbody></table></div>
  <section id="jobOutputPanel" hidden><div class="section-title"><h3 id="jobOutputTitle">任务输出</h3><div class="actions"><button id="jobOutputNext" class="secondary">读取下一段</button><button id="closeJobOutput" class="secondary">关闭输出</button></div></div><pre id="jobOutput"></pre></section>
</section>
<section class="card" id="access-section"><h2>创建客户端令牌</h2><p>选择客户端能访问的具体项目，再选择只读或完整开发。项目后续增加时不会自动扩大授权。</p>
  <form id="token">
    <div class="form-grid"><label>客户端名称<input name="name" required maxlength="100" placeholder="例如 Cursor 工作站"></label><label>有效天数<input name="days" type="number" min="1" max="365" value="30" required></label><label>访问权限<select name="access"><option value="read">只读查看</option><option value="full">完整开发</option></select></label></div>
    <div id="tokenDevices" class="project-targets"></div><p id="tokenStatus" role="status" class="muted"></p><button>创建令牌</button>
  </form>
  <section id="newTokenPanel" hidden><p class="success">令牌已创建，仅在本次页面显示，请复制保存。</p><pre id="newToken"></pre><div class="actions"><button id="copyToken" class="secondary">复制令牌</button><button id="hideToken" class="secondary">隐藏令牌</button></div></section>
</section>
<section class="card"><h2>客户端授权</h2><p>在弹窗中修改现有授权，无需重新复制令牌。</p><div class="scroll"><table><thead><tr><th>客户端</th><th>类型</th><th>访问权限</th><th>项目范围</th><th>有效时间</th><th>操作</th></tr></thead><tbody id="authorizations"></tbody></table></div></section>
${editor('authorizationPermissionPanel', 'authorizationPermissionTitle', '客户端权限', 'authorizationPermissionForm', '',
  '<button type="button" id="cancelTemporaryAuthorization" class="secondary" hidden>收回临时权限</button>')}
<details class="card"><summary>令牌与登录管理</summary>
  <h2>客户端令牌记录</h2><div class="scroll"><table><thead><tr><th>客户端</th><th>类型</th><th>权限</th><th>最近使用</th><th>到期时间</th><th>操作</th></tr></thead><tbody id="tokens"></tbody></table></div>
  <h2>管理员登录会话</h2><div class="scroll"><table><thead><tr><th>浏览器</th><th>最近使用</th><th>到期时间</th><th>状态</th><th>操作</th></tr></thead><tbody id="sessions"></tbody></table></div>
  <h2>OAuth 客户端</h2><div class="scroll"><table><thead><tr><th>客户端</th><th>回调地址</th><th>操作</th></tr></thead><tbody id="oauthClients"></tbody></table></div>
</details>
<section class="card" id="audit-section"><div class="section-title"><h2>审计日志</h2><a href="/api/audit?limit=1000" target="_blank" rel="noreferrer">查看 JSON</a></div><p>记录操作主体和结果，不保存文件内容或命令输出。</p><div class="scroll"><table><thead><tr><th>时间</th><th>工具</th><th>设备 / 项目</th><th>主体</th><th>结果</th><th>耗时</th></tr></thead><tbody id="audit"></tbody></table></div></section>
<script type="module" src="/assets/dashboard.js"></script>`;
