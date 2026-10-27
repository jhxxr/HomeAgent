# AI 客户端连接

核对日期：2026-10-26。客户端界面和账户权限可能变化；本项目不提供模型服务，也不要求模型 API Key。

v0.3 日常编码优先采用 [开发工作流](DEVELOPMENT_WORKFLOW.md)：get_project_context → read_files/search_files → edit_files/apply_unified_diff → run_command/wait_process → git_commit_paths。原有工具继续可用。

## 共同前提

先确保 Runner 配对且在线，客户端可以访问 `https://mcp.example.com/mcp`，TLS 证书有效。Server 同时支持 OAuth discovery + DCR + S256 PKCE 和 Dashboard 创建的 Bearer PAT，后者必须限制到具体设备，可以进一步限制项目和 scopes。

`/mcp` 使用无状态 Streamable HTTP，支持 MCP 2026-07-28 的 server/discover/每请求 envelope，并兼容 2025 客户端 initialize。官方 SDK 会处理协商、Accept、JSON/SSE 和协议头；原始请求不能把 SSE 响应直接当 JSON 解析。不要使用旧版 `/sse` URL。

### 授权按钮无反应或提示 expired

v0.3.0 的授权表单直接重定向到外部回调，Chrome 可能按 `form-action 'self'` 拦截该跳转；授权请求却已被消费，第二次点击便显示 `Authorization request expired`。**升级 Server 到 v0.3.1**：新版本先进入站内完成页，再返回已注册客户端，保留严格 CSP；按钮显示提交状态并防止重复提交。

升级后重启 Server，回到 AI 客户端重新发起 OAuth 授权，不要刷新或重复提交旧标签页。npm 部署升级 `homeagent-server` 包后重启对应服务；Runner 使用独立的 `homeagent-runner` 包，两者应升级到相同版本。Compose 部署检出 v0.4.4 后重新构建并启动，保留原 `.env` 和数据卷。Runner v0.3.0 不需要为 OAuth 回调修复升级；要使用 v0.4 的 Web 权限管理，则 Server 和 Runner 都应升级到 v0.4.4。

若完成页没有自动返回，点击“继续返回客户端”。已使用或过期的授权码不会被重新签发；客户端仍未连接时，从客户端新建一次授权请求。设备凭据及已完成的客户端授权不因升级被主动清空。

## ChatGPT

根据目前的 [OpenAI 官方连接文档](https://developers.openai.com/plugins/deploy/connect-chatgpt)，在 **ChatGPT Plugins** 页面使用加号 → **Add custom MCP server**，填写名称与描述，选择公共 HTTPS 连接方式，URL 为 `https://mcp.example.com/mcp`，配置 OAuth 并完成风险确认。可用性受账户和 workspace 策略影响；若你的产品界面仍使用 Apps/Connectors 名称，请在该界面寻找对应的自定义 MCP 入口，并以实际账户提供的入口为准。

OAuth 会打开 HomeAgent 登录页。确认：

1. 地址是自己的 Server。
2. 显示的客户端与 HTTPS/loopback 回调地址符合当前操作。
3. 勾选允许使用的已配对设备、该设备上的具体项目与权限。默认只勾选 read；写入需 write，终端需 execute，Git add/commit 需 git。新增项目不会自动进入这次授权，刷新令牌也不扩大范围。
4. 允许后回到 ChatGPT，刷新工具列表并在对话中启用该连接。

自托管 Server 不依赖 OpenAI 的托管隧道。如果使用 ChatGPT，返回的文件内容、命令结果会进入你选择的 AI 服务；“自托管执行系统”并不等于“AI 服务无法看到工具结果”。完全离线时使用局域网可达的本地 MCP 客户端和本地模型。

这里提供的是协议与官方接入流程；仓库自动化测试使用 MCP SDK 客户端，不宣称已替你登录真实 ChatGPT 账户完成验收。

## Claude Code

[Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp) 支持 HTTP 远程服务器和 OAuth：

```sh
claude mcp add --transport http homeagent https://mcp.example.com/mcp
```

在 Claude Code 的 `/mcp` 中选择该服务并认证，浏览器完成 HomeAgent 授权。只需 read 时保持默认，写入/执行需在授权页面勾选相应权限。

若使用 PAT，可使用客户端支持的 `--header`：

```sh
claude mcp add --transport http homeagent https://mcp.example.com/mcp \
  --header "Authorization: Bearer <Dashboard 创建的令牌>"
```

注意 shell 历史和客户端配置文件会保存命令中的静态令牌；生产更推荐 OAuth 或客户端自己的安全凭据管理。Claude 网页或 Desktop 的远程自定义连接器也应使用同一个 HTTPS `/mcp`，前提是账户提供远程自定义 MCP 功能；不用本地 stdio 配置冒充远程连接。

## Cursor

按照 [Cursor 官方 MCP 文档](https://cursor.com/docs/context/mcp)，在用户级 MCP 配置中添加：

```json
{
  "mcpServers": {
    "homeagent": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

支持 OAuth 的 Cursor 会通过元数据发起登录，完成设备与权限批准。若需要静态令牌：

```json
{
  "mcpServers": {
    "homeagent": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <Dashboard 创建的令牌>"
      }
    }
  }
}
```

把实际令牌放在用户私有配置，不要提交到项目 `.cursor/mcp.json`。Cursor 当前文档列出的远程 OAuth 回调使用固定 HTTPS 地址，本项目 DCR 会记录实际请求的 redirect_uris 并在授权时展示，不要求手工添加回调覆盖。

## 通用 MCP 客户端与调试

```sh
npx @modelcontextprotocol/inspector
```

在 Inspector 选择 Streamable HTTP，填写 `/mcp` URL，提供 Bearer Token 或完成 OAuth。先初始化、列出工具，再调用：

```json
{"name":"list_devices","arguments":{}}
```

取得允许的设备和项目后：

```json
{
  "name": "read_file",
  "arguments": {
    "deviceId": "实际设备 UUID",
    "projectId": "my-app",
    "path": "README.md"
  }
}
```

长任务示例：

```json
{
  "name": "start_process",
  "arguments": {
    "deviceId": "实际设备 UUID",
    "projectId": "my-app",
    "executable": "/usr/bin/node",
    "args": ["--test"],
    "cwd": ".",
    "timeoutMs": 3600000,
    "idempotencyKey": "为本次启动生成并保留的唯一键"
  }
}
```

读取输出时使用返回的 `id` 作为 `processId`，把下一次 `cursor` 设为前次 `nextCursor`。不能向另一个客户端主体查询该任务。OAuth 刷新仍使用同一主体，新的独立 PAT 则是另一个主体。

如果工具调用超时或断线，写入/提交先读取文件或 Git 状态确认；进程启动可用相同 idempotencyKey 和完全相同参数重试，在 48 小时收据窗口内返回原任务而不再次启动。换 key、改参数、过期后的请求不在这个保证内。也可以在 Dashboard 查看保留的任务元数据并对在线的准确实例读取输出/停止。
