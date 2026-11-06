export const kanbanView = `
<link rel="stylesheet" href="/assets/kanban.css">
<section id="console-view-kanban" class="console-management kb-page" data-console-panel="kanban" aria-label="项目看板" hidden>
  <div class="kb-heading"><div><p class="eyebrow">PLAN · BUILD · REVIEW</p><h2>让每项开发工作都有着落</h2><p>创建任务，交给 AI 认领，在这里检查结果。</p></div><button id="kbCreate" type="button" disabled>＋ 新建任务</button></div>
  <div class="kb-filters">
    <label>项目<select id="kbProject"><option value="">正在加载项目…</option></select></label>
    <label>执行设备<select id="kbDevice"><option value="">全部设备</option></select></label>
    <label>认领客户端<select id="kbAssignee"><option value="">全部客户端</option></select></label>
    <label class="kb-search">搜索<input id="kbSearch" type="search" maxlength="256" placeholder="任务编号、标题或文件路径"></label>
    <div class="kb-view-switch" role="group" aria-label="看板显示方式"><button type="button" id="kbBoardMode" class="secondary" aria-pressed="true">看板</button><button type="button" id="kbListMode" class="secondary" aria-pressed="false">列表</button></div>
  </div>
  <div class="kb-context"><p id="kbProjectInfo">任务按项目共享，设备离线时也可查看已有工作。</p><div><span id="kbSync" role="status" aria-live="polite">等待同步</span><button id="kbRefresh" type="button" class="secondary">刷新</button></div></div>
  <p id="kbError" class="kb-alert" role="alert" hidden></p>
  <div id="kbEmpty" class="kb-empty" hidden><span aria-hidden="true">▤</span><h3>先连接一个项目</h3><p>在「设备与项目」配置项目后，即可安排开发工作。</p><a href="#devices">前往设备与项目 →</a></div>
  <div id="kbWorkspace" hidden>
    <div id="kbMobileTabs" class="kb-mobile-tabs" role="group" aria-label="选择任务状态"></div>
    <div id="kbColumns" class="kb-columns"></div>
    <div id="kbList" class="kb-list scroll" hidden><table><caption class="sr-only">项目任务列表</caption><thead><tr><th>任务</th><th>状态</th><th>认领客户端 / 设备</th><th>文件</th><th>最后更新</th></tr></thead><tbody id="kbRows"></tbody></table><div id="kbListMore" class="kb-list-more"></div></div>
    <p class="kb-footnote">创建任务不会自动唤醒 AI。复制任务指令给已连接的客户端，让其认领执行。审核通过不自动提交 Git。</p>
  </div>
</section>
<dialog id="kbTaskDialog" class="kb-dialog kb-drawer" aria-labelledby="kbTaskTitle">
  <header class="kb-dialog-head"><div><p id="kbTaskId" class="eyebrow"></p><h2 id="kbTaskTitle"></h2></div><button type="button" id="kbCloseTask" class="secondary icon-button" aria-label="关闭任务详情">×</button></header>
  <div class="kb-dialog-body">
    <div id="kbTaskStatus" class="kb-detail-status"></div>
    <div id="kbConflict" class="kb-alert" hidden><span>任务已有新进展。当前内容未被覆盖，请加载最新版本后再操作。</span><button id="kbReloadTask" type="button" class="secondary">加载最新</button></div>
    <p id="kbTaskError" class="kb-alert" role="alert" hidden></p>
    <div class="kb-detail-tabs" role="tablist" aria-label="任务详情"><button type="button" role="tab" id="kbTabDetails" data-kb-tab="details" aria-controls="kbDetails" aria-selected="true">任务详情</button><button type="button" role="tab" id="kbTabEvidence" data-kb-tab="evidence" aria-controls="kbEvidence" aria-selected="false" tabindex="-1">文件与审核</button><button type="button" role="tab" id="kbTabActivity" data-kb-tab="activity" aria-controls="kbActivity" aria-selected="false" tabindex="-1">活动记录</button></div>
    <section id="kbDetails" role="tabpanel" aria-labelledby="kbTabDetails" tabindex="0"></section>
    <section id="kbEvidence" role="tabpanel" aria-labelledby="kbTabEvidence" tabindex="0" hidden></section>
    <section id="kbActivity" role="tabpanel" aria-labelledby="kbTabActivity" tabindex="0" hidden></section>
    <form id="kbReasonForm" class="kb-reason" hidden><label><span id="kbReasonLabel">操作原因</span><textarea id="kbReason" required maxlength="1024" placeholder="说明原因，帮助执行者继续处理"></textarea></label><p id="kbReasonHelp"></p><div class="actions"><button type="submit" id="kbReasonSubmit">确认</button><button type="button" id="kbReasonCancel" class="secondary">取消</button></div></form>
  </div>
  <footer class="kb-dialog-footer"><div id="kbTaskActions" class="kb-task-actions"></div><form id="kbCommentForm"><label for="kbComment">添加备注</label><div class="kb-comment-row"><textarea id="kbComment" required maxlength="1024" placeholder="补充要求或审核意见，不会延长执行者租约"></textarea><button type="submit">发送</button></div></form></footer>
</dialog>
<dialog id="kbMoveDialog" class="kb-dialog kb-editor" aria-labelledby="kbMoveTitle">
  <header class="kb-dialog-head"><div><p class="eyebrow">MOVE TASK</p><h2 id="kbMoveTitle">移动任务</h2></div><button id="kbCloseMove" type="button" class="secondary icon-button" aria-label="关闭移动任务">×</button></header>
  <form id="kbMoveForm"><div class="kb-dialog-body"><p id="kbMoveDescription"></p><div id="kbAssignFields"><label>认领客户端<select id="kbAssignClient" required></select></label><label>执行设备<select id="kbAssignDevice" required></select></label><p class="kb-footnote">仅列出当前获授权的客户端和设备。分配任务只记录负责人，不会自动唤醒 AI、执行命令或跳过授权。</p></div><div id="kbSubmitFields"><label>拟提交信息<input id="kbSubmitMessage" maxlength="512" required></label><label>交付与验证说明<textarea id="kbSubmitSummary" maxlength="2048" required placeholder="说明已完成的内容和验证情况；此处不会自动生成哈希或证明测试通过。"></textarea></label></div><p id="kbMoveError" class="kb-alert" role="alert" hidden></p></div><footer class="kb-dialog-footer"><button id="kbCancelMove" type="button" class="secondary">取消</button><button id="kbMoveSubmit" type="submit">确认移动</button></footer></form>
</dialog>
<dialog id="kbEditDialog" class="kb-dialog kb-editor" aria-labelledby="kbEditTitle">
  <header class="kb-dialog-head"><div><p class="eyebrow">PROJECT TASK</p><h2 id="kbEditTitle">新建任务</h2></div><button type="button" id="kbCloseEdit" class="secondary icon-button" aria-label="关闭任务编辑">×</button></header>
  <form id="kbEditForm"><div class="kb-dialog-body"><p id="kbEditProject" class="kb-project-label"></p><label>任务标题<input id="kbTitle" required maxlength="256" placeholder="例如：修复登录回调的错误提示"></label><label>描述与验收要求<textarea id="kbDescription" maxlength="4096" rows="5" placeholder="描述问题、预期结果，以及如何验证完成。"></textarea></label><label>预计修改路径<span class="field-hint">每行一个项目相对路径，最多 32 个；可暂不填写。</span><textarea id="kbPaths" rows="3" placeholder="src/server/example.ts&#10;tests/example.test.ts"></textarea></label><label class="kb-checkbox"><input id="kbReview" type="checkbox" checked>完成后需要人工审核</label><p class="kb-footnote">任务创建后处于待办状态，不会自动执行命令或派发给 AI。</p><p id="kbEditError" class="kb-alert" role="alert" hidden></p><button id="kbEditReload" type="button" class="secondary" hidden>加载最新任务（保留当前草稿前请先复制）</button></div><footer class="kb-dialog-footer"><button type="button" id="kbCancelEdit" class="secondary">取消</button><button id="kbSave" type="submit">创建任务</button></footer></form>
</dialog>`;
