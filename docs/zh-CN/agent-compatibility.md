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

人工交接需宿主启用、客户端声明 form elicitation 并实现处理器。六月版本的早期 `elicitation: {}` 视为表单支持。SDK 将 input-required 续传转换为 elicitation 往返；能力缺失返回错误，不代替用户自动确认。

在图形桌面的交互终端运行 `npm run bench:handoff:manual` 可进行真实验收。它只打开可丢弃浏览器和本地测试页；请用物理键鼠输入 `manual-check` 并点击 Complete，再在终端选择 `accept`、`decline` 或 `cancel`。接受时检查新 Accessibility Snapshot 确实包含页面变化；拒绝/取消时检查交接未完成。工具不代填、不代点、不代确认。`HANDOFF_TRANSPORT=http` 选择 HTTP（默认 stdio），`HANDOFF_PROTOCOL=2025-06-18` 选择六月协议（默认十一月）。结果及清理错误写入 `test-results/` 下带时间的 JSON；非交互运行直接拒绝。用户声明与 trusted 事件都不是物理输入的独立鉴证，这个 SDK 客户端也不代表 Pi TUI/模型验收。真实操作仍需人完成。

进度按协议消息顺序验收：queued/running/completed 通知必须先于工具结果。固定的 SDK 2.3.1 客户端把通知回调延后执行，却在收到响应时同步清除回调状态；stdio 合并交付消息时，服务端正确发送也可能丢失 `onprogress` 回调。`node test/sdk-progress.mjs` 使用可控传输复现这一问题。测试直接核对消息顺序，服务端不增加影响分包时序的延时；最终状态以工具结果为准。

## 证据与限制

集成矩阵覆盖两个 2025 版本及 stdio、Streamable HTTP：发现、资源、资源订阅/退订通知、进度、快照、引用、Unicode 填写、点击、截图、导航失效、取消后在期限内继续写入，以及模拟接受/拒绝/取消确认。另验证现代 stdio、严格 `/mcp` 拒绝旧协议、混合 envelope 拒绝、主体/租约隔离、容量、DELETE、空闲回收后引用仍可用，以及活动租约释放。`npm run test:mcp` 包含这些测试，常规集成 CI 也会执行；构建产物验收在 Node.js 24 上覆盖两个版本与两种传输的协商。

[Pi 1.3.0](pi.md) 是额外真实客户端证据，不定义本接口。尚未逐一认证其他 agent；不据此宣称支持更早 MCP 版本、旧式 HTTP+SSE 传输、OAuth、可恢复事件重放、远程不可信多租户或真实人工验收。客户端必须满足所列协议、传输及具体工具的能力要求。
