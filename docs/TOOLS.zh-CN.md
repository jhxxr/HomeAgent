# 工具与配置参考

[English](TOOLS.md) · **简体中文**

v0.3 新增的 13 个开发工具、命令别名/环境配置、批量编辑恢复和安全提交的完整说明见 [日常开发工作流](DEVELOPMENT_WORKFLOW.zh-CN.md)。v0.4 增加受控 Git 网络操作、Web 权限编辑器、统一 diff 模糊重定位、持久 Shell 会话与轻量 LSP 集成，当前共 **51 个 MCP 工具**。下列 v0.2 原有 API 继续保留；Git add 和 diff 的排除策略有所收紧。

## 权限组合

每次调用都必须满足客户端设备/项目范围、scope 和 Runner 本地项目策略。所有机器工具都要求 `projectId`；`deviceId` 可在只有一台有权限的在线设备时省略。Server 不能通过工具修改 Runner 配置。

| scope | 工具 | 本地额外条件 |
| --- | --- | --- |
| read | list_directory/read_file/read_files/search_files/get_file_info/get_edit_transactions/read_process_output/tail_process_output/wait_process/list_processes/list_shells/lsp_document_symbols/lsp_workspace_symbols/lsp_definition/lsp_references/lsp_hover/lsp_diagnostics/git_status/git_diff/git_log/git_branches | 项目存在，文件未被排除；进程与 Shell 会话必须属于当前主体 |
| write | write_file/create_directory/move_file/edit_block/edit_files/apply_unified_diff/recover_edit_transaction/save_project_note | `readOnly=false` |
| execute | start_process/run_command/write_process_input/stop_process/start_shell/run_shell/stop_shell | `readOnly=false`；启动时需满足程序名单/别名，或设备项目与客户端均允许全部程序 |
| git | git_add/git_commit/git_commit_paths/git_switch_branch/git_fetch/git_pull/git_push | `readOnly=false`，`allowGitWrite=true`；网络操作还需对应设备开关 |

`readOnly` 禁止所有写入和执行入口；对可写项目的 read token 仍不允许写入。`git` scope 不自动包含 read。新 OAuth grant 必须选择具体设备/项目，存入 `projectGrants[deviceId]`；新增项目不自动获得访问，刷新保持原范围。PAT 同时支持全局 `projects` 和设备限定 `projectGrants`，两者取交集。v0.1 旧 OAuth grant 需撤销重授权才能收紧。

### Web 权限的两层模型

设备配置是能力上限，客户端授权是调用主体的独立授权，最终权限取两者交集：

1. Dashboard 的设备编辑器修改每个项目的文件范围、命令执行模式、Git 本地写入、Git 网络 fetch/pull 和 Git push。
2. Dashboard 的客户端编辑器修改既有 PAT/OAuth 授权的设备、项目、scope、工具集合、设备范围文件和任意程序开关。
3. 临时设置带有分钟级到期时间。Server 和 Runner 都独立检查过期；在途调用和对应长任务会被停止，随后恢复永久权限。

`list_devices` 的项目 `commandMode` / `filesystemScope` 与 `get_project_context` 的项目字段均为当前客户端的有效策略。两者的 `executionPolicy` 提供 `configuredMode`、`effectiveMode`、`unrestrictedExecutionGranted`、`executeScopeGranted`、`readOnly` 和 `limitedBy`；`filesystemPolicy` 提供 `configuredScope`、`machineAccessGranted` 和 `limitedBy`。`limitedBy=project` 表示设备项目未开放对应能力，`authorization` 表示设备已开放但当前客户端未获授权，`null` 表示该能力两层均已开放；执行仍需满足 scope、工具集合和非只读等条件。`command_denied` / `path_escape` 错误也附带相应策略和修改位置。

设备项目目录、权限、命令别名和环境配置统一保存在 Server 上。本地不接受项目配置或权限开关；未收到并成功应用 Server 设置前，没有项目访问权限。断线、清空项目或配置应用失败均收回项目权限。`stateDir` 仍是被控端本机的凭据与任务目录。`homeagent check-config` 只检查本机连接设置，终端同步后显示实际应用目录。

## 文件工具

