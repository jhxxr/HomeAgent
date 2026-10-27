# HomeAgent

简体中文 · [English](README.en.md)

**MIT 开源 · v0.4.1 · Linux / Windows · 自托管**

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
       └─ Git → status / diff / log / add / commit / fetch / pull / push
```

## 快速开始

`homeagent-mcp@latest` 已发布到 npm。同一个包包含 Server 和 Runner，分别安装在中继服务器和需要被操作的开发机器上，也可以先在同一台机器验证。

| 场景 | 部署方式 |
| --- | --- |
| Linux 服务器长期运行 | Docker Compose + 自有域名 + Caddy 自动 HTTPS |
| 已有 Node.js 环境，或先在本机试用 | npm 安装，运行 `homeagent-server` |
| 已有 Nginx / Caddy | Server 监听回环地址，由现有反向代理提供 HTTPS |

部署顺序：**启动 Server → 打开 Dashboard → 安装并配对 Runner → 在 AI 客户端连接 `/mcp`**。Server 使用内置 SQLite，无需额外安装数据库。

### 1. 部署 Server

**方式 A：Docker Compose + Caddy，适合 Linux 公网服务器。**

准备 Docker Engine、Compose v2 和 Git，将自己的域名解析到服务器，并放行 TCP 80/443。下面以 `mcp.example.com` 为例，执行前替换成自己的域名。

```sh
git clone --branch v0.4.1 --depth 1 https://github.com/jhxxr/HomeAgent.git
cd HomeAgent

# 用容器生成随机密码和会话密钥，无需在宿主机安装 Node.js
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work \
  node:24.22.1-bookworm-slim node scripts/init.mjs
```

编辑刚生成的 `.env`，保留随机生成的 `ADMIN_PASSWORD` 和 `SESSION_SECRET`，修改或添加：

```dotenv
PUBLIC_URL=https://mcp.example.com
DOMAIN=mcp.example.com
TRUST_PROXY_HOPS=1
```

```sh
docker compose --profile proxy up -d --build
docker compose --profile proxy ps
docker compose logs --tail=100 server
curl --fail https://mcp.example.com/health
```

Caddy 自动申请证书并代理 HTTP/WebSocket。打开 `https://mcp.example.com`，使用 `.env` 中的 `ADMIN_PASSWORD` 登录 Dashboard。Server 端口 `3210` 默认只映射到宿主机 `127.0.0.1`，不需要向公网开放；镜像从源码在本机构建，没有预发布镜像要求。

SQLite 保存在 `server-data` 命名卷，Compose 配置了 `restart: unless-stopped`。升级前备份数据库和 `.env`；保留 `SESSION_SECRET`，不要用 `docker compose down --volumes` 作为普通重启命令。备份、恢复和已有 Nginx 的配置见 [部署文档](docs/DEPLOYMENT.md)。

**方式 B：npm 原生运行，适合 Linux / Windows 本机试用或已有 Node.js 的服务器。**

需要 Node.js 24（最低 24.14.0，仓库固定的验证补丁版见 `.nvmrc`）和 npm。以下命令可在 Linux shell 或 Windows PowerShell 中执行：

```sh
npm install -g homeagent-mcp@latest
mkdir homeagent-server
cd homeagent-server
homeagent init
homeagent-server
```

本机访问 `http://localhost:3210`，管理员密码在当前目录 `.env` 的 `ADMIN_PASSWORD` 中；初始化命令不打印密码，也不会覆盖已有配置。数据库默认位于当前目录的 `data/server.sqlite`。

