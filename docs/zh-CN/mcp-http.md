# 本地 Streamable HTTP 与浏览器租约

[English](../mcp-http.md)

HTTP 是常驻本地服务的主入口，与 stdio、socket、InMemory 共用工具实现、`BrowserSessionManager`、浏览器池与租约和 CDP 内核；工具与边界见 [MCP](mcp.md)。服务在 Node.js 22+ 下使用 `node:http` 适配（fetch 处理器，流式 SSE 带背压）。默认 `/mcp` 要求 MCP **2026-07-28**，用应用级 `Browser-Lease-Id` 保持状态，不使用 MCP session。可选[通用兼容入口](agent-compatibility.md)在 `/mcp/compat` 提供 2025 协议会话，作用域限制在同一已认证浏览器租约内。服务面向本地预配置客户端。

## 启动

```sh
npm run build
# 先设置 NODRIVER_MCP_TOKEN 为随机秘密（至少 32 个字符）
node dist/mcp/cli.js --mcp-transport http --port 3100 --browser-transport pipe
```

服务默认只监听 127.0.0.1，在前台运行，日志写 stderr；令牌从环境变量读取且不会打印，`--token-env NAME` 可改用其他变量。默认启动有界面 Chrome，无桌面环境加 `--headless`，嵌入时设 `browser: { launch: { headless: true } }`。

## 租约

最简单的接法只配置 Authorization。省略 `Browser-Lease-Id` 的请求使用该令牌对应 principal 的 `default` 租约，首次 POST 时创建。需要多个独立的浏览器状态时，在 Header 中发送租约名称（1–64 个字母、数字、`.`、`_`、`-`）：同一 principal 下同名即同一租约，首次 POST 时创建；名称只在该 principal 内有效，不能借此访问其他身份的租约。

| 情况                      | 结果           |
| ------------------------- | -------------- |
| 非法租约名称              | 400            |
| 达到租约上限              | 429            |
| 未知或已过期的随机 ID     | 404            |
| GET/DELETE 等非 POST 请求 | 只查找，不创建 |

每个 `/mcp` 响应都带 `Browser-Lease-Id` 响应头，值为实际租约 ID。嵌入时设 `requireLeaseHeader: true` 可强制要求该 Header。

也可以用同一 Bearer 令牌显式创建随机 ID 的租约：

```http
POST /leases
Authorization: Bearer <secret>
Content-Type: application/json

{}
```

201 响应包含随机 `id`、已验证的 principal、创建时间与最后使用时间。请求体只接受空对象，不能指定 profile、身份或浏览器启动参数。管理接口还有 `GET /leases`（只列出该身份的租约）和 `DELETE /leases/{id}`（释放整个租约）；它们是应用 API，不是 MCP 方法。使用随机 ID 时，给客户端的 `/mcp` 连接配置：

```text
Authorization: Bearer <secret>
Browser-Lease-Id: <id from POST /leases>
```

每个请求都重新验证令牌与租约归属；clientInfo、tabId、租约名称和随机 ID 本身都不能充当身份。只接受 `POST /mcp`：initialize、旧协议版本和 `Mcp-Session-Id` 被拒绝，`GET /mcp` 与 `DELETE /mcp` 返回 405（携带未知或越权租约时先返回 404）。租约独立于单个请求和连接，断开后用同一令牌和租约建立新客户端，可以继续使用仍有效的引用。

官方客户端示例（`@modelcontextprotocol/client` 2.3.1）：

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'local-agent', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3100/mcp'), {
    // 省略 Browser-Lease-Id 即使用 default 租约；'Browser-Lease-Id': 'agent-a' 选择命名租约
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
await client.listTools();
await client.callTool({ name: 'browser_open', arguments: { url: 'https://example.com' } });
// 后续 snapshot/find/click 使用同一租约；HTTP 请求结束不会销毁浏览器或引用
await client.close();
// 任务结束时用 DELETE /leases/{id} 释放租约（id 见响应头 Browser-Lease-Id 或 GET /leases）
```

## Header 与来源校验

现代客户端必须发送协议版本、方法、名称等标准 Header。tabId 声明 `x-mcp-header: Tab-Id`，对应 `Mcp-Param-Tab-Id`；官方 SDK 负责解码以及 Header 与 Body 的一致性比较，服务随后仍校验标签页和引用的租约归属。Header 与逐请求 `_meta` 中的版本必须一致且为 2026-07-28。

入口校验精确的 Host 与端口以及 Origin：允许缺省 Origin（本机非浏览器客户端），存在时默认必须等于服务自身的 origin。嵌入时可配置 `allowedOrigins`，但不会因此免除认证；服务不提供通用 CORS 或 OAuth。

## 嵌入与所有权

```ts
import { startBrowserMcpHttpServer } from 'nodriver-ts/mcp/http';

