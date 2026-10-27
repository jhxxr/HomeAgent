# WebCodex 源码对照审计

审计日期：2026-10-26。WebCodex 固定修订：`4ab06a5574792a86302dcd9a13bb4214ee09cc50`。HomeAgent 对照前基线为 v0.1；本文继续记录 v0.2/v0.3 的增量覆盖，初次公开仓库不保留开发期私有 Git 提交。

结论：前一版完成了远程 MCP 核心链路，但**不能称为 WebCodex 全量功能对等实现**。本轮按源码补齐了协议、任务可观察性、进程树生命周期、授权和重试等实际缺口；高级工作流、工具域和 Desktop 能力仍有明确差异。

v0.3 补充：已有项目上下文/交接、按行批量读、带恢复日志的多文件编辑、严格 unified diff、短命令等待、环形尾部、指定文件提交和显式 linked-worktree 支持。详见 [日常开发工作流](DEVELOPMENT_WORKFLOW.md)。这些提高了下述部分领域的覆盖，仍未实现全部上游产品域。

## 审计范围与证据

从上游 Git 修订取源码，不执行上游程序或安装脚本。清点了整个 Git 树的 2948 个文件条目、21 个 workspace crate 和根 Server；其中 `src/`、`crates/` 有 1539 个 Rust/C#/PowerShell 源文件。对协议、路由、认证、Job、文件边界、进程管理等关键执行路径进行了定点源码对照，**没有宣称逐行人工审查了全部文件或完成上游安全审计**。

工具侧以 `crates/webcodex-tool-contracts/src/tool_definition.rs` 为入口，覆盖全部 29 个定义模块，静态抽取 192 条工具声明，并与 App descriptor 名称交叉检查。这个数字包括隐藏声明与 feature-gated 声明，**不等于某个已编译 WebCodex Server 的 tools/list 数量**。

每条声明都记录工具名、文件、行号、上游固定链接、本项目对应工具、覆盖状态和差异说明：

- [逐工具完整清单](webcodex-source-inventory.json)
- [人工分类规则](webcodex-parity-map.json)
- [可复现清点脚本](../scripts/inventory-webcodex.mjs)

```sh
node scripts/inventory-webcodex.mjs --root data/reference/webcodex
```

脚本会检查基线修订、不认识的新工具域、失效的工具映射；默认把没有实现的声明明确标为 `missing`，不会因为存在一个通用执行命令工具就自动认定等价。

v0.3 当前静态分类：**7 条核心能力对应、31 条部分覆盖、154 条未实现**（v0.2 为 7/27/158）。这是对 WebCodex 额外产品域的逐声明比较，不是 HomeAgent 工具的“通过率”。`core-equivalent` 不表示全部参数/返回值或 Runner 二进制互通。

## 本轮找到并修正的实际遗漏

