# 验证记录

日期：2026-10-26。测试使用临时目录、临时凭据和项目自己的 MCP SDK 客户端，不使用真实项目密钥。

本文件保留首次公开源码前的本地与临时 Linux 环境验证事实。Git 历史已为公开发布整理，下面用版本标识历史记录，不引用旧私有提交号；没有把本地测试称作公开仓库已经执行的 CI。当前准备发布的源码以初始公开提交和源码归档 manifest 为准。

## 开源与 Release 发布准备

2026-10-26，本地 Windows Node 24.14.1：完整 verify 的 **39 项测试全部通过**，其中包括版本标签/注入参数拒绝和 changelog 版本段提取；类型检查、构建、发布文件/敏感模式/本地链接检查通过。生产依赖 audit 为 0 个已知漏洞，许可证报告覆盖 99 个锁定的生产包并通过一致性检查。

另将初始公开提交生成的源码 tar.gz 解压到仓库外的全新目录，核对 SHA-256 与归档路径后执行 `npm ci`、完整 `npm run verify`、许可证检查和生产依赖 audit，**39/39 通过、0 跳过**。在该私有测试副本中建立真实的 annotated `v0.3.0` 标签，标签/提交/版本校验、对应 changelog 发布说明生成和再次源码打包均成功。公开项目本身未创建或推送版本标签。

CI 与 release 两份 workflow 已通过 **actionlint 1.7.12** 静态校验。自动发布仅在版本标签推送或针对现有标签的手动触发后运行；本次源码归档验证时尚未绑定公开远程仓库，因此没有宣称在线 Release 发布已经执行。新的 Dockerfile 额外复制了许可证文件，需在公开 CI 实际构建验证。

旧 Git 历史、运行数据、测试凭据和参考源码被移出发布目录保存在本地私有备份；源码包只来自新的公开 HEAD。许可证、贡献说明、双语入口及依赖声明包含在发布范围内。

## npm CLI 与 Token 发布准备

2026-10-26，本地 Windows Node 24.14.1、npm 11.12.1：改用 `homeagent-mcp` 包名，增加三个 CLI 入口与发布文件白名单。完整类型检查、构建、**39/39** 测试、发布文件检查及 99 个生产依赖许可证报告一致性检查通过；CI/release 再次通过 actionlint 1.7.12。

将真实 npm tgz 全局安装到隔离的临时 prefix 后，三个 Windows `.cmd` 命令的版本与帮助、Server/Runner 初始化及拒绝覆盖、Runner 配置检查均通过。使用已安装包创建私有 `.env` 并启动真实 Server，`/health` 版本、Dashboard JS/CSS 和未认证 `/mcp` 返回 401 均通过；测试未改动本机全局 npm 安装。

工作流已接入 `NPM_TOKEN`，可切换 OIDC，并支持 npm 已成功、GitHub Release 未完成时按 tarball integrity 验证后恢复。该链路尚未用真实 npm 账号在线发布；Linux 安装包与 Docker 验证由更新后的 CI 执行。本机 GitHub CLI 安装与账号登录属于本地开发配置，不包含在 npm 归档中。

首次公开 CI 的 Linux 测试、npm 安装包实测及 Docker 构建/Compose 健康检查通过。Windows 暴露了测试夹具绕过生产配置路径规范化的问题：CI 临时目录带别名，触发 `root_changed` 检查。测试夹具已改为先 `realpath`，并为 Job Object 退出后的临时目录句柄释放添加有界清理重试。额外在 Windows 上将 TEMP/TMP 指向 junction 别名，确认确实存在原始路径与规范路径差异，再执行全部 **39/39 测试通过**；生产目录权限检查保持原有实现。

后续 Windows CI 对照确认，Windows PowerShell 在移除 `PSModulePath` 的过滤环境中启动监督器会卡住；仅补回模块路径即可运行。Runner 现显式设置系统内置模块目录，PowerShell 可补充机器级 Program Files 模块目录；默认不继承用户/项目模块加载路径。新增真实子进程回归验证 npm 凭据不继承、模块目录仅来自这些机器级位置，CI 增加同一生产环境函数的监督器启动检查。源码发布扫描也增加 npm Token 模式，并以合成值验证拒绝行为及诊断不回显 Token。

## v0.3.0 日常开发体验

本轮新增 13 个工具，合计 32 个，详见 [开发工作流](DEVELOPMENT_WORKFLOW.md)。Windows Node 24.14.1 的回归覆盖以下开发场景，最终执行计数在本节末记录：

