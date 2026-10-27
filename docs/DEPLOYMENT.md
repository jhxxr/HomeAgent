# 部署、配对与运维

## 准备

推荐 Node.js 24.22.1 或更新的 24 LTS 补丁版、Git；最低 Node 24.14。原生 Server 不需要额外数据库。容器方式需要 Docker Engine 和 Compose v2。Runner 建议原生运行在开发机器上，以便使用现有编译器和工具链。

所有公网流量使用 HTTPS/WSS。Server 的 `PUBLIC_URL` 必须是稳定、无子路径的外部 origin，例如 `https://mcp.example.com`。不要用每次重启会变化的临时隧道地址做长期 OAuth issuer。

## 原生部署 Server

### npm 安装

Server 和 Runner 使用独立 npm 包，无需源码编译。Server 包包含 Web Dashboard：

```sh
npm install -g homeagent-server@latest
mkdir homeagent-server
cd homeagent-server
homeagent-server init
```

编辑本目录 `.env`，保留生成的密码和会话密钥。本机验证使用默认 `http://localhost:3210`；公网修改 `PUBLIC_URL=https://mcp.example.com`，若只有一层可信反代则设 `TRUST_PROXY_HOPS=1`，由反代连接 `127.0.0.1:3210`。然后运行：

```sh
homeagent-server
```

命令在前台运行，从当前目录读取 `.env`；已有环境变量优先于文件。数据库默认写入当前目录的 `data/server.sqlite`，因此服务管理器必须设置固定工作目录。Linux 和 Windows PowerShell 的安装/启动命令相同。

### 从源码安装

```sh
git clone https://github.com/jhxxr/HomeAgent.git
cd HomeAgent
npm ci
npm run build
npm run init
```

用编辑器查看 `.env` 中生成的管理员密码，并修改 `PUBLIC_URL`。同机开发时保留 `http://localhost:3210`；对外部署时设为自己的 HTTPS 域名，反向代理连接本地 `127.0.0.1:3210`。非 loopback 的 HTTP PUBLIC_URL 会被拒绝。

```sh
npm run server
```

生产由自己的服务管理器运行 `node dist/server/cli.js`，并安全注入 `.env`。npm 脚本使用 Node 的 `--env-file-if-exists=.env`，直接运行 node 则需要显式 `--env-file=/绝对路径/.env` 或服务环境。

### Linux 用户 systemd 服务

以下针对 npm 安装方式，在运行 Server 的专用低权限账户下操作。先确认实际路径：

```sh
command -v node
npm root -g
mkdir -p "$HOME/.config/systemd/user"
```

创建 `$HOME/.config/systemd/user/homeagent-server.service`，把下面三个路径替换为自己的实际值：

- `WorkingDirectory`：保存 `.env` 的目录，必须允许该账户写入数据库。
- `ExecStart` 第一个路径：`command -v node` 的输出。
- `ExecStart` 第二个路径：`npm root -g` 输出目录下的 `homeagent-server/bin/server.mjs`。

```ini
[Unit]
Description=HomeAgent MCP relay
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/homeagent/homeagent-server
ExecStart=/absolute/path/to/node /absolute/global/node_modules/homeagent-server/bin/server.mjs
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
```

路径含空格时，分别使用 systemd 支持的双引号包住 `WorkingDirectory` 和 `ExecStart` 各路径；unit 中不能依赖 shell 的 `~` 或变量展开。

```sh
systemctl --user daemon-reload
systemctl --user enable --now homeagent-server
systemctl --user status homeagent-server
journalctl --user -u homeagent-server -f
```

若需退出登录后继续运行并随系统启动，由管理员为该账户执行 `sudo loginctl enable-linger <运行账户>`。更新 npm 包后执行 `systemctl --user restart homeagent-server`。Windows 长期运行时使用自己的服务/进程管理器，指定相同工作目录；`homeagent service-install` 只安装 Runner 自启动，不安装 Server 服务。

## Docker Compose

先在有 Docker Engine、Compose v2 和 Git 的服务器检出发布源码：

```sh
git clone --branch v0.4.5 --depth 1 https://github.com/jhxxr/HomeAgent.git
cd HomeAgent
```

Linux 主机可通过容器生成 `.env`，无需宿主机 Node.js；按当前 UID/GID 创建文件，避免密钥归 root 所有导致普通账户无法编辑：

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work \
  node:24.22.1-bookworm-slim node scripts/init.mjs
```

如果宿主机已有 Node.js，也可以直接执行 `node scripts/init.mjs`。初始化均不覆盖已有 `.env`。默认本地模式启动：

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 server
```

