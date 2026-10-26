# 部署、配对与运维

## 准备

推荐 Node.js 24.22.1 或更新的 24 LTS 补丁版、Git；最低 Node 24.14。原生 Server 不需要额外数据库。容器方式需要 Docker Engine 和 Compose v2。Runner 建议原生运行在开发机器上，以便使用现有编译器和工具链。

所有公网流量使用 HTTPS/WSS。Server 的 `PUBLIC_URL` 必须是稳定、无子路径的外部 origin，例如 `https://mcp.example.com`。不要用每次重启会变化的临时隧道地址做长期 OAuth issuer。

## 原生部署 Server

```sh
npm ci
npm run build
npm run init
```

用编辑器查看 `.env` 中生成的管理员密码，并修改 `PUBLIC_URL`。同机开发时保留 `http://localhost:3210`；对外部署时设为自己的 HTTPS 域名，反向代理连接本地 `127.0.0.1:3210`。非 loopback 的 HTTP PUBLIC_URL 会被拒绝。

```sh
npm run server
```

生产由自己的服务管理器运行 `node dist/server/cli.js`，并安全注入 `.env`。npm 脚本使用 Node 的 `--env-file-if-exists=.env`，直接运行 node 则需要显式 `--env-file=/绝对路径/.env` 或服务环境。

## Docker Compose

本地模式：