- 官方 MCP 2026 Client 的 Node 项目完整场景：失败测试、项目上下文、忽略规则搜索、批量读、两文件 Diff、复测、安全提交、保留用户已有暂存、交接与 Server 重启后的恢复。该场景使用 10 次工作流工具调用。
- 真正启动本机 Python unittest，观察失败，经摘要校验编辑后复测通过。
- 多文件预检/dry-run、失败回滚、外部修改冲突保留、私有 journal 的启动恢复。
- 严格 unified diff 的多文件、CRLF、no-newline、错位上下文拒绝。
- 命令别名和本机环境 profile；短命令直接返回与取消等待不杀任务。
- 输出超出 prefix 上限后末尾报错仍在 rolling tail，绝对 cursor 明确报告覆盖。
- 精确文件提交、旧 HEAD/旧文件摘要/选中路径已有暂存拒绝，未吞入用户其他暂存条目。
- linked worktree 的 common-dir 显式授权，干净分支切换与脏工作区拒绝。
- Runner 配置文件位于暴露项目内时拒绝加载，防止 read-only 文件权限读取私有环境 profile。

这证明了工具与协议的确定性串联，尚未登录真实 AI 客户端衡量模型自主完成率。

本轮 Windows 最终执行 **37/37 通过、0 跳过、0 失败**，类型检查、构建、Dashboard JS 语法和 npm 生产依赖 audit（0 已知漏洞）通过。另在 Chrome 155 实测 prefix 仅保留 65536 字节、总输出 150018 字节的失败任务，Dashboard 读取 tail 仍显示末尾 FINAL_BUILD_ERROR；390px 视口宽度与页面宽度相同，控制台无 error/warn。测试设备已撤销、浏览器已退出。

Linux/Docker 对 v0.3.0 功能基线复验：Linux x86_64、Node **24.22.1**、Python **3.11.2**、Docker Engine **29.8.2**、Compose **5.6.0**。

- **37 项测试，36 通过、1 跳过、0 失败**；唯一跳过为 Windows 专用 Job Object 测试，Node 与 Python 编码场景都真正执行通过。
- relay/runner 两个生产 target 均构建成功。Python 只加入一次性测试派生镜像，生产 runner 镜像仍按部署文档保持 Node/Git 基础环境。
- Compose 健康检查、配对、PAT 签发、无认证 MCP 返回 401，通过。实际 UID=1000。
- down/up 保留卷后，2026 与 2025 两种真实 SDK Client 均发现 32 个工具并调用成功，设备和凭据持久化正确。
- 测试 project 的容器/卷及测试凭据文件在验收后清理，机器恢复原暂停状态；源代码与无凭据测试日志保留于独立测试目录。

## v0.2.0 源码对照后的回归

WebCodex 对照基线、每条工具声明的映射及尚未移植的领域见 [源码审计](WEBCODEX_CODE_AUDIT.md)。本轮并非全量功能对等验收。

Windows Node 24.14.1 已执行类型检查、构建、JS 语法检查和 **25/25** 回归测试；npm 生产依赖审计为 0 个已知漏洞。新增验证覆盖：

- 官方 SDK v2 客户端固定协商 MCP 2026-07-28，经 server/discover 与逐请求 envelope 列表/调用工具，同时兼容 v1/2025 客户端；错误版本拒绝。
- 目录分页可完整遍历，文件版本变化时分页续读拒绝。
- 稳定 idempotencyKey 的并发启动/重试/Runner 重启仅执行一次，参数冲突拒绝。
- 真正不同 OS 进程的 stateDir 互斥、进程死亡后的自动锁释放。
- leader 先结束时子孙进程清理；Windows Runner 强制退出时 supervisor 和 Job Object 内的后代均终止。
- Dashboard 任务元数据、输出读取与停止、Server 不持久化输出、浏览器登录会话查看及撤销。
- 准确设备/项目授权不扩展到另一个设备的同名项目；OAuth 刷新保持授权。
- 任务 owner/project/准入时间、revision、终态校验；令牌撤销取消在途调用并拒绝下一次 dispatch。
- 断线期间设备被暂停，Runner 重连收到 403 后停止既有托管任务。

Chrome 155 实测新版登录 → 任务出现 → 点击读取输出 → 点击停止 → 最终状态 stopped，并观察到 admin 调用审计。自动刷新保持任务按钮，不再不断替换 DOM；390px 手机模拟没有页面横向溢出，控制台没有 error/warn。测试设备凭据已撤销，浏览器已退出。

Linux/Docker 对 v0.2.0 功能基线复验，环境为 Linux x86_64、Node **24.22.1**、Docker Engine **29.8.2**、Compose **5.6.0**：

- relay/runner 两个 Docker target 构建成功；Linux 类型检查、构建、生产依赖 audit 通过。
- 测试共 25 项：**24 通过、1 跳过、0 失败**。唯一跳过项为 Windows 专用 Runner 死亡/Job Object 检查；同项已在 Windows 本机通过。
- Compose 启动健康，`/health` 返回版本 **0.2.0**；无凭据 `/mcp` 返回 401；容器实际 UID 为 1000。
- 完成部署后配对和 scoped PAT 签发；Compose down/up 保留数据卷后，真实官方 v2 Client 分别使用固定 `2026-07-28` 和 legacy 模式列工具/调用 `list_devices`，设备和凭据都仍有效。
- 测试结束，独立 Compose project 的容器和卷均为空；仅删除本次独立测试目录中的 .env 与 smoke-state.json，保留不含凭据的构建/测试日志，未修改其他项目。

