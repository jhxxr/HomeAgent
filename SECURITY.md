# 安全模型

v0.3 的多文件编辑使用摘要预检和私有恢复日志，冲突恢复不会覆盖与 after-image 不符的外部内容；不是跨文件快照隔离。指定文件提交保护其他暂存条目，ref/index 更新之间的故障仍需检查保留锁，不能盲目重试。v0.4 增加 Dashboard 可编辑的设备上限和客户端临时授权；命令别名和 environment profile 仍是操作者在本地增加的明确权限。通用解释器依然拥有其运行账户权限。具体边界见 [日常开发工作流](docs/DEVELOPMENT_WORKFLOW.md)。

Runner 配置文件也必须位于暴露项目之外，加载时检查输入路径和 canonical 路径。仅依赖 .gitignore 不会阻止文件工具读取其中的私有环境值。这个检查保护普通文件权限；已经授权的系统命令仍使用操作系统账户权限。

本项目具备认证、授权、本地路径策略、审计、设备撤销和资源限额；没有声称这些措施构成容器或内核级沙箱。

## 信任模型

- 信任 Server、Runner、本地配置及运行它们的系统账户。Server 被攻陷可向 Runner 伪造调用主体，必须像管理入口一样保护。
- AI 客户端凭据只能访问授权设备、项目和 scopes；项目内容、模型生成参数、网络请求不可信。
- 设备凭据仅用于 `/runner`，浏览器登录仅用于管理 API，MCP 必须使用 OAuth/PAT。
- Runner 只连出，不开入站端口；长期凭据不会放在 URL 参数。禁止 TLS 凭据向重定向目标转发。
- MCP 结果会发送到所选 AI 客户端。无遥测和第三方中继不等于所用模型服务看不到返回内容。

## 默认限制

- 公网 PUBLIC_URL 必须 HTTPS；Origin/Host 校验，Dashboard Cookie HttpOnly/SameSite，HTTPS 时 Secure/__Host- 前缀。
- 修改管理状态需 CSRF token，登录校验 Origin，失败限流。OAuth、配对、MCP 也有限流和请求大小限制。
- 自动生成高熵密码与 SESSION_SECRET，凭据不提交 Git。Server token 和配对凭据保存 SHA-256，OAuth confidential secrets 加密。
- commands 默认空；Git 写入默认关闭；readOnly 可禁止所有写入与命令。
- 新 Runner 默认允许 `allowRemotePermissions`，但设备级 Web 覆盖与客户端授权仍分别需要启用；临时权限到期会停止对应托管任务并恢复永久权限。
- 设备范围文件访问、任意程序执行、Git 网络访问和 Git push 都是独立开关；设备范围访问仍保护 Runner 配置、stateDir 和显式 protected paths。
- 内置文件工具拒绝越界、symlink/junction、普通文件硬链接、Windows ADS/设备名别名；默认排除 .git/.env/.ssh/.aws/.homeagent。
- stateDir 必须与所有项目分离。Linux 凭据目录/文件权限 0700/0600，Windows CLI 施加当前账户和 SYSTEM ACL。
- 进程只能由其客户端主体、项目通过任务 UUID 管理，不能凭系统 PID 控制任意进程。
- 新 OAuth grant 固定选择的设备/项目，令牌刷新不扩权；同名项目在另一设备不自动获权。dispatch 再验证当前令牌，族撤销会取消仍在排队的调用。
- Runner 和配对进程对 stateDir 持有 OS-backed SQLite 互斥锁，崩溃释放，不根据历史 PID 删除锁或误杀进程。
- Windows 子进程在 suspended 状态加入 Kill-on-close Job Object 后才运行，supervisor 监视 Runner 死亡；Linux 清理原进程组。没有 supervisor 时不会悄悄降级。
- 输出、并发、扫描、帧大小、请求时间、历史任务都有上限。
- Git hooks、签名、diff/textconv、fsmonitor 被关闭；配置 clean/process filter 的仓库拒绝 Git 写入。
- 暂停或撤销在线设备会关闭连接并要求 Runner 停止其托管任务；撤销后新调用立即失败。已经完成的修改无法回滚。

## 必须理解的边界

**允许解释器、shell 或构建工具就允许其使用运行账户的权限。** 它们可以通过绝对路径、网络、库或项目脚本绕过文件工具 API；commands 允许列表只限制入口可执行文件，不能约束其内部行为。即使未允许命令，对可写项目的文件修改也可能被其他自动构建/监视进程执行。不要把一个高权限热加载生产目录当作普通项目暴露。

路径检查和 O_NOFOLLOW 降低链接绕过风险，但跨平台 Node API 不能提供所有 openat2/句柄相对操作的保证。具有本机并发文件替换能力的恶意进程仍可能制造检查/使用竞争；NTFS mount、Git 元数据、工具链配置也不受完整 OS 隔离。请用专用低权限账户、只挂载必要目录的容器/VM，并隔离凭据、生产密钥、SSH agent 和 Docker socket。

Runner 的命令在 Server 暂时断线时继续运行。设备撤销要求在线 Runner 停止；完全离线时 Server 无法远程强制杀进程。Windows supervisor 监视 Runner 进程死亡并关闭 Job；Linux Runner 被强制杀死仍需 systemd control-group/容器约束。重启不会根据旧 PID 杀进程。客户端令牌撤销不自动回滚已经产生的副作用或停止已经返回任务 ID 的长任务；可通过管理员任务界面显式停止。

Server 的任务镜像只有身份、状态、revision、退出信息与字节计数，不保存 argv、输出或错误正文。离线和缺失的观察状态不会被伪装成成功。管理员输出读取会通过正确的 Runner 实例和原任务主体执行，并以 admin 审计。管理员浏览器会话可单独撤销，不返回其他会话的 CSRF。

start_process 的幂等键只在已声明的 48 小时、主体/项目和同参数窗口内阻止重复准入，不是外部副作用的事务或所有工具的 exactly-once。文件 revision 基于元数据，不抵御能精确伪造本机文件元数据的恶意系统进程。

审计存于本机 SQLite，能追溯调用，但不是防管理员篡改的外部账本。参数仅存 SHA-256 摘要，输出仅在 Runner 任务文件内保留。通过命令自身写出的日志和文件不受本项目输出限额控制，须有 OS 磁盘/内存/CPU 配额。

当前为单管理员单 Server；没有多租户、MFA、端到端加密中继、外部 WORM 审计、自动证书固定、沙箱证明或任意客户端版本兼容保证。SQLite 以及 HTTP/WS 是单节点模型，不应多副本共享同一数据库文件。部署前应在自己的环境完成恢复演练和最小权限检查；本仓库测试不能替代独立安全评估。

## 发现问题与响应

先暂停或撤销设备与客户端凭据，再停止受影响的 Runner。检查 Dashboard 审计、Runner 任务输出和 Git 差异，轮换受影响凭据。SESSION_SECRET 轮换会让现有浏览器会话和 OAuth 客户端加密信息失效，需重新注册客户端；已泄露的 PAT/设备凭据仍需显式撤销。

报告漏洞时不要在公开 issue 附带真实令牌、配对码、数据库、.env 或敏感输出；先提供可在临时目录复现的最小案例。

在 GitHub 等平台托管后，优先使用该仓库启用的私有安全报告入口（GitHub 的 Security → Advisories → Report a vulnerability）。如果尚未开启私有入口，先公开询问维护者的私下联系方式，不公开漏洞利用细节。本仓库不预填不存在的联系地址。

当前维护基线为 0.4.x；发布说明中的可运行和测试结果不等同于独立安全审计、服务等级承诺或对所有部署环境的支持。