```sh
npm run init
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

发布到 npm 后，可在开发机执行 `npm install -g homeagent-mcp`、`homeagent init-runner`，编辑生成的 `~/.homeagent/runner.json`，然后用 `homeagent-runner pair --config <配置绝对路径>` 和 `homeagent-runner run --config <配置绝对路径>`。已安装包不需要再编译；Linux 的 systemd 与 Windows 登录任务通过同一 `homeagent-runner service-install` 命令安装。更新全局包后重启 Runner 服务，使其使用新代码。

也可在每台开发机检出本项目，执行 `npm ci && npm run build`。复制 `runner.example.json`：

```json
{
  "server": "https://mcp.example.com",
  "name": "my-linux-workstation",
  "stateDir": "/home/me/.homeagent",
  "projects": [
    {
      "id": "my-app",
      "name": "My App",
      "root": "/home/me/projects/my-app",
      "readOnly": false,
      "commands": ["/usr/bin/node", "/usr/bin/python3"],
      "allowGitWrite": true,
      "deniedNames": [".git", ".env", ".ssh", ".aws", ".homeagent"]
    }
  ]
}
```

Windows 示例：

```json
{
  "server": "https://mcp.example.com",
  "name": "windows-dev",
  "stateDir": "C:/Users/me/.homeagent",
  "projects": [
    {
      "id": "my-app",
      "name": "My App",
      "root": "E:/Projects/my-app",
      "readOnly": false,
      "commands": ["C:/Program Files/nodejs/node.exe"],
      "allowGitWrite": false
    }
  ]
}
```

把路径改为实际值。`stateDir` 不得位于任何暴露项目之内，项目也不能位于 stateDir 之内。项目路径和 stateDir 的相对值按配置文件所在目录解析。不要把整个系统盘或整个用户目录作为项目根。

v0.3 同时要求 Runner 配置文件位于全部暴露项目根之外，因为其中可能包含环境 profile 或别名私有参数。若暴露的项目就是 HomeAgent 仓库，不要把 runner.local.json 留在仓库内；移到 `~/.homeagent/runner.json` 并通过 `--config` 指定，项目根使用绝对路径。

已有自启动任务时，升级前先用旧版本卸载服务，再移动配置并用新路径重新安装；服务名包含配置路径摘要。请移动私有配置，不在暴露项目内保留含敏感值的旧副本。若已升级导致旧配置被拒绝，用系统的 systemd/计划任务管理器停止并卸载旧任务，然后按新路径安装。

配对流程：

1. Runner 执行 `npm run runner -- pair --config runner.local.json`。
2. 它仅通过出站 HTTPS 请求创建配对，打印 10 位一次性码与 Dashboard 地址。
3. 在 Server Dashboard 登录，核对 Runner 提示的设备名称，输入码并批准。
4. Runner 使用自己持有的独立 pollToken 领取长期设备凭据。码、pollToken 都不能再使用。
5. 凭据保存到 stateDir/device.json；Linux 目录 0700、文件 0600，Windows CLI 对目录设置当前账户和 SYSTEM 的受限 ACL。配对与运行使用同一 stateDir 互斥锁；先停止正在运行的实例再重新配对。
6. 执行 `npm run runner -- run --config runner.local.json`，Dashboard 应显示在线及注册项目。

配对超时或领取响应丢失时重新开始，旧配对不会返回长期明文凭据。如果本地已经有凭据，`pair` 默认拒绝覆盖；显式 `pair --force` 会替换本地凭据，但不会自动撤销 Server 上的旧设备，应先在 Dashboard 撤销旧记录。

Server 域名变更后，现有凭据不会静默连接另一个 origin，必须显式重新配对。修改 Runner 项目或命令策略后重启 Runner；策略不允许从 MCP 远程更改。

### 环境变量覆盖

`HOMEAGENT_SERVER` 覆盖 Runner 的 server。`ALLOWED_ROOTS` 是 JSON 数组，避免 Windows 盘符与分隔符冲突；设置后会替换 projects，自动编号为 `project-1` 等，命令列表为空且 Git 写入关闭。常规部署推荐显式配置 projects，保持项目 ID 稳定。

Linux：

```sh
ALLOWED_ROOTS='["/home/me/projects/a","/home/me/projects/b"]' npm run runner -- run --config runner.local.json
```

PowerShell：

```powershell
$env:ALLOWED_ROOTS = '["E:/Projects/a","E:/Projects/b"]'
npm run runner -- run --config runner.local.json
```

### 自启动

完成配对并停止手动运行的 Runner，再安装服务：

```sh
npm run runner -- service-install --config runner.local.json
npm run runner -- service-uninstall --config runner.local.json
```

Linux 创建 `~/.config/systemd/user/homeagent-<配置摘要>.service`，使用 user systemd，无需 root。要在退出登录及开机后持续运行，按安装输出显式执行 `sudo loginctl enable-linger <用户名>`。日志：`journalctl --user -u homeagent-<摘要>.service -f`。

Windows 创建当前用户登录触发的计划任务，名称为 `HomeAgent-<配置摘要>`，最低权限运行，无需在系统服务中保存密码。它是“用户登录后启动”，不是“无人登录的系统启动”。若必须无人登录运行，应由管理员为专用低权限账户配置服务管理器；本项目不自动提升权限。查看状态：`Get-ScheduledTask -TaskName 'HomeAgent-*'`。升级或重启前先终止同配置的旧进程，避免两个 Runner 互相替换连接。

服务安装会立即启动；不要再同时手动启动同一设备凭据。不要把源码位置移动后保留旧服务路径。

v0.2 同一 stateDir 的第二个 Runner 会明确拒绝启动。Windows 卸载先结束计划任务再删除；CLI `--version` 可看版本/Node/平台，`check-config --config runner.local.json` 可检查配置而不打印设备令牌。Windows 任务执行依赖系统 PowerShell/.NET Add-Type；组织策略禁止时失败关闭，不自动使用 ExecutionPolicy Bypass。

### 容器 Runner（Linux 可选）

原生 Runner 更适合已有完整开发环境。需要隔离时也可以构建 runner target：

```sh
docker build --target runner -t homeagent-runner:local .
```

将配置的 stateDir 设为 `/state`、项目 root 设为 `/workspace`，只把实际项目挂载到 `/workspace`，state 持久卷挂载到 `/state`，配置只读挂载 `/config/runner.json`。容器的 UID/GID 必须对挂载目录有相应权限（镜像默认 node 用户，UID 1000），不要挂载 Docker socket 或整个宿主机根目录。

```sh
docker run --rm -it \
  --mount type=bind,src=/absolute/config/runner.json,dst=/config/runner.json,readonly \
  --mount type=bind,src=/absolute/project,dst=/workspace \
  --mount type=volume,src=homeagent-runner-state,dst=/state \
  homeagent-runner:local pair --config /config/runner.json
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