默认仅将 `127.0.0.1:3210` 映射到容器，不直接向公网暴露明文端口。SQLite 保存在 `server-data` 命名卷。Server 非 root 运行，根文件系统只读，只有数据库卷与临时目录可写，去除所有 Linux capabilities。

Docker 镜像包含已经编译的生产依赖、Dashboard 静态文件；运行不需要 npm、第三方 API 或构建服务。镜像构建需要访问软件包和镜像仓库，离线环境可在有网环境构建、导出镜像后导入。

### Caddy 自动 TLS

域名 A/AAAA 指向自己的 Server，放行 80/443。在 `.env` 修改：

```dotenv
PUBLIC_URL=https://mcp.example.com
DOMAIN=mcp.example.com
TRUST_PROXY_HOPS=1
```

```sh
docker compose --profile proxy up -d --build
```

Caddy 自动申请 TLS 并代理 HTTP 和 WebSocket。服务器与 Runner 都走同一个域名，Runner 指向 `https://mcp.example.com`。客户端 MCP URL 为 `https://mcp.example.com/mcp`。

### 已有 Nginx

参考 [deploy/nginx.conf](../deploy/nginx.conf)，证书自行配置。`Host` 必须保持外部域名；必须支持 WebSocket upgrade，关闭代理缓冲。将 `TRUST_PROXY_HOPS=1` 设为真实受信代理数量，不能无条件信任任意 X-Forwarded-For。

### 可选 Cloudflare Tunnel

它是可选部署方式，会让流量通过 Cloudflare；完全自控的部署请选择自有服务器和反向代理。

在自己已有的命名 Tunnel 中配置固定 hostname `mcp.example.com`，目标 `http://server:3210`（cloudflared 容器与 server 同网络）。`.env` 设置：

```dotenv
PUBLIC_URL=https://mcp.example.com
TRUST_PROXY_HOPS=1
CLOUDFLARE_TUNNEL_TOKEN=你的命名隧道凭据
```

```sh
docker compose --profile cloudflare up -d --build
```

不要同时用 Cloudflare Access 的交互登录拦截 `/mcp`、OAuth 元数据或 `/runner`，除非客户端明确支持额外认证。此项目不依赖隧道，也不保存任何 Cloudflare API 凭据到源码。

## Runner 配置与配对

在开发机执行 `npm install -g homeagent-runner@latest`，推荐使用 `homeagent login` 完成交互式配置和浏览器配对。终端只询问 Server URL 和设备名；项目目录在网页填写并保存在 Server 上。批准后执行 `homeagent run`，无需指定配置路径。新 Runner 本地配置只保存连接和运行设置，`stateDir` 保存凭据与任务记录；没有本地项目基线。

成功登录和启动会记录配置的绝对路径，换工作目录后仍可使用 `homeagent run`。指定 `--config` 时以显式路径为准，否则依次检查已记录位置、`~/.homeagent/runner.json`。已记录的文件被移动或删除时会明确报错，避免静默连接另一台设备。自启动安装仍使用 `homeagent service-install`，会将实际配置路径写入服务。

本地配置仅包含连接和运行设置，例如：

```json
{"server":"https://mcp.example.com","name":"workstation","stateDir":"state"}
```

项目目录、Git 权限、命令别名和环境配置全部在网页管理。本地配置不接受项目字段或权限开关，Server 与 Runner 必须同时升级。

### Dashboard 权限管理

Runner 首次连接时没有项目权限，收到 Server 配置并验证成功后才开放项目。Dashboard 的设备编辑器可以为每个项目设置：

- `filesystemScope=project`：只允许内置文件工具访问项目目录；
- `filesystemScope=device`：允许使用设备范围的绝对路径，但 Runner 配置、stateDir 和受保护路径仍拒绝通过文件工具访问；
- `commandMode=allowlist`：只允许运行网页配置的 `commands` 或别名；
- `commandMode=unrestricted`：允许任意可执行文件，实际权限等于 Runner 运行账户；
- Git 本地写入、网络 fetch/pull 和 push 三个独立开关。

客户端授权编辑器另外控制设备、项目、scope、具体工具，以及目录外文件和任意程序两个高级开关。设备上限与客户端授权取交集，因此打开设备级能力不会自动让所有客户端获得该能力。修改已有 PAT 或 OAuth 授权不需要重新复制令牌。

设备和客户端授权都支持临时有效分钟数。到期时 Server 增加 revision、取消在途调用；Runner 会停止该授权启动的托管任务，并恢复上一个永久权限。权限修改使用 `expectedRevision`，浏览器打开过期编辑器时会收到冲突而不会覆盖新设置。保存设备权限会停止此设备的托管任务，已发生的文件修改不会回滚。

