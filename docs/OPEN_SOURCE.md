# 开源仓库与源码发布

本仓库以 MIT 开放原始代码，版本为 0.4.2，npm 包名为 `homeagent-mcp`。CLI 和源码采用相同许可证；npm 包通过文件白名单只包含编译代码、运行资源、模板、文档和许可证。`homeagent` 名称已存在其他包，因此不使用它作为 npm 包名；命令名仍是 `homeagent`、`homeagent-runner`、`homeagent-server`。包名是否可用及账号发布权限以发布当时的 registry 为准。

## 文件划分

| 路径 | 内容 |
| --- | --- |
| bin/、src/、public/、runtime/ | CLI、Server、Runner、Dashboard 和 Windows 进程树辅助代码 |
| tests/ | 临时目录内运行的工具、安全、协议和 Node/Python 场景测试 |
| deploy/、Dockerfile、compose.yaml | 自托管部署文件 |
| scripts/ | 配置初始化、备份、许可证生成、源码清点和发布检查 |
| docs/ | 部署、协议、工具、开发流程、源码对比及验证边界 |
| licenses/、THIRD_PARTY_NOTICES.md | 锁定的生产依赖许可证与声明 |
| .github/ | CI、自动 Release、问题/PR 模板和依赖更新配置 |

`.env.example` 是 Server 配置模板；Runner 连接设置由 `homeagent login` 生成。真实 `.env`、Runner 配置、设备凭据、数据库、编辑备份、日志、参考源码 checkout、node_modules 和构建目录均不能加入发布内容。

## 本地准备

