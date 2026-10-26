# 日常远程开发工作流（v0.3）

本轮围绕单个 AI/单个操作者完成“接手 → 检索 → 修改 → 验证 → 审查提交 → 断线恢复”，在 v0.2 的权限、配对和任务协议上增加实用工具。客户端继续连接原来的 `/mcp`，同时升级 Server 与 Runner，并刷新客户端工具列表。

## 推荐的工具流程

1. `list_devices` 选择准确设备与项目，调用 `get_project_context` 获得 manifest、项目指导、Git 分支/HEAD、可用命令与别名、环境配置名称、最近任务和自己保存的交接记录。
2. `search_files` 用 include/exclude globs 和 contextLines 找到相关代码；Git 项目默认使用 `git ls-files --cached --others --exclude-standard`，有源限额且不偷偷退回无视限额的全盘搜索。非 Git 项目继续有界遍历，返回 gitIgnoreApplied=false。
3. `read_files` 在一次请求中读取最多 16 个文件的指定行范围。使用它返回的完整内容 SHA-256 进行后续编辑，不需要计算字节偏移。
4. `edit_files` 预检全部文件的创建、替换、精确块编辑或删除；也可以 `apply_unified_diff` 应用标准文本 unified diff。已有文件必须提供预期 SHA，新文件必须明确不存在。先 dryRun 可查看摘要。
5. `run_command` 运行本机允许的程序/别名。短命令一次返回状态与输出；长命令返回同一个任务 ID，继续 `wait_process`，而不是再次启动。重试启动时保留 idempotencyKey。
6. 用 `git_diff` 审查变更，再以 `git_branches` 返回的准确 HEAD 与选中文件内容 SHA 调用 `git_commit_paths`。它拒绝消费选中文件已有的暂存变更，并保留其他文件的暂存状态。
7. `save_project_note` 写简短交接说明。下次使用同一客户端身份调用 `get_project_context`，可恢复自己的记录、Git 状态和最近任务。它不是聊天历史、自动调度或上游 Workflow Session。

## 低摩擦命令配置

本地项目可配置 commandAliases 与 environmentProfiles，避免每次在提示中拼接平台包装脚本或传递环境变量。下面路径必须改为自己机器的真实值：

Runner 配置本身必须放在所有暴露项目根之外（例如 `~/.homeagent/runner.json`），与 stateDir 一样不能让普通文件读取权限接触它。v0.3 会拒绝项目内的配置文件，防止环境值或别名私有参数被 read-only token 读到；使用绝对项目路径便于移动配置。

```json
{
  "id": "app",
  "name": "My application",
  "root": "/home/me/projects/app",
  "commands": ["/usr/bin/node", "/usr/bin/python3"],
  "commandAliases": {
    "test": {
      "executable": "/usr/bin/node",
      "args": ["--test"]
    },
    "npm": {
      "executable": "/usr/bin/node",
      "args": ["/usr/lib/node_modules/npm/bin/npm-cli.js"]
    },
    "python": {
      "executable": "/home/me/projects/app/.venv/bin/python",
      "args": []
    }
  },
  "environmentProfiles": {
    "development": {
      "env": {"NODE_ENV": "development"},
      "inherit": ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]
    }
  },
  "allowGitWrite": true
}
```

Windows 的 npm 别名可指向 `C:/Program Files/nodejs/node.exe`，prefix args 指向对应安装目录的 `node_modules/npm/bin/npm-cli.js`。Runner 仍不隐式执行 .cmd/.bat，也不把字符串拼成 shell 命令。别名只在 Runner 配置中授予，客户端不能临时指定任意环境变量或修改别名。

```json
{
  "name": "run_command",
  "arguments": {
    "deviceId": "实际设备 UUID",
    "projectId": "app",
    "executable": "npm",
    "args": ["test", "--", "--runInBand"],
    "environment": "development",
    "waitMs": 1500,
    "timeoutMs": 3600000,
    "idempotencyKey": "同一次启动重试保持不变的唯一键"
  }
}
```

别名本身授予其目标程序执行权限，即使目标没有另外写入 commands；这是明确的本机配置授权。Dashboard 和 list_devices 会显示别名/环境名称（各最多 64 个），使操作者能看到额外执行入口。启用 node/python/shell 等仍意味着允许该程序使用账户权限。environmentProfiles 的值不通过上下文或 hello 返回；但已授权的程序能够读取自己的环境，不能把它当作对执行者保密的 Vault。请用专用低权限账户或只挂载所需项目的容器。

get_project_context 的环境检查只查配置程序在基础 PATH 的可达性，不执行 manifest 中发现的脚本，不猜测哪些 npm scripts 安全。profile 中改变 PATH 后的实际可用性以命令执行结果为准。check-config 输出别名/环境名称，不输出环境值。

## 批量读取与编辑

```json
{
  "name": "read_files",
  "arguments": {
    "projectId": "app",
    "files": [
      {"path": "src/service.py", "startLine": 20, "endLine": 100},
      {"path": "tests/test_service.py", "startLine": 1, "endLine": 120}
    ],
    "maxBytes": 131072
  }
}
```