设备项目设置只有 Server 一个来源。清空全部项目后收回访问；断线会清空运行中的项目列表并停止托管任务，重连后重新下发。Server 仅接受当前 Runner 协议。

交互式登录流程：

1. Runner 执行 `homeagent login`，创建私有配置并通过出站 HTTPS 请求创建配对。
2. 终端打印 10 分钟有效的浏览器链接和备用 10 位一次性码。
3. 在已经登录 Server Dashboard 的浏览器打开链接，核对设备名称、填写被控端项目的绝对目录并批准；也可以稍后在 Dashboard 配置项目。备用码流程继续可用。
4. Runner 使用自己持有的独立 pollToken 领取长期设备凭据。码、pollToken 和浏览器批准凭据都不能用来直接取得另一台设备的凭据。
5. 凭据保存到 stateDir/device.json；Linux 目录 0700、文件 0600，Windows CLI 对目录设置当前账户和 SYSTEM 的受限 ACL。配对与运行使用同一 stateDir 互斥锁；先停止正在运行的实例再重新配对。
6. 登录完成后执行 `homeagent run`；Dashboard 应显示在线及注册项目，终端打印当前生效目录。首次也可用 `homeagent login --run` 在批准后直接启动。

配置检查使用 `homeagent check-config`，仅显示本机连接和运行设置。终端在收到 Server 配置后显示实际应用的目录。

配对超时或领取响应丢失时重新开始，旧配对不会返回长期明文凭据。如果本地已经有凭据，`login` 默认拒绝覆盖；显式 `homeagent login --force` 会替换本地凭据，但不会自动撤销 Server 上的旧设备，应先在 Dashboard 撤销旧记录。

Server 域名变更后，现有凭据不会静默连接另一个 origin，必须显式重新配对。修改本机连接设置后需重启 Runner；网页项目和命令策略会实时下发，不通过 MCP 工具修改。

### 环境变量

`HOMEAGENT_SERVER` 可覆盖连接地址。项目目录不通过环境变量配置；在 Dashboard 保存项目设置后实时下发。

### 自启动

完成配对并停止手动运行的 Runner，再安装服务：

```sh
homeagent service-install
homeagent service-uninstall
```

Linux 创建 `~/.config/systemd/user/homeagent-<配置摘要>.service`，使用 user systemd，无需 root。要在退出登录及开机后持续运行，按安装输出显式执行 `sudo loginctl enable-linger <用户名>`。日志：`journalctl --user -u homeagent-<摘要>.service -f`。

Windows 创建当前用户登录触发的计划任务，名称为 `HomeAgent-<配置摘要>`，最低权限运行，无需在系统服务中保存密码。它是“用户登录后启动”，不是“无人登录的系统启动”。若必须无人登录运行，应由管理员为专用低权限账户配置服务管理器；本项目不自动提升权限。查看状态：`Get-ScheduledTask -TaskName 'HomeAgent-*'`。升级或重启前先终止同配置的旧进程，避免两个 Runner 互相替换连接。

服务安装会立即启动；不要再同时手动启动同一设备凭据。不要把源码位置移动后保留旧服务路径。

v0.2 同一 stateDir 的第二个 Runner 会明确拒绝启动。Windows 卸载先结束计划任务再删除；CLI `--version` 可看版本/Node/平台，`homeagent check-config` 可检查配置而不打印设备令牌。Windows 任务执行依赖系统 PowerShell/.NET Add-Type；组织策略禁止时失败关闭，不自动使用 ExecutionPolicy Bypass。

Windows 子进程默认显式使用系统 PowerShell 模块目录，避免过滤环境导致模块发现卡住，并排除用户/项目模块加载钩子。源码维护者可执行 `node --import tsx scripts/diagnose-windows.mjs`，使用实际 Runner 环境函数检查监督器启动；需要先安装开发依赖。该检查只输出启动状态与固定测试命令的输出。

### 容器 Runner（Linux 可选）

原生 Runner 更适合已有完整开发环境。需要隔离时也可以构建 runner target：

```sh
docker build --target runner -t homeagent-runner:local .
```

将本机连接设置的 stateDir 设为 `/state`，在 Dashboard 将项目 root 设为 `/workspace`，只把实际项目挂载到 `/workspace`，state 持久卷挂载到 `/state`，配置只读挂载 `/config/runner.json`。容器的 UID/GID 必须对挂载目录有相应权限（镜像默认 node 用户，UID 1000），不要挂载 Docker socket 或整个宿主机根目录。

