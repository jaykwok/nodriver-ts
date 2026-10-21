# Pi 1.3.0 接入验证

[English](../pi.md)

目标为 [Pi 1.3.0](https://pi.dev/changelog/releases/1.3.0)：`@earendil-works/pi-coding-agent@1.3.0`，固定依赖 `@earendil-works/pi-mcp@1.3.0`。其内置 MCP 扩展支持 stdio、Streamable HTTP；未使用第三方扩展或模型凭据。

## 实测结果

2026-10-21，Windows x64 / Node.js 24.22.0 / Chrome 155.0.8059.85，`test/pi-compat.mjs` 分别使用 Pi 原始客户端与内置扩展 `McpServerConnection` 连接构建后的 stdio 和真实 loopback HTTP：

| 入口             | 原始客户端、内置扩展，均覆盖两种传输                                   |
| ---------------- | ---------------------------------------------------------------------- |
| 默认现代协议路径 | 四次均在启动浏览器前拒绝 initialize 2025-11-25：stdio -32022，HTTP 400 |
| 通用兼容入口     | 四次均协商为 2025-11-25，发现 26 个工具并完成浏览器操作                |
| 取消             | 中断等待不存在选择器的请求；后续点击完成，点击计数恰好为一次           |
| 人工交接         | 明确返回能力不支持；内置扩展未声明 elicitation.form                    |

成功流程包含打开页面、执行夹具脚本、获取引用、填写 Unicode、快照、取消等待、点击、读取点击计数、截图、导航、拒绝失效引用、关闭浏览器。验证的是实际内置连接层，未运行交互式 TUI 或模型；真实人工交接和模型自主选工具尚未验证。

## 使用与复现

Pi 的 stdio 服务参数加入 `--mcp-compat`。HTTP 服务启用同一参数，客户端使用 `/mcp/compat` 与 Bearer token。配置与生命周期边界见[通用 Agent 兼容](agent-compatibility.md)，Pi 配置格式见[固定版本文档](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/mcp.md)。

```sh
npm install --prefix tmp/pi-1.3.0 --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.3.0
npm run build
node test/pi-compat.mjs
```

`tmp/` 已忽略。可选探针检查包身份及精确版本，保留严格入口拒绝断言，并记录兼容入口成功结果。`PI_MCP_PACKAGE` 可指向其他位置的同版本包。Pi 不进入项目依赖或运行时代码分支。

固定版本[客户端](https://github.com/earendil-works/pi/blob/v1.3.0/packages/mcp/src/client.ts)发送 initialize/initialized 和 notifications/cancelled；[内置扩展](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/extensions/mcp/runtime.ts)没有表单 elicitation 处理器。仅改版本号不能实现这些语义；通用入口采用 SDK 的协商、取消和确认续传处理。