- `list_directory(path=".", offset=0, limit=200)`：每页最多 1000 项，流式枚举，不跟随链接。用 `nextOffset` 继续；扫描最多 100,000 项，源截断时不给伪 `nextOffset`。活目录变动可能造成重复/遗漏，页内排序不代表全目录快照。
- `read_file(path, offset=0, length=65536, expectedRevision?)`：最多 131,072 字节，返回 text/size/nextOffset/eof/revision；用 `revision` 继续读取可拒绝版本变化。`revision` 是 dev/inode/size/mtime/ctime 的摘要，不是上游完整内容快照。小于等于 1 MiB 时另返回完整内容 sha256。多字节字符边界可能显示替换字符；非文本文件不支持二进制编辑。
- `write_file(path, content, append=false, expectedSha256?)`：输入最多 262,144 个字符，结果最多 1 MiB，临时文件写入/fsync 后 rename；不自动创建缺失父目录。`expectedSha256` 不匹配则拒绝，防止静默覆盖旧版本。
- `create_directory(path)`：递归创建已验证路径内的目录。
- `move_file(source,destination)`：同项目内移动，拒绝覆盖目标及移动项目根；不允许跨项目移动。
- `get_file_info(path)`：大小、修改时间和文件/目录类型。
- `search_files(path=".",query,content=false,caseSensitive=false,limit=100,include=[],exclude=[],contextLines=0,respectGitIgnore=true)`：字面量匹配，支持 Node glob 过滤和最多 5 行上下文；Git 项目使用 tracked/untracked 非 ignored 源；非 Git 有界遍历并明确报告 ignore 未应用。最多约 10,000 路径、500 结果和 256 KiB 内容结果。
- `edit_block(path,oldText,newText,expectedSha256?)`：`oldText` 必须唯一精确匹配；同项目内修改序列化，不让两个客户端的内置修改相互交错。外部编辑器或运行中的命令仍可能并发修改，不能把应用锁当作文件系统事务。
- `apply_unified_diff(diff,expectedSha256,dryRun=false,fuzz=20,ignoreWhitespace=false)`：通过带恢复日志的编辑器应用文本 unified diff，支持 `fuzz`（0–200 行）有界上下文行重定位及 `ignoreWhitespace` 行首尾水平空白容错；当模糊窗口内出现多处匹配时以 `ambiguous_patch` 拒绝，并返回 `relocatedHunks` 记录偏移详情。严格 `fuzz: 0` 模式仍可用。

## 项目记忆与看板

### 本地辅助记忆

Runner 优先使用 `HOMEAGENT_WORKSPACE` 指定的记忆工作区；否则，在 `stateDir`
的父目录包含 `workspace.json` 时使用该目录；最后回退到 `~/.homeagent/workspace`。
记忆是可选的本地配置，这些工具不会创建或编辑记忆文件。项目规则放在
`memory/<projectId>/charter.md`（最多 8192 个 UTF-8 字节，明确返回 `truncated`），
踩坑提示通过 `memory/<projectId>/pitfalls/_index.json` 将普通文件名映射到规则：

```json
{
  "example.md": {
    "globs": ["src/**/*.ts"],
    "severity": "warning",
    "source": "本地项目笔记"
  }
}
```

将对应的 `example.md` 放在同一个 `pitfalls` 目录。索引键必须是普通文件名而非路径；
拒绝链接文件／目录及 Windows 路径别名。输入路径统一后使用 POSIX glob 匹配。
`read_file`、`write_file`、`edit_block`、`read_files`、`edit_files`、
`apply_unified_diff` 可以返回 `memoryHints`（最多三条，共享 4096 字节正文预算）。
`get_project_context(includeInstructions=true)` 会包含项目规则。记忆只是不可信的
辅助指导，不能授予权限；缺失或无效的记忆不会阻断文件操作。

### Server 端任务协作

六个工具都要求 `projectId`，并检查当前令牌的工具集合、scope 和按设备划分的项目授权。
它们只操作 Server 数据库，不访问 Runner 文件系统，因此允许使用获授权的离线设备，
但拒绝已吊销、暂停或未知设备。`kanban_list_tasks` 要求 `read`，其余看板工具要求
`write`。这里的 scope 只授予任务元数据权限，不代表可以修改 Runner 文件。同一项目 ID
的任务在获授权客户端之间共享，并非认领者私有。

