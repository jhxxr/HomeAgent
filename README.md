# HomeAgent

简体中文 · [English](README.en.md)

**MIT 开源 · v0.3.0 早期版本 · Linux / Windows · 自托管**

自托管的远程 MCP 系统，让 Claude、ChatGPT、Cursor 等客户端通过你的 Server 操作你自己的开发机器。Runner 只主动连出，不监听本地端口。运行不需要模型 API Key、第三方中继、遥测或付费云服务；可以部署在自己的服务器或局域网内。

目前实现单管理员、多设备，使用 MCP 官方 SDK v2 的 Streamable HTTP `/mcp`（2026-07-28 discovery/envelope 与 2025 兼容）、带认证的 WebSocket Runner 通道、SQLite 持久化、OAuth 2.1 风格的授权码流程与 S256 PKCE、一次性设备配对和 Web Dashboard。源码独立实现，没有直接复制两个参考项目的工具核心。

```text
Claude / ChatGPT / Cursor
       │ MCP over HTTPS + OAuth / scoped Bearer token
       ▼
HomeAgent Server ── SQLite / Dashboard / audit
       ▲
       │ outbound WSS, authenticated device connection
       │
Runner on Linux / Windows
       ├─ project policy → files / search / exact edits
       ├─ executable allowlist → tracked subprocesses
       └─ Git → status / diff / log / add / commit
```

## 快速开始

需要 Node.js 24（推荐 24.22.1 或更新的 24 LTS 补丁版，最低 24.14.0）、npm、Git。服务器另有 Docker Compose 部署方式。

版本发布到 npm 后，可以直接安装 CLI：

```sh
npm install -g homeagent-mcp
homeagent init-runner
# 编辑 ~/.homeagent/runner.json：设置 Server 地址和实际项目根目录
homeagent-runner pair --config /absolute/private/runner.json
homeagent-runner run --config /absolute/private/runner.json
```

`homeagent init` 在当前目录生成 Server `.env`，`homeagent-server` 加载该文件并启动 Server。初始化命令拒绝覆盖已有配置；Runner 配置必须位于暴露项目之外。运行 `homeagent --help` 查看命令。下面是从源码安装的方式：

```sh
npm ci
npm run build
npm run init
npm run server
```

打开 `http://localhost:3210`。管理员密码在本地 `.env` 的 `ADMIN_PASSWORD` 中；生成命令不会把密码打印到终端。

将 `runner.example.json` 复制到用户私有目录，例如 Linux 的 `~/.homeagent/runner.json` 或 Windows 的 `%USERPROFILE%/.homeagent/runner.json`，把 `projects[0].root` 改为实际项目绝对路径。Runner 配置和 stateDir 都必须位于所有暴露项目之外。Windows JSON 路径可用 `E:/Projects/my-app`。

```sh
npm run runner -- pair --config /absolute/private/runner.json
# 在 Dashboard 输入 Runner 打印的配对码，核对设备名后批准
npm run runner -- run --config /absolute/private/runner.json
```

命令中的 `/absolute/private/runner.json` 替换为自己的配置路径。默认 `commands: []`、`commandAliases: {}`，不允许启动命令；文件写入由项目 `readOnly` 和客户端 `write` 权限共同控制。需要命令执行时，显式配置允许的程序，推荐绝对路径。Windows 的 npm.cmd 不会被隐式包装到 shell，可配置 node.exe → npm-cli.js 别名。

在 Dashboard 为已配对设备创建令牌，选择 `read / write / execute / git`，可限制项目，令牌仅展示一次。客户端连接地址为 `http://localhost:3210/mcp`；远程访问必须使用固定 HTTPS 域名。也可直接通过 OAuth 连接，由浏览器确认设备和权限。

## 已实现的工具

| 类别 | 工具 |
| --- | --- |
| 发现与接续 | `list_devices`, `get_project_context`, `save_project_note` |
| 文件 | `list_directory`, `read_file`, `read_files`, `write_file`, `create_directory`, `move_file`, `get_file_info`, `search_files`, `edit_block`, `edit_files`, `apply_unified_diff`, `get_edit_transactions`, `recover_edit_transaction` |
| 终端 | `start_process`, `run_command`, `wait_process`, `read_process_output`, `tail_process_output`, `write_process_input`, `list_processes`, `stop_process` |
| Git | `git_status`, `git_diff`, `git_log`, `git_add`, `git_commit`, `git_commit_paths`, `git_branches`, `git_switch_branch` |

