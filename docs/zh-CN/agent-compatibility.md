# 通用 Agent 兼容

[English](../agent-compatibility.md)

兼容依据是 MCP 协议版本与客户端声明的能力，代码不按 agent 名称分支。默认仍为 MCP 2026-07-28。可选入口支持 2025-11-25 与 2025-06-18，共用同一套工具、浏览器管理器、引用、权限和操作队列。

## 接入

使用 `initialize` 的 agent，在 stdio 服务参数中加入 `--mcp-compat`：

```sh
node dist/mcp/cli.js --mcp-compat --headless
```

使用 HTTP 时，以同一参数启动服务，客户端连接 `http://127.0.0.1:3100/mcp/compat` 并携带预配的 Bearer 令牌；`/mcp` 仍要求现代协议的逐请求元数据。兼容 stdio 连接可接受两种协议代际，由 SDK 在发现阶段选择；旧协议连接建立后会拒绝现代 envelope。自定义 socket 传输只支持现代协议。

```ts
import { startBrowserMcpHttpServer } from 'nodriver-ts/mcp/http';

const service = await startBrowserMcpHttpServer({
  tokens: { [process.env.NODRIVER_MCP_TOKEN!]: 'local-agent' },
  compatibility: true,
  maxCompatibilitySessionsPerLease: 4,
  compatibilitySessionIdleMs: 300_000,
  browser: { launch: { headless: true } },
});
// 结束时 await service.close()。
```

嵌入 stdio 时，`nodriver-ts/mcp/compat` 导出 `serveCompatibleBrowserMcpStdio(options)`，返回 SDK 的可关闭 stdio 句柄。进程内的旧协议宿主可给 `createBrowserMcpServer(options, binding, profile)` 的第三个参数传 `'2025'`；其传输须先完成 initialize 和 initialized，才能调用工具。`nodriver-ts/mcp` 导出 `MCP_COMPATIBLE_VERSIONS` 和 `McpProtocolProfile`，供宿主查询边界。

## 行为边界

SDK 负责版本协商、旧协议请求的取消和服务端发起的 elicitation。现代请求各自携带能力声明。旧协议的能力来自该连接的 initialize 消息，不同协议会话之间从不共享能力缓存。

HTTP MCP session ID 随机生成，作用域同时绑定已认证的 principal **与**浏览器租约；它不能用于认证调用者，也不能访问其他租约。`/mcp` 的令牌、Origin/Host、请求体、并发请求、响应缓冲和期限限制在这里同样适用。兼容会话使用 SSE 响应。每个租约默认最多保留四个 MCP 会话：超出上限的新会话返回 429，未知 session ID 的请求返回 404，initialize 失败的会话立即释放名额。空闲会话五分钟后到期；活动的响应或 GET 流会推迟到期，但仍受 HTTP 流期限约束。DELETE 或会话到期只关闭协议状态；浏览器状态保留到被显式关闭、租约被释放或租约自身到期。释放浏览器租约或停止服务会关闭其 MCP 会话。SSE 流未返回结果就结束时，旧协议 HTTP 客户端可能要等到自身超时或显式关闭才结算等待中的请求，因此应配置有限的客户端请求超时。

取消会先释放操作队列，后续写入才能继续。错误和断线都不会触发输入重放。元素引用仍受同样的文档与租约边界约束。

服务端在工具结果之前依次发送 queued/running/completed 进度通知。官方 TypeScript client 2.3.1 会延后执行通知回调，却在收到响应时立即清除回调状态；因此 stdio 消息一起到达时，即使通知已送达，`onprogress` 回调也可能被跳过。以工具结果为准。

人工接管是可选功能：需宿主启用，客户端须声明 form elicitation 并实现处理器。2025-06-18 的 `elicitation: {}` 能力视为支持表单。SDK 将 input-required 续传转换为一次 elicitation 往返。能力缺失时返回错误，不会自动替用户确认。

如需手动试用接管，在图形桌面的交互终端中运行 `npm run bench:handoff:manual`。它会在一个本地测试页上打开一次性浏览器。输入 `manual-check` 并点击 Complete，再在终端回答 `accept`、`decline` 或 `cancel`；回答 `accept` 后，它会检查新的无障碍快照是否显示页面已完成。它不会代填、代点或代为确认。`HANDOFF_TRANSPORT=http` 选择 HTTP（默认 stdio），`HANDOFF_PROTOCOL=2025-06-18` 选择该协议版本（默认 2025-11-25）。结果写入 `test-results/handoff-manual-<timestamp>.json`。

## 覆盖与限制

集成测试在 stdio 与 Streamable HTTP 上运行两个 2025 版本：发现、资源与订阅、进度、快照、引用、Unicode 填写、点击、截图、导航失效、取消后继续写入，以及 accept/decline/cancel 三种 elicitation。还覆盖严格 `/mcp` 拒绝、混合 envelope 拒绝、principal/租约隔离、会话容量、DELETE、空闲到期与租约释放。`npm run test:mcp` 运行这些测试，构建产物检查也会在两种传输上协商两个版本。

任何以所列协议版本、通过对应传输通信，并声明所用工具所需能力的 agent 都可以接入，[Pi 1.3.0](pi.md) 即为一例。不支持更早的 MCP 版本、旧式 HTTP+SSE 传输、OAuth、可恢复的事件重放和远程不可信多租户。