- `kanban_list_tasks(status?)`：列出项目任务，可按状态过滤。
- `kanban_create_task(title,description="",targetPaths=[],requiresReview=true)`：创建待办任务。
- `kanban_claim_task(taskId,deviceId?)`：认领待办任务并取得 30 分钟租约；优先推断唯一
  获授权在线设备，没有在线设备时推断唯一获授权离线设备。有歧义时必须指定 `deviceId`。
  返回路径重叠提醒。
- `kanban_update_task(taskId,actualPaths?,message?)`：合并上报路径、添加进度消息并续租。
- `kanban_submit_review(taskId,proposedCommitMessage,aiSummary="",fileHashes={})`：
  保存审核证据并进入审核；不要求审核的任务直接完成。
- `kanban_complete_task(taskId,skipReview=false)`：完成审核中的任务；显式 `skipReview`
  也允许完成进行中的任务。不会自动创建 Git 提交。

活跃工具调用仅为认领身份、设备、项目都匹配且未过期的任务续租。仅有 Runner 心跳
不会持续占用无人处理的任务。成功的 `write_file`、`edit_block`、`edit_files`、
`apply_unified_diff`、`move_file` 会将路径记录到该工作者的进行中任务；失败、读取和
预演不会记录。Shell 命令和外部编辑器的变更不自动追踪。这些文件工具命中待审核路径时
还会返回辅助性 `reviewWarnings`；这不是强制文件锁，也不独立验证上报的哈希。

## LSP 与代码智能工具

- `lsp_document_symbols(path)`：提取源文件结构化符号（类、接口、类型、枚举、函数、方法、常量、变量等）、精确行列范围、文档注释与模块导入关系。
- `lsp_workspace_symbols(path=".",query?,kind?,exportedOnly=false,limit=100,respectGitIgnore=true)`：跨工作区检索符号定义，按精确匹配、前缀匹配和子串匹配排序。
- `lsp_definition(path,line?,column?,symbol?,respectGitIgnore=true)`：根据 1-based 行列坐标或符号名定位定义，支持当前文件、相对模块导入（含 TypeScript `.js` → `.ts` 映射及 Python 模块）与工作区导出符号跳转。
- `lsp_references(path,line?,column?,symbol?,includeDeclaration=true,contextLines=0,limit=100,respectGitIgnore=true)`：按标识符词边界查找整个工作区内的符号引用，自动过滤注释并区分声明、导入与普通引用。
- `lsp_hover(path,line?,column?,symbol?,respectGitIgnore=true)`：返回指定位置或名称符号的声明签名、提取的 JSDoc/Docstring 文档注释、定义位置与代码预览。
- `lsp_diagnostics(path?,limit=100,respectGitIgnore=true,serverExecutable?,serverArgs=[])`：在 `read` 权限下提供零外部进程的内置语法、JSON、TypeScript AST 与未解析相对导入诊断；传入 `serverExecutable` 时（需 `execute` 权限及命令策略允许）可通过 stdio JSON-RPC 2.0 查询外部语言服务器诊断。

路径可以是项目相对路径或项目内绝对路径。拒绝 `..` 越界、所有路径组件中的符号链接/Windows junction、硬链接普通文件，以及 `deniedNames`。Windows 额外拒绝设备保留名、NTFS alternate data streams 和尾随点/空格别名。

## 终端工具

`start_process(executable,args=[],cwd=".",timeoutMs=3600000)` 直接 spawn，不拼接 shell；超时范围 100 ms 到 24 小时。默认 `commands` 为空；可在 Dashboard 添加指定程序，或在设备项目与当前客户端授权中开启"允许全部程序"。指定程序匹配完整字符串，Windows 忽略大小写；推荐绝对路径，避免 PATH 劫持。解释器可位于项目外；项目外的 `cwd` 还需设备与客户端均允许设备范围路径。Windows .cmd/.bat 不会隐式启动 shell，直接拒绝；要执行 shell 必须允许 shell 可执行文件并承担其完整权限。