所有机器工具使用 `projectId`。多台有权限的设备同时在线时必须指定 `deviceId`，防止误操作另一台机器。进程使用任务 UUID，由启动它的客户端主体和项目共同拥有，不接受任意系统 PID。

Dashboard 可查看任务状态、输出和停止执行；Server 仅保存有界任务元数据，输出保留在 Runner。`start_process` 可提供稳定 `idempotencyKey`，避免不确定响应后的重试再次执行。同一 stateDir 的 Runner/配对进程互斥；Windows 用 Job Object、Linux 用进程组管理子孙进程。

v0.3 以日常开发为重点：短命令同步返回、长任务等待、环形尾部日志、本机命令别名/环境配置、按行批量读取、带恢复日志的多文件编辑与严格 Diff，以及保留用户其他暂存内容的指定文件提交。完整调用顺序、配置和边界见 [日常开发工作流](docs/DEVELOPMENT_WORKFLOW.md)。

## 文档与项目结构

- [文档索引](docs/README.md)：按使用、开发、安全与设计资料导航。
- [参考项目对比](docs/COMPARISON.md)：源码修订、架构、协议、工具、安全与取舍。
- [WebCodex 逐工具源码审计](docs/WEBCODEX_CODE_AUDIT.md)：29 个工具域、192 条声明的逐项映射，已修正缺口和仍未实现的能力；不宣称全量功能对等。
- [架构与技术选型](docs/ARCHITECTURE.md)：模块、信任边界、消息协议、持久化及并发。
- [部署与运维](docs/DEPLOYMENT.md)：Docker、Caddy、Nginx、可选 Cloudflare Tunnel、配对、自启动、备份恢复。
- [AI 客户端连接](docs/CLIENTS.md)：ChatGPT、Claude、Cursor 及 MCP SDK 调试。
- [工具与配置参考](docs/TOOLS.md)：调用格式、范围、分页、进程行为和权限。
- [安全模型](SECURITY.md)：命令执行的真实权限、默认限制与尚未提供的隔离能力。
- [验证记录](docs/VALIDATION.md)：已经执行的验证和未执行的环境验收。
- [日常开发工作流](docs/DEVELOPMENT_WORKFLOW.md)：从失败测试到安全提交、断线接续；同时列明仍未实现的交互终端与预览能力。

```text
src/
  shared/       # versioned wire schemas, tool contracts, scopes
  server/       # MCP, WS hub, pairing, OAuth, browser auth, SQLite, admin API
  runner/       # outbound agent, local policy, files, processes, Git, services
public/         # Dashboard JS/CSS, no CDN or external fonts
deploy/         # Caddy and Nginx examples
scripts/        # secret initialization and SQLite online backup
tests/          # security/tool tests + real SDK/WS/OAuth integration
runtime/        # Windows process-tree supervisor sources
licenses/       # locked runtime dependency license texts
.github/        # Linux/Windows checks and Docker smoke workflow
```

## 验证

```sh
npm run verify
npm run notices:check
npm audit --omit=dev --audit-level=high
```

服务端和 Runner 的进程、文件策略是可信组件。目录策略保护内置文件工具；一旦授权通用运行时、shell 或构建工具，命令具有运行账户的实际权限，目录白名单不构成 OS 沙箱。生产环境请用独立低权限账户或只挂载必要目录的容器。项目包含可部署实现与自动化检查，但本地测试通过不等同于独立安全审计或所有客户端、所有平台验收完成。

## 贡献与许可证

欢迎提交可复现的问题和聚焦的改动，开发方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本范围见 [CHANGELOG.md](CHANGELOG.md)。安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

原始源码使用 [MIT License](LICENSE)。依赖保留自己的许可，见 [第三方声明](THIRD_PARTY_NOTICES.md)。本项目独立开发，不代表 WebCodex、Desktop Commander 或任何 AI 客户端厂商。

发布前执行 [开源与发布检查](docs/OPEN_SOURCE.md)。npm 包名为 `homeagent-mcp`，采用明确的发布文件白名单，包含编译后的 CLI、Dashboard、Windows 辅助程序及许可证。

GitHub Actions 已提供版本标签自动发布：仓库配置 `NPM_TOKEN` Secret 后，推送与版本文件匹配的 `v0.3.0` 标签，先验证 Linux/Windows/Docker 和实际安装包，再发布 npm 与 GitHub Release。预发布使用 npm `next`；正式版本使用 `latest`。Token 权限、OIDC 切换和重试行为见 [自动发布说明](docs/OPEN_SOURCE.md#github-actions-自动发布)。
