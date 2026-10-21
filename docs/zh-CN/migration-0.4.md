# 升级到 0.4

[English](../migration-0.4.md)

0.4 调整运行时要求及两项默认行为。已有的浏览器环境设置仍需显式启用。

## 运行时

安装包、源码开发与测试均使用 **Node.js 24.22.0 或更新版本**。升级包之前，先更新 CI 镜像和 Agent 宿主实际使用的 Node 可执行文件。Bun 专用实现和脚本已移除，Bun 不再属于支持的运行时。使用 npm 安装及标准 ESM 导出。

## Headless User-Agent

`maskHeadless` 现在默认 `false`，保留 Headless Chrome 原生的 UA 与 Client Hints。如需保留此前的遮罩行为，可显式传入 `maskHeadless: true`；这是兼容选项，不是推荐配置。实测遮罩可能让页面/Dedicated Worker 与 Shared/Service Worker 的值不同，见[差分审计](differential-audit.md)。

默认不强制设置语言。`zh-CN`、`en-US` 等都是正常偏好，HTTP 回退项不必与 `navigator.languages` 字面一致。[Worker 启动实验](worker-environment.md) 记录配置作用范围与差异，不把语言选择视为自动化指标。其中暂停 Target 和 Locale 策略仍是实验，不是生产默认行为。

## 输入复现

未传入种子时，每个输入行为实例在初始化时随机生成一次种子。依赖旧默认种子 `1` 的测试应显式指定 `seed: 1`。重新配置时省略 seed 会保留当前随机序列，显式提供 seed 则重置序列。报告包含初始种子及动作开始时的状态。配置方法与复现边界见[输入行为](input.md)。

## Agent 客户端

默认 MCP 入口仍要求 **2026-07-28**。使用 **2025-11-25** 或 **2025-06-18** 的客户端可启用 `--mcp-compat`：stdio 协商这两个版本，HTTP 则提供独立的 `/mcp/compat` 路由。现代 `/mcp` 路由保持严格。兼容入口共用浏览器权限、队列与应用租约，无需降低核心协议版本。人工确认要求客户端声明相应能力，否则明确报错。

完整配置及已验证协议操作与人工/TUI 验收的区别，见[通用 Agent 兼容](agent-compatibility.md)和 [Pi 验证](pi.md)。

## 验证边界

发布使用 Windows/Linux 稳定版回归与最低 Node 版本验收。Beta/Dev/Canary 探针用于补充预警，不保证每个预览版的全部 API。物理输入、真实人工交接及当前版本的完整平台矩阵仍需分别验收。[支持范围](support.md) 中的历史平台记录标明受测版本，不应视为新版认证。