可选 `idempotencyKey`（8–128 字符）应由调用方生成并在不确定响应重试时保持不变。相同主体/项目/key 和相同 executable/args/规范化 cwd/timeout 返回原任务；冲突参数拒绝。准入先写 SQLite，再 spawn。48 小时内保留收据，已清理任务不会因此重跑；key 过期或换 key 后不再去重。不是所有文件/Git 操作的 exactly-once 保证。

子进程只继承 PATH、系统路径、HOME、TEMP、语言等有限环境变量，不继承 Server 密码或其他任意 token 环境变量。不提供由 MCP 任意注入环境变量的接口。编译环境需要的额外配置应在专用账户或可信启动器中定义。

自 v0.3 起可选择本机 `environmentProfiles` 名称与 `commandAliases` 别名；配置值和目标均由操作者事先授权，客户端不能传入任意 env 映射。`run_command`、`wait_process`、`tail_process_output` 提供短命令返回和长任务尾部观察。前段上限之外，另保留固定 64 KiB 尾部，因此超限后仍可看到最后错误，已丢弃中段不会伪装成完整日志。

返回 `id`（UUID），不是任意 OS PID。后续使用：

- `read_process_output(processId,cursor=0,length=65536)`：读取合并 stdout/stderr、nextCursor、state、exitCode、signal、finished、truncated。
- `write_process_input(processId,input,close=false)`：输入最多 65,536 个字符，`close=true` 发送 EOF。
- `list_processes()`：仅当前主体、当前项目的历史与运行任务。
- `stop_process(processId)`：先进入 `stopping` 并继续占槽，实际树结束后才终结。Linux 向组发 SIGTERM，超时 SIGKILL，leader 提前结束时也清理剩余组；Windows 用 suspended admission 的 Job Object supervisor 托管整个树，并通过 taskkill 停止 supervisor。
- `start_shell(shell?,cwd=".",timeoutMs=3600000,environment?)`：启动受 `Processes` 监管的持久状态化 Shell 会话（Windows 默认 `powershell.exe`，POSIX 默认 `sh`/`bash`，仍须满足命令允许列表或全部程序策略）。
- `run_shell(command,sessionId?,shell?,cwd=".",timeoutMs=3600000,environment?,waitMs=10000)`：在持久 Shell 会话中执行命令（省略 `sessionId` 时自动复用空闲会话或新建会话），跨命令保留工作目录（`cd`）与 Shell/环境变量，返回本次命令隔离后的 `output`、`exitCode` 和更新后的 `cwd`。
- `list_shells()` / `stop_shell(sessionId)`：查看当前项目的持久 Shell 会话状态（`ready`/`running`、当前 `cwd`、最近退出码）或终止会话及其进程树。

状态包括 starting/running/stopping/exited/failed/stopped/timed_out/interrupted。默认最多 8 个运行进程、单进程输出 8 MiB、约 500 个历史任务。Server 重连不重启任务，Runner 重启把未结束记录标记 interrupted。Windows supervisor 会在 Runner 死亡时终止其 Job；Linux 强制杀死 Runner 的清理由 systemd/容器负责。没有 PTY 或跨 Runner 的任务迁移。

Windows 需要系统 PowerShell/.NET 的 Add-Type 能力，使用本项目 `runtime/` 下独立编写的 C# 辅助代码；不下载二进制、不自动绕过组织执行策略。策略阻止或 Job assignment 失败时，任务失败关闭，不降级为无保护的进程树。

允许 `node`、`python`、`bash`、`powershell`、`npm`、`git` 或项目构建程序均可能执行任意本机代码。argv 结构只避免意外 shell 解析，不限制解释器功能。需要真正系统隔离时用低权限账户、容器/VM。

## Git 工具

默认 `project.root` 是普通独立 Git 仓库。自 v0.3 起，对已配置 `gitCommonDir` 的 linked worktree 提供校验后的支持；未配置仍拒绝 `.git` 文件，不支持一般 submodule 的任意 gitdir 指向。