公网部署时，先将 `.env` 的 `PUBLIC_URL` 改成固定 HTTPS 域名；一层可信反向代理时设 `TRUST_PROXY_HOPS=1`，再由 Nginx/Caddy 代理到 `127.0.0.1:3210`。`homeagent-server` 在前台运行，并从**当前工作目录**读取 `.env`；长期运行需配置服务管理器。Linux systemd 示例见 [原生 Server 部署](docs/DEPLOYMENT.md#原生部署-server)。

### 2. 安装并配对 Runner

在需要被 AI 操作的开发机器上安装 Node.js 24、npm；Git 工具还需要本机 Git。推荐直接使用交互式登录：

```sh
npm install -g homeagent-mcp@latest
homeagent login
```

终端会询问 Web URL、设备名称和首个项目目录（默认当前目录），自动生成 `$HOME/.homeagent/runner.json`，然后显示一个 10 分钟有效的浏览器登录链接：

```
请在已登录 Dashboard 的浏览器打开链接
```

在网页中核对设备名称，批准后 Runner 会自动领取凭据。进入 Dashboard 的“设备与项目”即可添加更多项目、配置只读、命令执行和 Git 权限。网页登录链接必须由已登录的管理员会话打开；链接过期后重新执行 `homeagent login` 即可。

```sh
# 登录只负责完成设备配对；需要直接在前台启动 Runner 时加 --run：
homeagent login --run
# 或完成登录后单独运行：
homeagent-runner run --config "$HOME/.homeagent/runner.json"
```

Windows 的项目根目录可写为 `E:/Projects/my-app`。Runner 配置和 stateDir 都必须位于所有暴露项目之外。需要预先指定参数时，可以使用 `homeagent-runner login --server https://mcp.example.com --project E:/Projects/my-app`。仍需手动维护 JSON 时，`homeagent init-runner`、`pair` 和 `run` 命令继续可用。

需要自启动时，完成配对并停止前台 Runner，再运行 `homeagent-runner service-install --config "$HOME/.homeagent/runner.json"`。Linux 安装用户 systemd 服务；Windows 安装当前用户登录时启动的计划任务。该命令仅管理 Runner，不会为 Server 安装服务。

默认不允许执行命令或 Git 写入。需要终端能力时，在本机配置 `commands` 或 `commandAliases`；Git 写入还需设置 `allowGitWrite: true`，并给客户端对应 scope。Windows 的 npm.cmd 不会隐式转成 shell，可配置 node.exe → npm-cli.js 别名。`allowRemotePermissions` 开启后，管理员可以在 Dashboard 临时或永久调整设备权限；关闭则只使用 Runner 本地配置。完整示例见 [日常开发工作流](docs/DEVELOPMENT_WORKFLOW.md)。

### 3. 连接 AI 客户端

| 用途 | 公网部署示例 |
| --- | --- |
| Dashboard | `https://mcp.example.com` |
| AI 客户端 MCP 地址 | `https://mcp.example.com/mcp` |
| Runner 配置的 `server` | `https://mcp.example.com`，不要加 `/mcp` |
| 健康检查 | `https://mcp.example.com/health` |

客户端可通过 OAuth 连接，在浏览器确认设备和项目权限；也可在 Dashboard 为已配对设备创建客户端令牌，选择 `read / write / execute / git` scope，再以 Bearer token 连接。令牌仅展示一次，设备凭据不能代替客户端令牌。

本机验证时地址换成 `http://localhost:3210`；远程必须使用固定 HTTPS origin，不支持将 Server 挂在某个 URL 子路径下。各客户端配置见 [AI 客户端连接](docs/CLIENTS.md)。

### 从源码开发

需要修改源码时再选择此方式；日常安装使用上面的 npm 包或 Compose：

```sh
git clone https://github.com/jhxxr/HomeAgent.git
cd HomeAgent
npm ci
npm run build
npm run init
npm run server
```

源码 Runner 使用 `npm run runner -- pair --config "$HOME/.homeagent/runner.json"` 和 `npm run runner -- run --config "$HOME/.homeagent/runner.json"`，配置及配对流程相同。

## 已实现的工具

| 类别 | 工具 |
| --- | --- |
| 发现与接续 | `list_devices`, `get_project_context`, `save_project_note` |
| 文件 | `list_directory`, `read_file`, `read_files`, `write_file`, `create_directory`, `move_file`, `get_file_info`, `search_files`, `edit_block`, `edit_files`, `apply_unified_diff`, `get_edit_transactions`, `recover_edit_transaction` |
| 终端 | `start_process`, `run_command`, `wait_process`, `read_process_output`, `tail_process_output`, `write_process_input`, `list_processes`, `stop_process` |
| Git | `git_status`, `git_diff`, `git_log`, `git_add`, `git_commit`, `git_commit_paths`, `git_branches`, `git_switch_branch`, `git_fetch`, `git_pull`, `git_push` |

所有机器工具使用 `projectId`。多台有权限的设备同时在线时必须指定 `deviceId`，防止误操作另一台机器。进程使用任务 UUID，由启动它的客户端主体和项目共同拥有，不接受任意系统 PID。

Dashboard 可查看任务状态、输出和停止执行；Server 仅保存有界任务元数据，输出保留在 Runner。`start_process` 可提供稳定 `idempotencyKey`，避免不确定响应后的重试再次执行。同一 stateDir 的 Runner/配对进程互斥；Windows 用 Job Object、Linux 用进程组管理子孙进程。

v0.3 以日常开发为重点：短命令同步返回、长任务等待、环形尾部日志、本机命令别名/环境配置、按行批量读取、带恢复日志的多文件编辑与严格 Diff，以及保留用户其他暂存内容的指定文件提交。完整调用顺序、配置和边界见 [日常开发工作流](docs/DEVELOPMENT_WORKFLOW.md)。

### Web 权限管理

v0.4 的权限分为两层，最终能力取设备上限与客户端授权的交集：

- **设备权限**：在 Dashboard 为每个项目设置项目目录或设备范围文件访问、命令 allowlist 或任意程序、Git 本地写入、fetch/pull 网络访问和单独的 push 权限。
- **客户端权限**：修改已有 PAT 或 OAuth 授权的设备、项目、scope、具体工具，以及“目录外文件”和“任意程序”高级开关，不需要重新复制凭据。
- **临时开放**：设备和客户端权限都可设置分钟级有效期；到期会停止相关托管任务并恢复原权限。权限 revision 冲突会被拒绝，避免覆盖他人的更新。

任意程序仍以 Runner 运行账户的权限执行，不会自动获得管理员或 root 权限。设备权限修改会取消在途调用并停止托管任务，已经产生的文件修改不会自动回滚。旧 Runner 无法应用已保存的 Web 覆盖，升级 Server 和 Runner 到同一 `0.4.x` 后再使用。

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
bin/            # npm CLI entry points
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
.github/        # Linux/Windows/Docker checks and npm/GitHub Release publishing
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

`v0.4.1` 已通过 GitHub Actions 发布到 npm 和 GitHub Release；安装命令默认使用 npm `latest`。后续发布递增版本，更新版本文件和 changelog 后推送匹配标签；预发布使用 npm `next`，正式版本使用 `latest`。Token 权限、OIDC 切换和重试行为见 [自动发布说明](docs/OPEN_SOURCE.md#github-actions-自动发布)。