每文件最多读取 8 MiB 源，单项最多 1000 行，默认约 200 行，总返回文本最多 256 KiB。缺失、权限或版本错误在单文件结果中体现；预算不足时明确返回续读信息。单行比预算还长时不产生“已经前进”的假游标。返回全文 SHA，用于编辑前置条件。

edit_files 最多 32 个唯一文件，单文件结果最多 1 MiB，所有 before/after image 合计不超过 8 MiB；创建文件要求父目录已存在。已有文件使用 expectedSha256，创建只接受不存在的路径；同一路径不能在同一批次重复出现。精确编辑逐项要求唯一匹配。

apply_unified_diff 只接受 `--- / +++ / @@` 的标准文本 diff，不做模糊匹配，支持文本创建/删除、CRLF 和 no-newline marker。它拒绝重命名、二进制、仅 mode 变更、重叠/错位 hunks、缺失或过期版本；不支持 Codex 的 `*** Begin Patch` 语法。

编辑计划、原内容和状态日志保存在私有 stateDir/edits。全部预检通过后才修改项目；失败按 after-image 校验回滚。重启会恢复未完成事务。若外部进程同时改了文件，保留该内容，返回 recovery_conflict 并阻止项目继续自动修改。用 get_edit_transactions 查看自己的事务；解决冲突后 recover_edit_transaction 会再次检查摘要，仍不会强制覆盖外部改动。

这是一组有恢复日志的逐文件操作，不是文件系统快照隔离；外部编辑器仍可看到中间状态。正常成功/回滚后删除内容备份，仅保留最多约 200 个摘要收据。积累大量未解决或未完成的私有目录时会拒绝新事务，由操作者检查，不自动删除未知恢复数据。进程崩溃恢复已测试，不宣称断电后的文件系统事务保证。

## 短命令、等待与日志尾部

run_command 默认等待 1500 ms，最长一次等待 20 秒；执行任务本身的 timeoutMs 仍独立。超出等待窗口继续同一任务。wait_process 可以等到完成或新输出，最长 20 秒；取消等待不终止任务，停止任务使用 stop_process。

v0.3 保留两种有界输出：

- 原 read_process_output 读取最初的 maxOutputBytes，兼容旧字节游标。
- tail_process_output 读取另外固定的 64 KiB 环形尾部，保留超出前段上限后产生的末尾报错。返回总输出字节数、绝对 nextCursor、oldestCursor 和 skippedBytes，轮转不会冒充完整日志。

每任务磁盘上限为 maxOutputBytes + 64 KiB，超限的中段会丢弃，不提供“完整日志”下载承诺。旧 v0.2 任务没有环形尾部；Runner 异常中断后未完成任务也不推断未知环形写入位置，均继续使用 prefix API。正常结束的任务尾部可以在 Runner 重启后继续读取。Dashboard 对有有效尾部的位置默认读取最新内容，显示总字节数和轮转提示。

## 安全提交与 Git 工作树

git_commit_paths 接受具体普通文件或明确的已删除文件，要求 expectedHead 和每文件 expectedSha256（删除为 null）。它对真实 index 持锁，用临时 index 构造提交并 CAS 更新 ref，再写入保留其他暂存条目的 index。HEAD、文件版本变化或选中文件已经有暂存变更都会拒绝；用户无关的暂存内容不会一起提交。

这不证明文件中每行均由当前 AI 编写；调用前必须审查选中文件。提交后若崩溃/出错发生在 ref 与 index 最终化之间，保留 index.lock 并报告需人工核对，不删除锁后盲目重试。无法把 Git ref 和 index 的两个更新变成一个跨文件原子事务。

git_switch_branch 只在工作区和暂存区都干净时创建/切换本地分支，不强制覆盖、不 push。git_branches 返回准确 HEAD、当前分支、最多 100 个本地分支和状态。

已有 linked worktree 可把项目的 gitCommonDir 显式设置为所属仓库的 canonical `.git` 目录。Runner 校验 gitdir 必须位于它的 worktrees 子目录、commondir 和双向 backlink 一致；默认仍拒绝指向未授权 Git 元数据的 `.git` 文件。新建 worktree、注册派生项目并授予客户端权限的完整自动流程尚未实现，请由操作者注册。

git_diff 对目录参数也逐文件过滤本机排除规则；git_add 收紧为显式文件，防止把目录内排除文件隐式 stage。Git 日志/状态仍是授权项目仓库范围的元数据。

## 验收与剩余范围

自动化测试包含真正运行的 Node 测试和 Python unittest，以及官方 MCP 2026 Client 的完整串联：失败测试 → 批量读取 → 多文件 Diff → 复测通过 → 审查 → 只提交选中文件 → 保存交接 → Server 重启后恢复。这个串联是可复现的 SDK 场景测试，**没有宣称已登录真实 AI 客户端或证明模型自主完成率**。

本轮没有实现交互 PTY/持久 shell、跨 Runner 重启继续运行的 detached supervisor、端口预览与浏览器验收、制品通道、自动 worktree 注册、完整 Workflow Session。现有 profiles/aliases 提供常见非交互工具链的稳定入口。真实 AI 客户端验收还需选定客户端和可修改的实际项目；不需要提供模型密钥到仓库。
