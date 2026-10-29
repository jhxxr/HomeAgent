# 文档索引

## 使用

- [部署、配对与运维](DEPLOYMENT.md)：原生/Compose、HTTPS、反代、Runner、自启动、备份。
- [AI 客户端接入](CLIENTS.md)：OAuth/PAT、协议与调用方式。
- [日常开发流程](DEVELOPMENT_WORKFLOW.md)：命令环境、按行读取、多文件编辑、日志、安全提交与接续。
- [远程协助](REMOTE_ASSIST.md)：邀请朋友、本机临时批准、独立到期与立即停止。
- [工具与权限参考](TOOLS.md)：参数、限额、scope、管理 API。

## 维护与安全

- [安全模型](../SECURITY.md)：信任边界、默认限制、漏洞报告方式。
- [贡献说明](../CONTRIBUTING.md)：开发环境、测试和 PR 要求。
- [发布准备](OPEN_SOURCE.md)：文件范围、凭据检查、许可证与源码归档。
- [验证记录](VALIDATION.md)：已执行的检查与未执行的验收。
- [变更记录](../CHANGELOG.md)：当前公开版本范围。
- [第三方声明](../THIRD_PARTY_NOTICES.md)：生产依赖许可证与设计参考。

## 设计资料

- [架构与技术选型](ARCHITECTURE.md)。
- [参考项目比较](COMPARISON.md)。
- [WebCodex 源码对照](WEBCODEX_CODE_AUDIT.md)。
- [逐工具静态清单](webcodex-source-inventory.json)与[分类规则](webcodex-parity-map.json)。

源码清单是固定上游修订的设计审计材料，不包含上游实现，也不代表功能对等或已通过公开 CI。运行该清点脚本需要在本地另行检出指定参考修订；参考 checkout 不属于发布内容。
