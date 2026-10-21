# 通用 Agent 兼容

[English](../agent-compatibility.md)

兼容依据是 MCP 协议版本与客户端声明的能力，代码没有按 agent 名称分支。默认仍为 MCP 2026-07-28；可选入口支持 2025-11-25、2025-06-18，共用工具、浏览器管理器、引用、权限和操作队列。

## 接入

使用 `initialize` 的 agent，在 stdio 服务参数中加入 `--mcp-compat`：

```sh
node dist/mcp/cli.js --mcp-compat --headless
```

HTTP 服务也加该参数，客户端连接 `http://127.0.0.1:3100/mcp/compat` 并提供已配置的 Bearer token。`/mcp` 继续要求现代协议逐请求元数据。兼容 stdio 由 SDK 在发现阶段选择协议代际；已建立的旧协议连接拒绝混入现代 envelope。自定义 socket 传输仍只支持现代协议。

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

嵌入 stdio 可使用 `nodriver-ts/mcp/compat` 导出的 `serveCompatibleBrowserMcpStdio(options)`，返回 SDK 可关闭句柄。进程内旧协议宿主可给 `createBrowserMcpServer(options, binding, profile)` 第三个参数传 `'2025'`；传输必须先完成 initialize 和 initialized。`nodriver-ts/mcp` 导出 `MCP_COMPATIBLE_VERSIONS` 和 `McpProtocolProfile`，供宿主查询边界。

## 行为边界

SDK 处理版本协商、旧协议取消与服务端 elicitation。现代协议继续使用逐请求能力；旧协议使用本连接 initialize 中的能力，不在不同协议会话间共享缓存。

HTTP MCP session ID 随机生成，作用域同时绑定已认证主体与浏览器租约，不能作为认证凭证或访问其他租约。原有 token、Origin/Host、请求体、并发请求、响应缓冲和截止时间限制同样适用。每租约默认最多四个 MCP 会话，空闲五分钟回收。活动响应或 GET 流暂缓空闲回收，但仍受 HTTP 流截止时间约束。DELETE 或 MCP 会话到期只关闭协议状态；浏览器由显式关闭、租约释放或租约自身过期回收。释放租约或停止服务会关闭关联 MCP 会话。

旧协议 HTTP 客户端在 SSE 无结果结束时，可能直到自身请求超时或显式关闭才结算等待中的请求，应配置有限请求超时。

取消后必须排空操作队列，后续写入才能继续。错误或断线不会自动重放输入。元素引用仍受文档与租约边界约束。

服务端会在工具结果之前依次发送 queued/running/completed 进度通知。官方 TypeScript 客户端 2.3.1 会延后执行通知回调，却在收到响应时立即清除回调状态；因此 stdio 消息被合并交付时，即使通知已送达，`onprogress` 回调也可能被跳过。最终状态以工具结果为准。

人工交接是可选功能：需宿主启用，客户端声明 form elicitation 并实现处理器。2025-06-18 的 `elicitation: {}` 视为表单支持。SDK 将 input-required 续传转换为 elicitation 往返；能力缺失时返回错误，不会自动代替用户确认。

如需手动体验交接，在图形桌面的交互终端运行 `npm run bench:handoff:manual`。它会在本地测试页上打开一个可丢弃的浏览器；输入 `manual-check` 并点击 Complete，再在终端回答 `accept`、`decline` 或 `cancel`，工具会检查新的无障碍快照是否反映了结果。它不会代填、代点或代确认。`HANDOFF_TRANSPORT=http` 选择 HTTP（默认 stdio），`HANDOFF_PROTOCOL=2025-06-18` 选择六月协议（默认十一月）。结果写入 `test-results/` 下带日期的 JSON 文件。

## 覆盖与限制

集成测试在 stdio 与 Streamable HTTP 上运行两个 2025 版本：发现、资源与订阅、进度、快照、引用、Unicode 填写、点击、截图、导航失效、取消后继续写入，以及接受/拒绝/取消确认。还覆盖严格 `/mcp` 拒绝、混合 envelope 拒绝、主体/租约隔离、会话容量、DELETE、空闲回收与租约释放。`npm run test:mcp` 运行这些测试，构建产物检查也会在两种传输上协商两个版本。

任何使用所列协议版本与对应传输、并声明所用工具所需能力的 agent 都可以接入，[Pi 1.3.0](pi.md) 即为一例。不支持更早的 MCP 版本、旧式 HTTP+SSE 传输、OAuth、可恢复事件重放与远程不可信多租户。
