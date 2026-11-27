# Agent 调度与日历联动

Server 在同一个 `/mcp` 入口支持目录绑定执行者和无目录云端主管。Runner 协议仍为
**2**，现有 v0.4.21 Runner 无需升级协议。不引入运行时依赖，不破坏 SQLite 表结构。

## 主体与授权

PAT 创建页、OAuth 授权页和已有令牌编辑页均支持：

- `agentRole`：`worker` 执行者、`supervisor` 主管、`observer` 只读观察者。
- `bindingMode`：`bound_projects` 绑定项目，或 `none` 无目录。
- `displayName`：可读名称；权限与指派使用稳定的 `principalId`。
- `tasks:self`：收件箱、认领、进度、阻塞、交付。
- `tasks:dispatch`：主管查询 Agent 目录并派单。
- `tasks:review`：主管审校。
- `calendar:read`：主管读取缓存中的个人日历忙闲。

角色与 scope 必须同时满足。观察者不能修改任务或文件。无目录主体必须使用
`devices: []`、`projectGrants: {}`；即使误配机器 scope，也不能发现设备或直接调用
隐藏的文件、终端、Git 工具。修改现有授权即时生效，无需重新复制令牌。

旧主体按绑定目录的 worker 兼容；旧 write 授权在读取时获得 `tasks:self`，不会获得
主管权限。旧任务继续使用实际的 **`tasks`** KV 桶；读取时补默认值，不写迁移、不续租。
每次新的 OAuth 同意分别生成 Agent 身份；access/refresh 轮换保持该身份，历史身份保留。

## 统一 MCP 流程

| 工具 | 权限 | 主要参数 |
| --- | --- | --- |
| `task_inbox()` | `tasks:self` | 无参数 |
| `task_claim` | `tasks:self` | `taskId`、`expectedRevision`，可选 `deviceId` |
| `task_update` | `tasks:self` | 任务与 revision，可选 `message`、`actualPaths`、`testJobId` |
| `task_block` | `tasks:self` | 任务与 revision、`blockReason`，可选 `needHuman` |
| `task_submit` | `tasks:self` | 任务与 revision，可选摘要、提交信息、哈希、`testJobId` |
| `agent_directory()` | 主管 + `tasks:dispatch` | 无参数 |
| `task_dispatch` | 主管 + `tasks:dispatch` | 标题、`assigneePrincipalId`，可选目录、风险、优先级、DDL |
| `task_review` | 主管 + `tasks:review` | 任务与 revision、`approve/reject/revise/reopen`，非批准操作需原因 |
| `calendar_context()` | 主管 + `calendar:read` | 无参数 |

派单创建**已指定负责人的待办任务**，不会启动租约或唤醒 Agent。研究、总结等纯云端
工作使用 `projectId: null, deviceId: null`。目录任务必须通过目标主体的设备／项目
授权与当前有效设备策略交集；多台设备存在歧义时需显式选择设备。`needsWrite` 默认
为 true，同时检查目标 write scope 和设备只读限制；只读调研可以设为 false。

零参收件箱返回名下任务和有权认领的项目待办，附带
`workspace: {deviceId, projectId, root, readOnly, online}`；云端任务为 null。
收件箱不执行 Runner 工具。`project_note` 来自升级后成功的 `save_project_note` /
`get_project_context` 调用缓存，按主体、设备、项目和根目录隔离；缺失时为 null，
读取需 read scope。根目录变化自动使旧缓存失效；任务文字和笔记均不是授权凭据。
收件箱优先展示名下未完成任务，限制 200 项及传输字节预算，返回 `total`、`truncated`；
累积消息等历史有明确总数与截断；管理员看板提供更详细的受限证据与历史视图。

认领取得 30 分钟租约；只有负责人可以更新、阻塞和交付。revision 过期返回
`409 conflict`。活跃机器操作仅续租同一主体、设备、项目下的未过期任务；浏览器轮询、
备注和 Runner 心跳不续租。阻塞会暂停租约，即使失去 write scope，仍可报告原因并请求
人工介入。管理员可以选定 write/execute/Git 权限，临时授权 **30 分钟**并重开任务；
设备策略与工具白名单仍有效。与其他授权变更一致，这会取消该授权正在托管的工作。

