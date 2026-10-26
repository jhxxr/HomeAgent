# 开源仓库与源码发布

本仓库以 MIT 开放原始代码，版本为 0.3.0。npm 包仍保留 `private: true`，避免误发布；Git 源码可以按 LICENSE 使用。没有预填仓库地址、维护者私人邮箱或绑定某个 GitHub 账户。

## 文件划分

| 路径 | 内容 |
| --- | --- |
| src/、public/、runtime/ | Server、Runner、Dashboard 和 Windows 进程树辅助代码 |
| tests/ | 临时目录内运行的工具、安全、协议和 Node/Python 场景测试 |
| deploy/、Dockerfile、compose.yaml | 自托管部署文件 |
| scripts/ | 配置初始化、备份、许可证生成、源码清点和发布检查 |
| docs/ | 部署、协议、工具、开发流程、源码对比及验证边界 |
| licenses/、THIRD_PARTY_NOTICES.md | 锁定的生产依赖许可证与声明 |
| .github/ | CI、自动 Release、问题/PR 模板和依赖更新配置 |

`.env.example` 和 `runner.example.json` 是模板。真实 `.env`、Runner 配置、设备凭据、数据库、编辑备份、日志、参考源码 checkout、node_modules 和构建目录均不能加入发布内容。

## 本地准备

```sh
npm ci
npm run verify
npm run notices:check
npm audit --omit=dev --audit-level=high
```

`npm run release:check` 检查 Git 跟踪文件和未忽略的新文件，验证敏感凭据模式、禁止的运行目录、许可证/版本一致性及本地 Markdown 链接。提交前可以使用 `node scripts/check-release.mjs --staged`，检查暂存区实际内容。它不会打印命中的秘密正文。

这些只是可复现的自动检查，不能证明没有未知类型的敏感数据。公开前仍需人工检查文件列表、部署示例和私有路径。不要用“把整个工作目录压缩”代替源码发布。

更新生产依赖后：

```sh
npm ci
npm run notices
npm run notices:check
```

提交 package-lock.json 与 licenses/npm-runtime.txt，保留原依赖条款。发布脚本和 CI 不执行参考仓库代码。

## 生成干净源码包

将准备好的文件提交到 Git，工作区保持干净：

```sh
npm run release:source
```

输出位于被忽略的 release/：

- `HomeAgent-v0.3.0-source.tar.gz`
- 对应 `.sha256` 校验文件
- 对应 `.manifest.txt`，包括版本、Git 提交和全部发布路径

归档只从 HEAD 生成，不包含 `.git` 历史、Git 作者配置、忽略文件、数据库、临时凭据或 node_modules。运行命令不会创建远程仓库、push、打标签、上传 Release 或发布 npm。

重建前的旧 Git/运行数据如果被保存在仓库外私有备份中，不要上传该目录；它不是项目源码的一部分。历史验证文档不再引用那些仅存在于旧本地历史的提交号。

## GitHub Actions 自动发布

`.github/workflows/release.yml` 支持两种入口：

1. 推送版本标签，例如 `v0.3.0`。
2. 在 Actions → release → Run workflow 中填写**已经存在**的版本标签。

首次推送源码、配置真实 `origin` 并确认 Actions 可用后，可以按下面方式发布：

```sh
# 先提交本次版本的源码和文档，工作区保持干净
git tag -a v0.3.0 -m "HomeAgent v0.3.0"
git push origin v0.3.0
```

本文只是发布说明，准备脚本不会替操作者执行这些命令。

标签必须与 package.json、package-lock.json 及 runtime VERSION 一致，CHANGELOG.md 必须有对应版本的非空条目。预发布可用 `v0.4.0-rc.1`（相关版本文件也必须为 `0.4.0-rc.1`）。禁止把普通分支或不匹配版本伪装成发布。

发布流水线按次序执行：

- 校验实际标签、所指 commit、版本与 changelog。
- 使用同一准确 commit 调用复用 CI，执行 Linux/Windows 测试、许可证/发布检查和 Docker Compose 健康验证。CI 明确安装 Python，不依赖 runner 镜像恰巧预装解释器。
- 通过 Git archive 生成源码 tar.gz、SHA-256 和文件 manifest；发布说明取自当前版本 changelog。
- 只读权限上传/传递构建资产，发布 job 才授予 contents:write。该 job 不 checkout 源码、不 npm install、不执行项目代码。
- 再次检查远程标签仍指向已验证的 commit，先创建 draft、上传全部资产，再发布。预发布标签自动标为 prerelease。

只使用 GitHub 自动提供的 GITHUB_TOKEN，不需要额外 PAT、npm token、模型密钥或第三方发布 Action。组织/仓库策略必须允许此 job 写入 Release；请保护版本标签的创建权限。

已经公开的同标签 Release 不会被覆盖。上传中断时保留 draft，可以对同标签重新运行并补齐资产；已公开版本有问题时应提交修复并递增版本，不移动旧标签。操作标签在校验/构建后被移动会使发布失败。

当前只自动发布**源码包**，不发布 npm、不上传 Docker registry，也不宣称产出了独立 EXE。GitHub 工作流只有在仓库被推送到 GitHub 并触发后才会实际运行；本地准备不会替代真实 Actions 验收。

## 选择托管平台后

由仓库所有者创建公开仓库、配置真实远程地址和维护者联系渠道，启用私有安全报告并检查 Actions 权限。项目不自动填入无法验证的远程地址，也不自动设置分支保护或向外部人员发送消息。

首次推送后观察 Linux、Windows、Docker CI 的实际结果。当前本地验证记录不能冒充该公开仓库已经跑过的 CI。正式使用前完成自己的 HTTPS、备份恢复和系统重启验收。