```sh
docker run --rm -it \
  --mount type=bind,src=/absolute/config/runner.json,dst=/config/runner.json,readonly \
  --mount type=bind,src=/absolute/project,dst=/workspace \
  --mount type=volume,src=homeagent-runner-state,dst=/state \
  homeagent-runner:local login --config /config/runner.json
```

配对后用相同挂载、`--init --restart unless-stopped -d` 运行 `run --config /config/runner.json`。运行阶段不需要 `-it`。镜像只有 Node、Git、CA；其他编译器请自行构建派生镜像。

## 配置表

| Server 环境变量 | 默认 / 要求 |
| --- | --- |
| HOST / PORT | `127.0.0.1` / `3210`；Compose 容器内为 `0.0.0.0:3210` |
| PUBLIC_URL | 固定 origin，不支持子路径，公网必须 HTTPS |
| ADMIN_PASSWORD | 必填，至少 16 字符；生成器使用随机值 |
| SESSION_SECRET | 必填，至少 32 字符；同时保护会话签名与 OAuth 客户端秘密 |
| HOMEAGENT_DB | `./data/server.sqlite`；容器内 `/app/data/server.sqlite` |
| TRUST_PROXY_HOPS | 0；有一层可信反代时设 1 |
| AUDIT_RETENTION_DAYS | 90，范围 1–3650 |

## 暂停、撤销与备份

Dashboard “暂停”设备关闭连接并停止 Runner 的托管任务，后续调用立即拒绝。恢复后 Runner 自动重连。撤销会使长期设备令牌失效并停止重连；重新使用需要配对。撤销客户端令牌会撤销同族令牌；OAuth 客户端撤销还阻止其继续交换授权。

在线备份使用 SQLite backup API，避免直接复制一个正在写入的 WAL 数据库文件：

```sh
node scripts/backup.mjs ./data/server.sqlite /safe/backups/homeagent.sqlite
```

Docker 中可直接调用相同 API：

```sh
docker compose exec server node --input-type=module -e "import {DatabaseSync,backup} from 'node:sqlite'; const db=new DatabaseSync('/app/data/server.sqlite'); await backup(db,'/app/data/backup.sqlite'); db.close();"
docker compose cp server:/app/data/backup.sqlite ./homeagent-backup.sqlite
```

Server 数据库备份之外，还要单独安全保存 `.env` 的 SESSION_SECRET，以及各 Runner 的 stateDir 和原始配置。不要把备份放在暴露项目根里。备份包含持久凭据的哈希和加密 OAuth 客户端信息，仍应视为敏感数据。

恢复前停止 Server，用备份替换数据库；必须同时移除旧的 `server.sqlite-wal` 和 `server.sqlite-shm`（确认服务已停且目标路径正确），再恢复相同所有者和权限。容器方式将备份复制回命名卷的 `/app/data/server.sqlite`，确保 node 用户可读写。不要对旧版本程序直接使用新版本数据库；升级前备份，先在副本验证。

当前 schema 版本为 `PRAGMA user_version=1`，本版本只创建缺失表，没有声明支持任意跨版本迁移。

## 故障排查

- `/health` 不通：检查监听端口、容器健康状态、Host 转发及 PUBLIC_URL。非默认端口映射时请用 PUBLIC_URL 配置的主机名；例如配置 localhost 时不要直接换成 127.0.0.1 外部映射端口，严格 Host 校验可能返回 403。
- Dashboard API 403：刷新页面取得新 CSRF；确认浏览器访问域名与 PUBLIC_URL 一致。
- MCP 401：确认客户端 Token 未过期/撤销，或重新完成 OAuth；设备令牌不能用作 MCP Token。
- Runner 401：设备被撤销、凭据不匹配或服务器 origin 已变；不要自动把凭据发送到重定向目标。
- Runner 暂停：Server 返回 403，Runner 退避重试；恢复设备后应重新上线。
- Dashboard 任务显示 unconfirmed/missing：表示离线未确认或新快照未报告，不代表成功；不能凭旧 processId 在另一实例上读取/停止。
- v0.1 OAuth 升级：旧 grant 不被静默改写，请撤销并重新授权以启用具体设备/项目范围。升级 Server 后同时升级 Runner，以使用任务快照、幂等键和进程树托管。
- 多设备调用失败：先 `list_devices`，显式填写 deviceId 和 projectId。
- 命令被拒绝：检查项目 commands 是否包含完全相同的可执行文件以及客户端 execute 权限。
- Git 写入被拒绝：检查 git scope、allowGitWrite、独立仓库根、Git identity 和 clean/process filters。
- `node:sqlite` ExperimentalWarning：Node 24 内置 API 的运行时提示，不代表服务启动失败；生产仍应固定并测试 Node 补丁版。
