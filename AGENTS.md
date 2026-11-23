# nodriver-ts 维护指南

## 项目约定

- npm 包名为 `nodriver-ts`，命令行为 `nodriver-mcp`。使用 Node.js 和 npm，最低 Node.js 版本以 `package.json` 的 `engines.node` 为准。
- 保持原始会话的协议约定。使用 `attach: 'none'` 和 `TargetSession` 的调用方自行选择启用哪些 CDP 域。隔离世界辅助函数依靠对象句柄验证上下文，验证失败时按 API 契约重建或报错。修改这条路径时，同步检查实际发送的 CDP 命令以及导航、取消、迟到回包和清理行为。
- README 和公开指南面向使用者，说明当前行为、用法和限制。英文与简体中文同步更新，破坏性变更和迁移示例写入对应版本的 `CHANGELOG.md`。调查过程和本地运行记录放在已忽略的 `docs/dev/` 或 `test-results/`。中文标题和普通用语用中文，保留代码标识符；修改后检查标题链接、UTF-8 编码和 U+FFFD 替换字符。
- 在维护者的 Windows 工作站上，使用静态检查和 `ScriptedChrome` 等离线测试。此前反复以新配置启动浏览器曾触发 Windows 账户锁定。在维护者确认防护配置有效前，将真实 Chrome/Edge 测试、`test:dist` 和需要启动浏览器的追踪任务交给 CI。
- 更新公开 API 测试映射时，从最终代码提交的 Browser regression 运行下载 `api-test-map-ubuntu-latest` 和 `api-test-map-windows-latest`。把两份产物的 `dev/api-trace/` 合并到干净的本地追踪目录，运行 `node test/api-map.ts --reuse`，核对中英文映射的差异。映射随包发布，提交后按新 SHA 验证。

## 发布稳定版本

1. **准备候选提交。** 核对目标版本、`package.json`、`package-lock.json` 的顶层版本与根包版本，以及 `CHANGELOG.md` 的版本标题和日期。检查 `git status --short`，特别是新增源码、测试和文档。运行 `npm run format:check`、`npm run check`、`npm run build` 和相关离线单测。提交并推送发布候选，记录 `git rev-parse HEAD` 的完整 SHA。
2. **在候选 SHA 上验证。** 推送会触发 `test.yml`（Browser regression）。用 `gh workflow run platforms.yml --ref <候选分支>` 手动启动 Platform matrix。用 `gh run list --commit <SHA> --json databaseId,workflowName,event,headSha,status,conclusion` 核实运行对应的提交，再用 `gh run watch <运行ID> --exit-status` 等待。处理该提交上的失败，记录首次失败和重跑结果。若修改了代码、文档或版本，改用新 SHA 验证。
3. **推送标签。** 在候选提交的 CI 通过后，核实目标 SHA 已进入 `origin/main`，并核对远端同名标签和 npm 同版本的状态。首次发布该版本时，用 `git tag -a vX.Y.Z <SHA> -m vX.Y.Z` 创建带注释的标签，再用 `git push origin refs/tags/vX.Y.Z` 推送这个标签。将命令中的 `X.Y.Z` 替换为实际包版本。
4. **跟进 npm 发布。** 标签推送触发 `release.yml` 和新一轮 Browser regression。Release 检查标签与包版本，并等待同一 SHA 上最新的两项必需工作流成功。PR 合并提交的结果和 Chromium preview 均不能代替这两项检查。`verify` 运行单元与构建产物测试并打包，`publish` 通过 npm OIDC 可信发布上传已验证的 tarball 和 provenance。用 `gh run watch` 跟进 Release 到结束。恢复中断的发布时，先核对远端标签指向、工作流状态和 npm 已发布版本，再从缺失步骤继续。
5. **核验并创建 GitHub Release。** 用 `npm view nodriver-ts@X.Y.Z version dist.integrity dist.attestations --json` 核对版本、完整性和来源证明，用 `npm view nodriver-ts dist-tags.latest` 核对稳定版标签。索引可能稍晚更新，短暂的 404 可稍后重查。将本版本的 CHANGELOG 正文单独保存为 UTF-8 临时文件，再运行 `gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <说明文件> --latest`。最后用 `gh release view vX.Y.Z --json tagName,url` 核对页面并报告 npm 版本、提交 SHA 和发布链接。

发布门槛与事件配置以 [Release 工作流](.github/workflows/release.yml)、[门槛判断代码](test/release-gate.ts)、[Browser regression](.github/workflows/test.yml) 和 [Platform matrix](.github/workflows/platforms.yml) 为准。
