# 工具与配置参考

v0.3 新增的 13 个开发工具、命令别名/环境配置、批量编辑恢复和安全提交的完整说明见 [日常开发工作流](DEVELOPMENT_WORKFLOW.md)。v0.4 增加受控 Git 网络操作和 Web 权限编辑器，当前共 35 个 MCP 工具。下列 v0.2 原有 API 继续保留；Git add 和 diff 的排除策略有所收紧。

## 权限组合

每次调用都必须满足客户端设备/项目范围、scope 和 Runner 本地项目策略。所有机器工具都要求 projectId；deviceId 可在只有一台有权限的在线设备时省略。Server 不能通过工具修改 Runner 配置。

| scope | 工具 | 本地额外条件 |
| --- | --- | --- |
| read | list_directory/read_file/search_files/get_file_info/read_process_output/list_processes/git_status/git_diff/git_log | 项目存在，文件未被排除；进程必须属于当前主体 |
| write | write_file/create_directory/move_file/edit_block | readOnly=false |
| execute | start_process/write_process_input/stop_process | readOnly=false；启动时 executable 必须在 commands 内 |
| git | git_add/git_commit/git_commit_paths/git_switch_branch/git_fetch/git_pull/git_push | readOnly=false，allowGitWrite=true；网络操作还需对应设备开关 |

`readOnly` 禁止所有写入和执行入口；对可写项目的 read token 仍不允许写入。git scope 不自动包含 read。新 OAuth grant 必须选择具体设备/项目，存入 `projectGrants[deviceId]`；新增项目不自动获得访问，刷新保持原范围。PAT 同时支持全局 projects 和设备限定 projectGrants，两者取交集。v0.1 旧 OAuth grant 需撤销重授权才能收紧。

### Web 权限的两层模型

设备配置是能力上限，客户端授权是调用主体的独立授权，最终权限取两者交集：

1. Dashboard 的设备编辑器修改每个项目的文件范围、命令执行模式、Git 本地写入、Git 网络 fetch/pull 和 Git push。
2. Dashboard 的客户端编辑器修改既有 PAT/OAuth 授权的设备、项目、scope、工具集合、设备范围文件和任意程序开关。
3. 临时设置带有分钟级到期时间。Server 和 Runner 都独立检查过期；在途调用和对应长任务会被停止，随后恢复永久权限。

设备项目目录、权限、命令别名和环境配置统一保存在 Server 上。本地不接受项目配置或权限开关；未收到并成功应用 Server 设置前，没有项目访问权限。断线、清空项目或配置应用失败均收回项目权限。stateDir 仍是被控端本机的凭据与任务目录。homeagent check-config 只检查本机连接设置，终端同步后显示实际应用目录。

## 文件工具

- `list_directory(path=".", offset=0, limit=200)`：每页最多 1000 项，流式枚举，不跟随链接。用 nextOffset 继续；扫描最多 100000 项，源截断时不给伪 nextOffset。活目录变动可能造成重复/遗漏，页内排序不代表全目录快照。
- `read_file(path, offset=0, length=65536, expectedRevision?)`：最多 131072 字节，返回 text/size/nextOffset/eof/revision；用 revision 继续读取可拒绝版本变化。revision 是 dev/inode/size/mtime/ctime 的摘要，不是上游完整内容快照。小于等于 1 MiB 时另返回完整内容 sha256。多字节字符边界可能显示替换字符；非文本文件不支持二进制编辑。
- `write_file(path, content, append=false, expectedSha256?)`：输入最多 262144 个字符，结果最多 1 MiB，临时文件写入/fsync 后 rename；不自动创建缺失父目录。expectedSha256 不匹配则拒绝，防止静默覆盖旧版本。
- `create_directory(path)`：递归创建已验证路径内的目录。
- `move_file(source,destination)`：同项目内移动，拒绝覆盖目标及移动项目根；不允许跨项目移动。
- `get_file_info(path)`：大小、修改时间和文件/目录类型。
- `search_files(path=".",query,content=false,caseSensitive=false,limit=100,include=[],exclude=[],contextLines=0,respectGitIgnore=true)`：字面量匹配，支持 Node glob 过滤和最多 5 行上下文；Git 项目使用 tracked/untracked 非 ignored 源；非 Git 有界遍历并明确报告 ignore 未应用。最多约 10000 路径、500 结果和 256 KiB 内容结果。
- `edit_block(path,oldText,newText,expectedSha256?)`：oldText 必须唯一精确匹配；同项目内修改序列化，不让两个客户端的内置修改相互交错。外部编辑器或运行中的命令仍可能并发修改，不能把应用锁当作文件系统事务。

路径可以是项目相对路径或项目内绝对路径。拒绝 `..` 越界、所有路径组件中的符号链接/Windows junction、硬链接普通文件，以及 deniedNames。Windows 额外拒绝设备保留名、NTFS alternate data streams 和尾随点/空格别名。

## 终端工具

`start_process(executable,args=[],cwd=".",timeoutMs=3600000)` 直接 spawn，不拼接 shell；超时范围 100 ms 到 24 小时。默认本机 commands 为空，必须显式允许。可执行文件匹配完整字符串，Windows 忽略大小写；推荐绝对路径，避免 PATH 劫持。Windows .cmd/.bat 不会隐式启动 shell，直接拒绝；要执行 shell 必须显式允许 shell 可执行文件并承担其完整权限。