- `git_status()`：porcelain v1。
- `git_diff(staged=false,path?)`：限制输出，禁用外部 diff、textconv 和子模块差异执行。
- `git_log(limit=20)`：最多 100 条，短 hash/时间/作者/标题。
- `git_add(paths)`：显式文件路径数组，最多 100 项，不接受目录（包括 `.`），关闭 pathspec magic；本地配置包含 clean/process filter 时拒绝写入。
- `git_commit(message)`：只提交已 stage 内容；禁用 hooks 和 GPG signing，不 push、不自动配置作者身份。

所有 Git 工具接受 `repository` 参数，表示项目根目录下的仓库相对目录，默认 `.`；绝对路径需要设备范围文件访问。普通 Git 工具禁用系统和全局 Git 配置、fsmonitor、外部 diff；网络 Git 使用本机 SSH 配置/凭据并只允许配置好的 HTTPS/SSH remote。输出上限 256 KiB，网络执行上限 35 秒，其他 Git 执行上限 20 秒。作者身份应预先通过 `git -C <project> config user.name ...` 和 `user.email` 在仓库内设置。没有任意 git 子命令接口，`reset --hard`、`clean`、force push 等不在工具集中。

`git_fetch(remote="origin",branch?)` 只获取已配置的 HTTPS/SSH remote。`git_pull` 要求 clean worktree，只做 fast-forward，不 rebase、merge、force 或递归 submodule。`git_push` 只把 HEAD 推送到一个分支，要求设备单独开启 push，不支持 force、删除、tag 或 arbitrary refspec。

这些限制降低隐式执行风险，但 Git 内部依然会读取其元数据。面对本机恶意用户能同时替换文件或仓库配置的威胁，需要 OS 隔离；项目根策略不能代替它。

## 管理与运维接口

浏览器必须登录并在所有修改请求提供 `X-CSRF-Token`（表单使用 `_csrf`）。Token 从 `/api/state` 获取，只属于当前浏览器 session。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /health | 健康与数据库探测，返回 Server `version` 与 `runnerProtocol` |
| GET | /api/state | 设备、客户端活动、最近审计、当前 CSRF，以及 Server `version`、`runnerProtocol` 和 Node/平台信息 |
| GET | /api/jobs?deviceId=UUID&projectId=ID&limit=200 | 有界持久任务元数据，最多 1000 项 |
| GET | /api/jobs/:deviceId/:id/output?cursor=0&length=65536 | 管理员按准确实例读取 Runner 输出，不保存到 Server |
| GET | /api/jobs/:deviceId/:id/output?view=tail&length=65536 | v0.3 引入的环形尾部；可用绝对 cursor 继续，返回覆盖提示 |
| POST | /api/jobs/:deviceId/:id/stop | 管理员停止准确实例的托管任务，动作以 admin 审计 |
| POST | /api/sessions/:id/revoke | 撤销管理员浏览器登录会话 |
| POST | /api/pair/inspect | 在批准前查看配对码对应设备名称和过期时间 |
| POST | /api/pair/approve | 核对并批准一次性配对码 |
| GET/POST | /pair/verify?id=UUID&token=短期凭据 | 已登录管理员通过 Runner 输出的浏览器链接批准设备配对 |
| POST | /api/devices/:id/pause,resume,revoke,rename | 设备管理 |
| POST | /api/devices/:id/permissions | 修改或清空设备项目权限；支持 `expectedRevision`、`durationMinutes` 和临时回退 |
| POST | /api/tokens | 创建范围化 PAT |
| POST | /api/tokens/:tokenId/revoke | 撤销令牌族；OAuth access 同时撤销客户端 |
| POST | /api/authorizations/:id/permissions | 修改现有 PAT/OAuth 授权的设备、项目、scope、工具和临时高级权限 |
| GET | /api/clients | 查看已注册 OAuth 客户端名称和回调 |
| POST | /api/clients/:id/revoke | 撤销 OAuth 客户端和其全部令牌 |
| GET | /api/audit?limit=100&before=毫秒时间戳&beforeId=UUID | 分页查看 JSON 审计 |

审计分页按 at、id 联合降序排列，把前一页最后一行的 at 和 id 分别传为 `before` 与 `beforeId`，可稳定遍历同毫秒内的多行。本版本 Dashboard 展示最近 100 条，API 单页最多 1000 条。