五态为 `todo / in_progress / blocked / review / done`。新派单默认 P2、中风险、需审核。
只有 **low 且 requiresReview=false** 直接完成；其他均提审。主管可批准、驳回、退修、
重开，但**高风险或证据路径过期**必须由浏览器管理员确认。旧工具不能绕过此门控。
哈希仍是客户端证据，不代表独立验证；`testJobId` 则必须属于负责人及同一设备／项目，
测试是否通过来自已存储的 Runner 作业观察记录。

六个 `kanban_*` 保留为 deprecated 兼容工具，保持原项目／设备参数及 read/write scope，
并执行负责人、租约与风险检查。`kanban_complete_task` 不再允许执行者跳过必须的审核；
请迁移到 `task_submit` 与有权限的审校流程。

## 可选日历配置

默认 `CALENDAR_PROVIDER=none`：不启动日历定时器、不访问外部服务、不显示日历栏。
开启后约每分钟同步未来七天的忙闲与 `[DDL]` 标题事件；其他私人事件标题不写入缓存。
缓存过期或同步失败不会将未知时段宣称为空闲。凭据仅保留在环境配置中，错误信息脱敏，
请求有超时和响应大小上限，禁止跟随重定向。

Google 设置 `CALENDAR_PROVIDER=google`、`CALENDAR_ID`（默认 primary），以及以下之一：

- `CALENDAR_ACCESS_TOKEN`，到期后需手动更新。
- `CALENDAR_CLIENT_ID`、`CALENDAR_CLIENT_SECRET`、`CALENDAR_REFRESH_TOKEN`，支持自动刷新。

需自行在 HomeAgent 外取得具有读日历、创建及维护任务副日历能力的凭据；本实现没有
Google 登录授权流程。重复事件请求展开实例，全天事件按日历时区处理。未配置
`CALENDAR_TASKS_ID` 时自动创建 **HomeAgent Tasks**；显式配置时必须是独立副日历，
不能使用个人主日历。事件 ID 稳定，重复同步更新同一个任务提醒。

CalDAV 设置 `CALENDAR_PROVIDER=caldav`、`CALENDAR_URL`、`CALENDAR_USERNAME`、
`CALENDAR_PASSWORD`，并将 `CALENDAR_TIMEZONE` 设为个人日历的 IANA 时区（默认 UTC）。
集合 URL 必须 HTTPS（回环地址例外）且以 `/` 结尾。服务端需支持按 UTC 展开实例的
`calendar-query REPORT`；未展开重复规则或 floating time 会同步失败并安全关闭空闲推断。
如需回写，请先创建**独立任务集合**并设置 `CALENDAR_TASKS_URL`；不设置则只读。
回写使用 UTC iCalendar 事件；服务端返回 ETag 时使用并发前置条件。

有截止时间的未完成任务和高风险待审任务会回写独立任务日历；完成或移除提醒条件后，
删除对应事件。提醒为 transparent，不占用个人空闲时间。日历元数据不改变任务 revision
或租约。回写不修改个人事件，也不将外部日历编辑当成任务指令或审批决定。

## 看板与管理员 API

看板保留原有拖拽、移动端 Tab、冲突草稿保护，新增五列、项目／主管／Agent 视角、
Agent 能力条、风险／DDL 标签、目录感知派单、测试输出跳转与阻塞临时授权按钮。
非法执行者可见但灰显。新建派单等待 Agent 主动认领；原有拖到进行中的管理员动作
继续保持立即开始租约的行为。

`/api/kanban` 全部要求管理员会话，修改要求 CSRF。新增 `/agents` 和 `/calendar` 读取接口。
`/assignees?projectId=...` 返回合法 `assignees` 与附带合法性原因的全部 `agents`。
看板／列表查询使用 `projectId=~` 表示无目录，`projectId=*` 或省略表示全部；JSON
任务操作使用 `projectId: null`。`POST /tasks/:id/elevate` 接收项目、expectedRevision
与选定的 `scopes`，只作用于拥有确切负责人和目录的阻塞任务。

运行 `npm run verify`。Google/CalDAV 使用模拟响应测试；真实协议 v2 Runner 的本地
MCP 测试覆盖主管派单 → inbox → 认领 → 笔记缓存 → 提审 → 主管批准，不依赖外部账户。