可选 `idempotencyKey`（8–128 字符）应由调用方生成并在不确定响应重试时保持不变。相同主体/项目/key 和相同 executable/args/规范化 cwd/timeout 返回原任务；冲突参数拒绝。准入先写 SQLite，再 spawn。48 小时内保留收据，已清理任务不会因此重跑；key 过期或换 key 后不再去重。不是所有文件/Git 操作的 exactly-once 保证。

子进程只继承 PATH、系统路径、HOME、TEMP、语言等有限环境变量，不继承 Server 密码或其他任意 token 环境变量。不提供由 MCP 任意注入环境变量的接口。编译环境需要的额外配置应在专用账户或可信启动器中定义。

v0.3 可选择本机 environmentProfiles 名称与 commandAliases 别名；配置值和目标均由操作者事先授权，客户端不能传入任意 env 映射。run_command、wait_process、tail_process_output 提供短命令返回和长任务尾部观察。前段上限之外，另保留固定 64 KiB 尾部，因此超限后仍可看到最后错误，已丢弃中段不会伪装成完整日志。

返回 `id`（UUID），不是任意 OS PID。后续使用：

- `read_process_output(processId,cursor=0,length=65536)`：读取合并 stdout/stderr、nextCursor、state、exitCode、signal、finished、truncated。
- `write_process_input(processId,input,close=false)`：输入最多 65536 个字符，close=true 发送 EOF。
- `list_processes()`：仅当前主体、当前项目的历史与运行任务。
- `stop_process(processId)`：先进入 stopping 并继续占槽，实际树结束后才终结。Linux 向组发 SIGTERM，超时 SIGKILL，leader 提前结束时也清理剩余组；Windows 用 suspended admission 的 Job Object supervisor 托管整个树，并通过 taskkill 停止 supervisor。

状态包括 starting/running/stopping/exited/failed/stopped/timed_out/interrupted。默认最多 8 个运行进程、单进程输出 8 MiB、约 500 个历史任务。Server 重连不重启任务，Runner 重启把未结束记录标记 interrupted。Windows supervisor 会在 Runner 死亡时终止其 Job；Linux 强制杀死 Runner 的清理由 systemd/容器负责。没有 PTY 或跨 Runner 的任务迁移。

Windows 需要系统 PowerShell/.NET 的 Add-Type 能力，使用本项目 runtime/ 下独立编写的 C# 辅助代码；不下载二进制、不自动绕过组织执行策略。策略阻止或 Job assignment 失败时，任务失败关闭，不降级为无保护的进程树。

允许 `node`、`python`、`bash`、`powershell`、`npm`、`git` 或项目构建程序均可能执行任意本机代码。argv 结构只避免意外 shell 解析，不限制解释器功能。需要真正系统隔离时用低权限账户、容器/VM。

## Git 工具

默认 project.root 是普通独立 Git 仓库。v0.3 对已配置 gitCommonDir 的 linked worktree 提供校验后的支持；未配置仍拒绝 .git 文件，不支持一般 submodule 的任意 gitdir 指向。

- `git_status()`：porcelain v1。
- `git_diff(staged=false,path?)`：限制输出，禁用外部 diff、textconv 和子模块差异执行。
- `git_log(limit=20)`：最多 100 条，短 hash/时间/作者/标题。
- `git_add(paths)`：显式文件路径数组，最多 100 项，不接受目录（包括 `.`），关闭 pathspec magic；本地配置包含 clean/process filter 时拒绝写入。
- `git_commit(message)`：只提交已 stage 内容；禁用 hooks 和 GPG signing，不 push、不自动配置作者身份。

所有 Git 工具接受 `repository` 参数，表示项目根目录下的仓库相对目录，默认 `.`；绝对路径需要设备范围文件访问。普通 Git 工具禁用系统和全局 Git 配置、fsmonitor、外部 diff；网络 Git 使用本机 SSH 配置/凭据并只允许配置好的 HTTPS/SSH remote。输出上限 256 KiB，网络执行上限 35 秒，其他 Git 执行上限 20 秒。作者身份应预先通过 `git -C <project> config user.name ...` 和 user.email 在仓库内设置。没有任意 git 子命令接口，reset --hard、clean、force push 等不在工具集中。

`git_fetch(remote="origin",branch?)` 只获取已配置的 HTTPS/SSH remote。`git_pull` 要求 clean worktree，只做 fast-forward，不 rebase、merge、force 或递归 submodule。`git_push` 只把 HEAD 推送到一个分支，要求设备单独开启 push，不支持 force、删除、tag 或 arbitrary refspec。

这些限制降低隐式执行风险，但 Git 内部依然会读取其元数据。面对本机恶意用户能同时替换文件或仓库配置的威胁，需要 OS 隔离；项目根策略不能代替它。

## 管理与运维接口

浏览器必须登录并在所有修改请求提供 `X-CSRF-Token`（表单使用 `_csrf`）。Token 从 `/api/state` 获取，只属于当前浏览器 session。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /health | 健康与数据库探测 |
| GET | /api/state | 设备、客户端活动、最近审计、当前 CSRF |
| GET | /api/jobs?deviceId=UUID&projectId=ID&limit=200 | 有界持久任务元数据，最多 1000 项 |
| GET | /api/jobs/:deviceId/:id/output?cursor=0&length=65536 | 管理员按准确实例读取 Runner 输出，不保存到 Server |
| GET | /api/jobs/:deviceId/:id/output?view=tail&length=65536 | v0.3 环形尾部；可用绝对 cursor 继续，返回覆盖提示 |
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

审计分页按 at、id 联合降序排列，把前一页最后一行的 at 和 id 分别传为 before 与 beforeId，可稳定遍历同毫秒内的多行。本版本 Dashboard 展示最近 100 条，API 单页最多 1000 条。