```sh
npm ci
npm run verify
npm run notices:check
npm audit --omit=dev --audit-level=high
npm run release:npm
npm run test:package
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

- `HomeAgent-v0.4.2-source.tar.gz`
- 对应 `.sha256` 校验文件
- 对应 `.manifest.txt`，包括版本、Git 提交和全部发布路径

归档只从 HEAD 生成，不包含 `.git` 历史、Git 作者配置、忽略文件、数据库、临时凭据或 node_modules。运行命令不会创建远程仓库、push、打标签、上传 Release 或发布 npm。

重建前的旧 Git/运行数据如果被保存在仓库外私有备份中，不要上传该目录；它不是项目源码的一部分。历史验证文档不再引用那些仅存在于旧本地历史的提交号。

## npm 安装包检查

`npm run release:npm` 构建 JavaScript、以 `--ignore-scripts` 打包，并检查归档文件白名单、运行资源及 SHA-512 完整性，输出：

- `release/homeagent-mcp-0.4.2.tgz`
- 对应 `.sha256`
- `release/npm-package.json`：包名、版本、Git commit、校验、dist-tag 和路径清单

`npm run test:package` 把该归档全局安装到隔离的临时 prefix，验证三个真实命令 shim、帮助/版本、配置初始化及拒绝覆盖、Runner 配置，以及从已安装包启动 Server、加载 Dashboard 静态文件和 `/mcp` 认证。Linux 和 Windows CI 都执行该检查。没有上传到 npm，也不修改用户已有全局安装。

## GitHub Actions 自动发布

`.github/workflows/release.yml` 支持两种入口：

1. 推送版本标签，例如 `v0.4.2`。
2. 在 Actions → release → Run workflow 中填写**已经存在**的版本标签。

先按下一节配置 `NPM_TOKEN`。首次推送源码、配置真实 `origin` 并确认 Actions 可用后，可以按下面方式发布：

```sh
# 先提交本次版本的源码和文档，工作区保持干净
git tag -a v0.4.2 -m "HomeAgent v0.4.2"
git push origin v0.4.2
```

本文只是发布说明，准备脚本不会替操作者执行这些命令。

标签必须与 package.json、package-lock.json 及 runtime VERSION 一致，CHANGELOG.md 必须有对应版本的非空条目。预发布可用 `v0.4.2-rc.1`（相关版本文件也必须为 `0.4.2-rc.1`）。禁止把普通分支或不匹配版本伪装成发布。

发布流水线按次序执行：

- 校验实际标签、所指 commit、版本与 changelog。
- 使用同一准确 commit 调用复用 CI，执行 Linux/Windows 测试、安装包实测、许可证/发布检查和 Docker Compose 健康验证。CI 明确安装 Python，不依赖 runner 镜像恰巧预装解释器。
- 通过 Git archive 生成源码 tar.gz；构建并检查 npm tgz，生成两者的校验和清单；发布说明取自当前版本 changelog。
- 发布 npm job 下载已经验证的归档，核对 commit、包名、版本、dist-tag、校验及远程标签，使用 Secret 或 OIDC 发布。它不 checkout、不安装依赖，`npm publish --ignore-scripts` 不执行包生命周期脚本。Secret 只传给该发布步骤。
- npm 成功后，GitHub Release job 才获得 contents:write。该 job 不 checkout 源码、不 npm install、不执行项目代码；再次检查远程标签，先创建 draft、上传源码包与 npm 包及元数据，最后公开。

GitHub Release 使用自动提供的 GITHUB_TOKEN，不需要 GitHub PAT。npm 默认使用下述 NPM_TOKEN，或配置 OIDC。组织/仓库策略必须允许 Release job 写入；请保护版本标签的创建权限。预发布标签自动标为 GitHub prerelease，并使用 npm `next`，避免替换正式版 `latest`。

已经公开的同标签 GitHub Release 不会被覆盖。上传中断时保留 draft，可以对同标签重新运行并补齐资产。若 npm 已成功而 GitHub Release 失败，重试时只在 registry 中该版本的 SHA-512 integrity 与验证包完全一致时跳过重复 npm 发布；不一致则失败。网络错误不会被当成版本不存在。npm 版本不可覆盖，修复后应递增版本，不移动旧标签。

当前发布源码和 npm CLI，不上传 Docker registry，也不产出独立 EXE。GitHub 工作流只有在仓库被推送到 GitHub 并触发后才会实际运行；本地准备不会替代真实 Actions 验收。

## 配置 NPM_TOKEN

1. 使用自己的 npm 账号登录 npm 网站，开启 2FA，创建 **granular access token**。
2. 授予目标包的 **Read and write** 发布权限，并启用 **Bypass 2FA**。只有 stage-only 权限的 Token 不能执行本工作流的直接 `npm publish`。首次创建包时，确保 Token 允许创建该包；只授权另一个已有包不会取得新包权限。首次发布后建议缩小到目标包，设置合适的有效期并按期轮换。不要使用已停用的 classic Token。
3. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，名称填写 **`NPM_TOKEN`**，值粘贴 npm Token。不是 Variables，也不是 GitHub PAT。
4. 保持 `NPM_AUTH_MODE` 未设置（默认 Token），再推送版本标签。仅添加 Secret 不会触发发布。

没有把 Token 放入 `.npmrc`、仓库文件或命令输出。首次发布会创建公开包；若包名已被占用，需先修改 package.json 和 package-lock.json 的包名及对应文档，或改用自己有权限的 npm scope。

**平台规则日期：2026-10-26。** npm 官方已宣布 **2027 年 1 月** 移除 granular Token 直接发布新版本的能力。当前 Token 路径仅适用于仍允许直接发布的阶段；应提前迁移到以下 OIDC 方案，不能把长期自动发布建立在固定 Token 上。以 npm 官方的 access tokens / trusted publishers 文档和账号实际设置为准。

## 切换 npm OIDC trusted publishing

包已存在后，在 npm 包设置中添加 GitHub Actions trusted publisher：仓库 owner/repository 必须与实际公开仓库一致，workflow 文件名为 **`release.yml`**，未配置 GitHub Environment 时留空该项。然后在 GitHub Repository Variables 添加 **`NPM_AUTH_MODE=oidc`**。

工作流已给 npm job 设置 `id-token: write`，使用 npm OIDC/provenance，且会移除 Token userconfig；该路径不读取 `NPM_TOKEN`。切换成功后可删除旧 Secret 并撤销 Token。首次创建包和账号身份验证可能仍需要按 npm 当时要求在本人设备上交互操作。

## 选择托管平台后

由仓库所有者创建公开仓库、配置真实远程地址和维护者联系渠道，启用私有安全报告并检查 Actions 权限。项目不自动填入无法验证的远程地址，也不自动设置分支保护或向外部人员发送消息。

首次推送后观察 Linux、Windows、Docker CI 的实际结果。当前本地验证记录不能冒充该公开仓库已经跑过的 CI。正式使用前完成自己的 HTTPS、备份恢复和系统重启验收。
