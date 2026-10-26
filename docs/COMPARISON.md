# 参考项目对比

核对日期：2026-10-26。比较基于公开源码，而非仅依据功能宣传。

本文件是架构概览。更完整的源码核查、逐工具映射、本轮发现并修复的缺口，以及仍未实现的全部领域，见 [WebCodex 源码对照审计](WEBCODEX_CODE_AUDIT.md) 与 [192 条声明清单](webcodex-source-inventory.json)。当前实现不具备 WebCodex 的全量产品能力。

用户给出的 `https://github.com/better-remote-commander` 不是具体仓库地址。本实现核对并参考的是 [shahidx0x/better-remote-commander](https://github.com/shahidx0x/better-remote-commander)。如实际指向其他项目，需要重新比较。

| 参考项目 | 本次核对的 main 修订 | 主要来源 |
| --- | --- | --- |
| WebCodex | `4ab06a5574792a86302dcd9a13bb4214ee09cc50` | [README](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/README.zh-CN.md)、[Runner 信封](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-core/src/runner_protocol/transport.rs)、[架构](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/docs/ARCHITECTURE.md) |
| Better Remote Commander | `cbe511702dd0147650353c29ac6ab1decd8afda1` | [架构及阶段记录](https://github.com/shahidx0x/better-remote-commander/blob/cbe511702dd0147650353c29ac6ab1decd8afda1/docs/architecture.md)、[协议](https://github.com/shahidx0x/better-remote-commander/blob/cbe511702dd0147650353c29ac6ab1decd8afda1/packages/shared/src/protocol.ts)、[安全说明](https://github.com/shahidx0x/better-remote-commander/blob/cbe511702dd0147650353c29ac6ab1decd8afda1/SECURITY.md) |

## 架构与协议

| 维度 | WebCodex | Better Remote Commander | HomeAgent 的选择 |
| --- | --- | --- | --- |
| 组织方式 | Rust 多 crate 的完整运行时，包含 Desktop、CLI、Server、Runner、注册表等 | TypeScript 的 relay/agent/shared，工具核心移植自 Desktop Commander | TypeScript 的 server/runner/shared，独立工具实现，降低构建成本 |
| 客户端入口 | Server 认证并路由到真实开发环境，含丰富运行时工作流 | `/mcp` Streamable HTTP，OAuth discovery、DCR、PKCE | 官方 MCP SDK，固定 `/mcp`，OAuth 和具范围的 PAT |
| Runner 通道 | 传输中立的注册、请求、结果、job_update 等信封；源码还定义 QUIC 帧 | 主动 WS，hello/call/result/ping/pong | 主动 WSS，版本化 hello/call/result/cancel，WS ping/pong |
| 项目边界 | 项目、能力授权、任务生命周期体系更丰富 | 设备路由 + allowedDirectories + blockedCommands | 每项目独立 root/readOnly/commands/Git 写入开关，本地再次验证 |
| 长任务 | Job、持久 shell、观察与会话接续等完整模型 | start_process、读取输出、进程管理 | 持久进程元数据、限额输出文件、游标读取、stdin、整组终止、归属校验 |
| 运维形态 | 更全面，但组件、构建与原生安装验收更复杂 | SQLite、Compose、Dashboard、反代/隧道、自启动 | SQLite 单节点、Compose、原生 Runner、Caddy/Nginx、可选隧道 |
| 工具覆盖 | 强调真实项目开发流程与可审查工作结果 | Desktop Commander 的文件、搜索、编辑、终端能力更广，还含非核心文档功能 | 直接使用实用工具名，覆盖本需求文件/终端/Git，不引入 PDF/浏览器下载依赖 |

WebCodex 的优势是开发任务的上下文、生命周期和项目治理比较完整，适合持续运行与审查。代价是系统规模更大，原生构建和平台安装面更广；其 README 本身也明确区分安装交付目标与尚待完成的真实平台验收，不能把计划能力当作已验证能力。HomeAgent 吸收项目边界、Runner 主动连接、长任务观察、多设备与审计，但不重建它的 Desktop、工作流会话和 QUIC 栈。

BRC 的优势是轻量、工具实用，OAuth、配对和 Dashboard 与远程 MCP 的常见接入需求贴合。代价是移植工具核心的依赖与维护负担；它的阶段记录提到 PDF 工具存在首次使用下载 Chrome 的行为。它使用目录限制与命令阻止表，这种策略不能自动隔离可执行的解释器和构建脚本。HomeAgent 采用默认空的可执行文件允许列表，不提供远程修改本机策略的工具。

## 安全结论与兼容边界

两种项目都把 Runner/Agent 作为执行实际系统操作的信任主体。主动连出解决 NAT 和入站暴露问题，不会减少一个获准执行命令的 AI 客户端本身拥有的操作权限。

HomeAgent 的 Server 协议是标准 MCP；Runner 信封是项目自己的内部协议，不与 WebCodex 或 BRC 的 Runner 二进制互通。工具命名参考 Desktop Commander 常用语义，参数刻意增加 `projectId`、权限与进程归属，也不宣称与其全部工具逐参数兼容。

本项目仅借鉴架构与行为设计，代码独立编写。没有将第三方遥测、云中继或托管配对服务引入运行链路。