| 问题 | 上游代码证据 | HomeAgent 修正与验证 |
| --- | --- | --- |
| MCP 协议停留在 2025 | [`src/mcp/protocol.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/src/mcp/protocol.rs) 有 `2026-07-28` 与 `server/discover` | `src/server/mcp.ts` 改用官方 SDK v2 `createMcpHandler` / Node adapter，真实 v2 Client 固定 2026 协商并调用工具；同时保留 2025 客户端测试。 |
| 长任务没有 Server/Dashboard 观察域 | [`runner_protocol/transport.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-core/src/runner_protocol/transport.rs)、[`job_updates.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-runner-registry/src/job_updates.rs) | 增加 `job_update`、有界分页 `jobs_snapshot`、Server 元数据镜像、Dashboard 任务表、输出读取和停止接口。正文输出仍只留在 Runner。 |
| 断线或重连时状态含糊 | [`reconciliation.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-runner-registry/src/reconciliation.rs)、[`runner_job_receipt.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-core/src/runner_job_receipt.rs) | 任务绑定设备、Runner 实例、主体、项目、准入时间和单调 revision；拒绝身份改变与终态回退。离线为 unconfirmed，快照未报告为 missing，不能推断成功或重新执行。 |
| 停止请求过早变为终态 | [`runner_job_lifecycle.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-core/src/runner_job_lifecycle.rs) 区分 StopRequested 与 terminal | 增加 starting/stopping；真实 close 以后才写 stopped/timed_out/退出结果，停止期间仍占并发槽。 |
| 父进程退出后可能遗留子孙进程 | [`webcodex-process/src/lib.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-process/src/lib.rs)、[`unix.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-process/src/unix.rs)、[`windows.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-process/src/windows.rs) | Linux 在 leader exit 时清理原进程组；Windows 用独立编写的 C#/PowerShell supervisor，在 suspended 状态把子进程放入 Kill-on-close Job Object 后再运行，并监视 Runner 进程死亡。验证 leader 结束和 Runner 死亡场景。 |
| 不确定响应后重试会重复启动 | [`execution_admission.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-runner-registry/src/execution_admission.rs)、[`detached_job/store.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-runner/src/webcodex_runner/detached_job/store.rs) | `start_process.idempotencyKey` 按主体/项目隔离，准入先持久化，48 小时内同参数返回原任务，不同参数拒绝；历史已清理时保留拒绝重复执行的收据。这里只覆盖普通 tracked start，不冒充 detached supervisor。 |
| 缺少本机单实例保护 | 本项目运维加固，与上游完整 service/lifecycle 路径对照后补入 | `RunnerLock` 使用 SQLite OS 锁保护 stateDir，配对与 run 都互斥；不删除“疑似旧 PID”锁。实测另一个 OS 进程占锁及死亡后的自动释放。 |
| OAuth 只有设备选择，项目授权不够明确 | [`auth/project_credential.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/src/auth/project_credential.rs)、[`dispatch_fence.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-runner-registry/src/dispatch_fence.rs) | 新 OAuth grant 必须选择具体设备/项目，存 `projectGrants[deviceId]`。刷新保持原授权，新增项目、其他设备的同名项目不自动获得权限；Server 和 Runner 双重验证。 |
| 撤销只阻止新 HTTP，未取消排队调用 | 上游 dispatch fence 在准入与 dispatch 两处核对权限/目标 | Server 在 dispatch 再读凭据，令牌族撤销主动发送 cancel 给准确连接，排队的 Runner 工具检查 abort。已经发生的写入/外部副作用不可撤回，既有长任务需单独停止或撤销设备。 |
| 目录截断后无法继续，文件分页可混合新旧版本 | [`tool_definition/files.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-tool-contracts/src/tool_definition/files.rs) 的分页/read_revision 契约 | 目录增加 offset/nextOffset；read_file 增加 revision/expectedRevision、同句柄有界读取及读取前后版本检查。revision 是元数据版本，不等同于上游完整内容快照保证。 |
| Dashboard “会话”实际只有令牌 | 上游 [`webcodex-workflow-session`](https://github.com/yyjeqhc/webcodex/tree/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-workflow-session) 是独立业务域 | 界面改称“客户端授权与令牌”，新增真实管理员登录会话查看/撤销。明确仍未实现 Workflow Session。 |
| 运行身份与服务卸载诊断不完整 | [`webcodex-cli/.../runner_service.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-cli/src/webcodex_cli/runner_service.rs) | hello 保存版本/实例/工具能力；CLI 增加 --version/check-config；Windows 卸载先 End 再 Delete，避免只删除计划任务但旧进程继续运行。完整安装/重启验收仍另列。 |

另外修正了管理 API 未登录时的错误重定向、登录审计、限流器键容量上限，以及写临时文件失败后的清理路径。运行时借鉴架构与语义，未复制上游实现代码。

实测还补齐了“离线期间暂停、重连收到 403 后停止原任务”的路径；Dashboard 改为保持任务行与按钮，只刷新内容，避免周期刷新导致操作控件被替换。当前 Windows 25/25 回归通过，包含真正的跨进程锁、Windows Runner 死亡后的整个托管树清理和官方 2026/2025 客户端测试，环境详情见 [验证记录](VALIDATION.md)。

v0.2 功能基线的 Linux 回归为 24 通过、1 个 Windows 专用测试跳过、0 失败。两个 Docker target 构建及 Compose 持久化验收通过，重启后真实 Client 的 2026 与 2025 两种协议均能调用工具。

## 全部 29 个工具域的覆盖状态

| 上游域 | HomeAgent 状态 |
| --- | --- |
| discovery | 有设备、上下文/manifest/指令、Git/任务和交接摘要；无动态项目注册/创建、project_ref、Workbench、自适应发现。 |
| files | 有目录分页、字节/行范围、批量读取、globs/ignore/上下文、SHA；无 regex、多查询 batch 与上游完整 snapshot continuation。 |
| edits | 有恢复日志、预检、失败回滚、重启恢复和精确块编辑；无跨文件快照隔离、完整 range 编辑器。 |
| patches | 有严格文本 unified diff、创建/删除与版本校验；未实现 Codex Patch、模糊/二进制/rename/mode-only diff。 |
| git | 有指定文件安全提交、branch inspect/switch、显式 linked worktree；无冻结 review snapshot、hunk 游标和自动 worktree 注册/派生授权。 |
| jobs | 有短命令返回、任务等待、环形尾部、alias/profile；无 persistent-shell/PTY、detached supervisor、语义 readiness 和 Host continuation App。 |
| testing | 可执行明确允许的真实测试工具；无结构化 Rust/Go/Python 验证计划与测试计数证明。 |
| hygiene | 批量编辑可按摘要删除/回滚文件；无 Git restore/discard 等专用域。 |
| runner_config | 有本地 check-config；无远程 CAS/热重载。 |
| diagnostics | 有审计摘要；无上游详细 tool trace 和窗口活动聚合。 |
| sessions | **未实现 Workflow Session**、外部证据、handoff、closeout、Work Result App。浏览器 session 与它无关。 |
| artifacts | **未实现** 二进制制品流、Host 导入、跨项目传输、资源下载链接及表格 App。 |
| documents | **未实现** PDF App 阅读器。 |
| docx | **未实现** DOCX App 阅读器。 |
| resource_references | **未实现** 统一资源引用、Workbench。 |
| lsp | **未实现** 符号、hover、定义/引用、diagnostics、call hierarchy。 |
| skills | **未实现** 可信 Skill 来源、安装/版本/激活/执行。 |
| plugins | **未实现** Runner 本地 MCP provider gateway。 |
| ssh_resources | **未实现** 命名 SSH 资源及持久 SSH shell。允许 ssh 程序不算同等实现。 |
| coding_agents | **未实现** Codex/Claude 等 coding agent 的专用 run 域。 |
| communication | **未实现** Durable Agent、Conversation、Inbox、Endpoint、Host 自动续接。 |
| agent_tasks | **未实现** Agent Task/Attempt。 |
| agent_waits | **未实现** any/all fan-in 与 wake。 |
| goals | **未实现** 持久 Goal 与计划 App。 |
| memory | **未实现** 记忆存储/检索/清理域。 |
| computer | **未实现** 桌面观察/控制/截图/剪贴板。 |
| browser | **未实现** 浏览器观察/控制。 |
| checkpoints | **未实现** workspace checkpoint；上游为可选 feature。 |
| code_mode | **未实现** V8 Code Mode；上游为可选 feature。 |

## 非工具模块没有遗漏为“已实现”

| 上游模块 | 本项目对应或差异 |
| --- | --- |
| 根 Server、core、tool-contracts、tool-runtime-contracts | TS shared/server/runner 实现核心路由和策略；不复刻全部业务类型和工具协议。 |
| runner、runner-registry | 主动 WSS、本机执行、请求/实例隔离、任务镜像；无 QUIC、HTTP polling fallback、动态 inventory registry。 |
| process、persistent-shell | 进程组/Windows Job Object 已补；persistent-shell、PTY、SSH framing 未实现。 |
| store、admin | SQLite、OAuth/PAT、配对、单管理员 Dashboard/会话；无多用户、shared-key group、ProjectGrant 管理产品与 emergency bootstrap 域。 |
| workspace、validation | 根目录策略、读写、Git 与真实工具链可用；无 recipe、managed worktree、结构化验证、检查点和完整制品域。 |
| cli、environment、build-info、runner-config | 有 login/run/service/check-config/version 和 Docker；没有原生统一安装包、升级/回滚、所有平台恢复流程和完整 Git 构建指纹。 |
| workflow-session | 未实现，不能用 MCP stateless 或浏览器 session 代替。 |
| browser、computer、lsp、code-mode | 未实现。 |
| openai-tunnel | 无此专用 Host tunnel；提供 Caddy/Nginx/可选 Cloudflare。运行链路不依赖第三方中继。 |
| apps/desktop | 无 Tauri Desktop 产品；用 Web Dashboard 管理核心范围。 |

## 原始目标与后续扩展的边界

原需求中的 Server/Runner 主动连接、标准远程 MCP、配对、设备撤销、多设备路由、项目权限、文件/终端/Git、长任务观察、审计、Dashboard、Compose 与 Linux/Windows 路径已经有实际实现及回归测试。

若要进一步成为 WebCodex 功能对等替代品，后续仍需：完整 Workflow Session/证据、持久 shell/PTY、跨 Runner 重启的 detached supervisor、二进制制品通道、自动 worktree 注册/派生授权、冻结审查与结构化验证；之后是 LSP、Skill/provider、Agent/Goal/协作与 Desktop/Browser。v0.3 已有的交接说明、多文件恢复编辑、严格文本 diff 和现有 worktree 支持不冒充这些完整域，**也不以通用命令能够运行某程序来替代专用域实现**。

Windows 自启动仍是用户登录触发的计划任务，不是无人登录的系统服务。真实 AI 客户端账户、HTTPS/反代与安装后的系统重启验收也不能由单元测试代替。详见 [验证记录](VALIDATION.md)。
