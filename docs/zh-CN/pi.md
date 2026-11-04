# 在 Pi 中使用

[English](../pi.md)

[Pi 1.3.0](https://pi.dev/changelog/releases/1.3.0)（`@earendil-works/pi-coding-agent@1.3.0`）通过内置 MCP 扩展以 stdio 或 Streamable HTTP 接入。Pi 使用 MCP 2025-11-25 的 `initialize`，因此需要[兼容入口](agent-compatibility.md)。

## 配置

在 Pi 的 MCP 配置中，给 stdio 服务参数加入 `--mcp-compat`。使用 HTTP 时，以 `--mcp-compat` 启动服务，让 Pi 连接 `/mcp/compat` 并携带 Bearer token。配置格式见 [Pi 的 MCP 文档](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/mcp.md)。

## 行为

| 入口              | 结果                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| 默认入口          | 在启动浏览器前拒绝 initialize 2025-11-25：stdio 错误 -32022，HTTP 400 |
| `--mcp-compat`    | 协商为 2025-11-25，列出 26 个工具并执行浏览器操作                     |
| 取消              | 取消等待中的请求会释放队列，下一个操作恰好执行一次                    |
| `browser_handoff` | 返回能力不支持错误，因为 Pi 未声明 form elicitation                   |

## 测试

`test/pi-compat.mjs` 使用 Pi 自带的 MCP 客户端及其扩展的 `McpServerConnection`，通过 stdio 与回环 HTTP 连接构建后的服务：

```sh
npm install --prefix tmp/pi-1.3.0 --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.3.0
npm run build
node test/pi-compat.mjs
```

`tmp/` 已被 git 忽略。要使用其他位置的安装，把 `PI_MCP_PACKAGE` 指向其中的 `@earendil-works/pi-mcp` 目录，`pi-coding-agent` 须位于同级目录。脚本会检查精确的包版本，并确认默认入口在不启动浏览器的情况下拒绝 Pi。随后打开标签页、填写 Unicode 文本、快照、取消等待、点击、截图、导航、拒绝失效引用并关闭浏览器。Pi 不是项目依赖，服务端也没有针对 Pi 的代码分支。