const service = await startBrowserMcpHttpServer({
  tokens: { [secretA]: 'operator-a', [secretB]: 'operator-b' },
  port: 3100,
  browser: { maxLeases: 16, maxBrowsers: 2, contextsPerBrowser: 4 },
});
// 退出时：await service.close();
```

令牌到 principal 的映射由宿主的可信配置提供，不接受客户端指定。`createBrowserMcpHttpService()` 提供同样的 fetch/close 接口供宿主挂载，宿主须保持 loopback 与精确 authority 约束。注入 manager 时，`service.close()` 也会关闭该 manager，因此它应由一个应用服务拥有。

`BrowserSessionManager` 从 `nodriver-ts/mcp` 导出，也可用于 stdio 或 InMemory：

```ts
const manager = new BrowserSessionManager();
const lease = manager.create('verified-local-identity');
const server = createBrowserMcpServer(
  {},
  { manager, principal: lease.principal, leaseId: lease.id },
);
// 将 server 与官方 InMemoryTransport 连接，完整示例见 examples/mcp-inmemory.ts。
// server.close() 只关闭适配器；manager.release(principal, id) 才释放租约。
```

不传 binding 的 `createBrowserMcpServer(options)` 用同一管理器实现创建私有 manager 与租约，连接保留该租约直到 EOF 或 close，然后清理自有 Chrome，外部 Chrome 只断开。InMemory 省去传输编解码，但 MCP 图片仍是 base64；需要 Buffer 时直接使用库的 `screenshot()`。

## 浏览器分配

- **普通租约**：懒分配独立的 BrowserContext，可共用一个受控的 Chrome 进程。同一浏览器进程上的完整操作串行执行，跨租约也不争抢焦点；`browser_tabs`、`browser_dialog` 与 `browser_downloads` 不进入队列。BrowserContext 隔离 Cookie 与存储，但不是对抗性租户之间的安全沙箱。进程达到配置容量后拒绝分配，不无限创建或等待。
- **持久 profile 与外部连接**：`userDataDir` 和 `connect` 使用排他分配，同一管理器最多一个活跃分配，不会同时启动多个 Chrome 打开同一 profile。持久目录在关闭后保留，外部连接只断开并保留其页面。
- **释放**：释放普通租约时关闭其 context；空闲进程可短暂复用，到期或服务退出时关闭并清理临时 profile。`browser_close` 释放当前分配与引用但保留租约，可再次 open；`DELETE /leases/{id}` 永久结束租约。浏览器崩溃后旧引用失效，需要 close 后重新 open，不重放动作。

## 限额、取消与关闭

| 默认值                                   | 范围                                                |
| ---------------------------------------- | --------------------------------------------------- |
| 16 租约 / 2 Chrome / 每 Chrome 4 context | 管理器总上限                                        |
| 32 个等待操作                            | 每租约及每个共享进程的队列，满时明确失败            |
| 30000 ms                                 | 操作期限，包括排队时间                              |
| 1800000 ms / 30000 ms                    | 租约无活动到期 / 空闲进程关闭                       |
| 256 KiB                                  | HTTP 请求体上限（按实际流式读入计），读取也有期限   |
| 16 请求 / 4 订阅                         | 每租约上限                                          |
| ≥ 35000 ms / ≥ 60000 ms                  | 请求建流期限 / 响应流最长寿命（随操作期限上调）     |
| 64 KiB / 8 MiB                           | 订阅输出缓冲 / 一般响应输出缓冲；过慢的客户端被断开 |

CLI 提供 `--max-browsers`、`--contexts-per-browser`、`--max-leases`、`--lease-idle-ms`、`--queue-limit`、`--operation-timeout`，更细的限额通过嵌入选项设置。进行中的请求与操作会保护租约不被闲置回收。长订阅受响应流寿命限制，客户端应重新订阅并读取最新资源。

SSE 断流会取消对应请求，但不释放租约，也不影响其他请求。JSON 模式只返回最终结果，需要断流取消或进度时使用 SSE。已派发的点击和输入不能回滚；取消排队中的操作会将其移除，执行中的操作持有写锁直到收尾。服务退出时停止接收新请求，取消并等待已有工作，再释放租约和进程。MRTR 和网络恢复都不重放页面动作，不支持 Last-Event-ID 恢复。

## 资源、进度与人工交互

两个标准资源只包含当前租约的信息：`browser://state` 包含标签页、frame、对话框、所属 context、队列与引用数；`browser://events` 保留最近 64 条有序状态事件（导航、标签页、对话框、下载等），不是完整的 DOM 或网络事件总线。订阅使用 `subscriptions/listen` 的 resourceSubscriptions 选择 URI，不支持旧的 `resources/subscribe` 和 GET SSE。每个租约有独立的通知总线，状态变化合并后通知；断开后读取最新资源，不保证补齐已淘汰的事件。

请求携带 progressToken 时，工具依次发送 Queued、Running、Completed 三个阶段。auto 模式在需要通知时升级为 SSE，强制 json 模式按 SDK 语义省略中间通知。进度只表示阶段，不代表完成百分比或响应时延。

`browser_handoff({ tabId })` 请用户在可访问的浏览器界面中完成手工任务并确认。它不收集密码，不提供远程桌面，也不自动登录或恢复之前的点击。使用条件：显式 `--headful` / `launch.headless: false`，或宿主确认界面可访问后设置 `humanInteraction: true`，并且客户端声明 `elicitation.form`；否则返回明确错误。默认有窗口不代表远程调用者能访问它，因此不会自动放开人工接管。

`/mcp` 的人工交互使用 2026-07-28 的 InputRequiredResult/MRTR；可选兼容入口启用 SDK 的 legacy elicitation shim。requestState 是有期限的随机标识，服务端保存其标签页、租约和阶段；篡改、跨租约或未知的状态被拒绝，已完成的状态不会再执行前置步骤。完成后只返回当前页面状态，调用者应重新 snapshot。秘密应由用户直接在浏览器中输入。

## 测试覆盖

测试覆盖 JSON 与 SSE、旧协议拒绝、跨请求与跨连接复用、认证与 Header、标签页与引用权限、取消/超时/配额、订阅过滤、人工交互、profile 归属，以及真实 CDP 命令中的禁止项。HTTP 与真实 stdio 子进程使用同一套行为断言。平台与版本见 [支持范围](support.md)。