下方 v0.1 结果保留为历史记录。

## Windows 本机

环境：Windows、Node.js 24.14.1、npm 11.12.1、Git。已执行：

```text
npm run check
npm run build
npm test
npm audit --omit=dev --audit-level=high
```

v0.1 的 14 组测试覆盖：

1. 一次性配对批准/领取/防重放、真正的 SDK initialize/tools/list/tools/call。
2. 多设备路由歧义拒绝、设备/项目/scopes 限制、暂停/恢复/撤销、令牌撤销及内容不进入审计。
3. OAuth discovery、DCR、PKCE、浏览器授权状态、resource 绑定、code 单次消费、refresh 轮换和重放撤销。
4. Server 重启后凭据仍有效，原 Runner 的长任务继续执行并可读取完整结果。
5. HTTP URL 与配置拒绝规则、传输转义后的结果大小限制。
6. 审计同毫秒记录的稳定分页。
7. WS 认证、hello 就绪、跨设备伪造结果拒绝与调用取消。
8. 文件写入/追加/分页/移动/搜索/精确编辑、stale SHA 拒绝、只读权限。
9. 越界、符号链接/Windows junction、硬链接、Windows ADS 与保留名拒绝。
10. stateDir 与项目隔离。
11. 进程 allowlist、argv、不同行为主体隔离、输出截断和完成记录持久化。
12. stdin、整树终止、超时可观察。
13. Git status/diff/log/add/commit、禁用写入与直接/间接配置的 clean/process filter 拒绝。
14. 并发启动不能超过本机进程限额。

生产依赖 npm 官方 advisory 检查为 **0 个已知漏洞**；这只表示当次 registry 已知漏洞结果，不代表没有未知漏洞。

另外通过编译后的 CLI 和 Chrome 155 执行了真实浏览器流程：登录 → 配对码核对/批准 → Windows Runner 凭据保存 → Runner 上线 → 创建 scoped PAT → `/mcp` 文件写入/读取与进程启动。桌面 1440px 和手机模拟 390px 已检查布局，无页面横向溢出；手机表格在自身容器内滚动。最后页面控制台无 error/warn。刷新后一次展示的 PAT 已隐藏。

浏览器验证发现并修复了 `Referrer-Policy: no-referrer` 导致表单 Origin=null 的问题，以及自动刷新替换设备选择控件的问题。现在使用 same-origin 策略，不放宽跨 Origin 验证。

使用 `scripts/backup.mjs` 对运行中的测试 SQLite 执行过在线备份。生产恢复仍需在自己的存储与权限环境演练。

## Linux 与 Docker 实机

在临时 Linux x86_64 机器的独立目录，使用 v0.1.0 已提交源码基线执行；发布内容不包含当时的私有配置、数据库、访问凭据或测试机信息。

环境：Docker Engine **29.8.2**、Compose **5.6.0**，测试容器 Node.js **24.22.1**。

- Dockerfile 的 relay、runner 两个 target 都实际构建成功。
- 在 runner 镜像中安装开发依赖，`npm run check`、同一套 **14/14** 测试和生产依赖 audit 全部通过。
- 使用独立 Compose project 启动非 root Server，健康检查通过；访问 `/health` 返回 `{"status":"ok","version":"0.1.0"}`。
- 未认证 `/mcp` 返回 401。
- 通过部署后的 HTTP API 完成管理员登录、配对批准/领取、scoped PAT 创建。
- `docker compose down` 后不删除卷，再 `up --wait`，原设备记录和客户端凭据仍可通过 MCP `list_devices` 读取。
- 容器内实际 `process.getuid()` 为 **1000**。
- 最终停止本次创建的 Compose 项目并删除测试卷，检查没有遗留该测试项目的容器；未删除或改动机器上其他项目。

非默认映射端口的第一次手动探测使用了与 PUBLIC_URL 不同的 Host，按配置返回 403；使用 PUBLIC_URL 的 `localhost` 后通过。这是预期 Host 边界，反代必须保留配置域名。

## 尚未进行的环境验收

仓库提供 Linux/Windows CI 与 Docker 构建/Compose 健康检查工作流，尚未推送远程触发。Linux systemd、Windows Task Scheduler 安装/卸载和重启持久性未执行，以免修改测试机或开发机的登录任务和服务。

没有登录真实 ChatGPT、Claude 或 Cursor 账户做交互验收。客户端文档引用 2026-10-26 查到的官方指南；协议与 OAuth 链路使用真实 SDK 和 HTTP/WS 自动化测试。域名、证书、反向代理和可选 Cloudflare Tunnel 需在最终部署环境验证。

## 发布边界

这是包含实用功能、权限策略、运维文件和自动化验证的初始版本。没有独立安全审计、长时间压力测试、多租户或完整 OS 沙箱。面对恶意仓库或不可信命令，必须使用专用系统账户或容器/VM，不应在高权限日常账户中暴露生产凭据。
