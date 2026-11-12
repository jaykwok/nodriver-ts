# 本地 Streamable HTTP 与浏览器租约

[English](../mcp-http.md)

HTTP 是常驻本地服务的主入口，与 stdio、socket、InMemory 共用工具实现、`BrowserSessionManager`、浏览器池与租约和 CDP 内核；工具与边界见 [MCP](mcp.md)。服务在 `node:http` 上运行 fetch 处理器，流式 SSE 带背压。默认 `/mcp` 要求 MCP **2026-07-28**，通过应用级的 `Browser-Lease-Id` 请求头保持状态，不使用 MCP session。可选的[通用兼容入口](agent-compatibility.md)在 `/mcp/compat` 提供有状态的 2025 协议会话，其作用域限定在同一已认证的浏览器租约内。服务面向本机预配置的客户端。

## 启动

```sh
npm run build
# 先设置 NODRIVER_MCP_TOKEN 为随机秘密（至少 32 个字符）
node dist/mcp/cli.js --mcp-transport http --port 3100 --browser-transport pipe
```

服务默认只监听 127.0.0.1，在前台运行，日志写 stderr。令牌从环境变量读取且不会打印，`--token-env NAME` 可改用其他变量。默认启动有界面的 Chrome；无桌面环境时加 `--headless`，嵌入时设 `browser: { launch: { headless: true } }`。

## 租约

最简单的接法只配置 Authorization。省略 `Browser-Lease-Id` 的请求使用该令牌所映射认证主体的 `default` 租约。需要多个独立的浏览器状态时，在请求头中发送租约名称（1–64 个字母、数字、`.`、`_` 或 `-`）；同一认证主体下同名即同一租约。命名租约和 default 租约都在首次 POST 时创建。名称只在该认证主体内有效，不能借此访问其他身份的租约。

| 情况                      | 结果           |
| ------------------------- | -------------- |
| 非法租约名称              | 400            |
| 达到租约上限              | 429            |
| 未知或已过期的随机 ID     | 404            |
| GET/DELETE 等非 POST 请求 | 只查找，不创建 |

`/mcp` 上 MCP 消息的响应带有 `Browser-Lease-Id` 响应头，值为实际租约 ID。嵌入时设 `requireLeaseHeader: true` 可强制要求该请求头；无论是否强制，其值都是租约名称或 ID。

也可以用同一 Bearer 令牌显式创建随机 ID 的租约：

```http
POST /leases
Authorization: Bearer <secret>
Content-Type: application/json

{}
```

201 响应包含随机 `id`、已验证的主体、创建时间与最后使用时间。请求体只能是空对象，不能指定 profile、身份或浏览器启动参数。`GET /leases` 只列出该身份的租约；`DELETE /leases/{id}` 释放整个租约：成功返回 204，未知或越权的租约返回 404，关闭其浏览器状态失败时返回 500（原因交给 `onError`）。它们是应用 API，不是 MCP 方法。使用随机 ID 时，给客户端的 `/mcp` 连接配置：

```text
Authorization: Bearer <secret>
Browser-Lease-Id: <id from POST /leases>
```

每个请求都重新验证令牌与租约归属；clientInfo、tabId、租约名称和随机 ID 本身都不能充当身份。只接受 `POST /mcp`：initialize、旧协议版本和 `Mcp-Session-Id` 被拒绝，`GET /mcp` 与 `DELETE /mcp` 返回 405（携带未知或越权租约时先返回 404）。租约的生命周期长于单个请求或连接：用同一令牌和租约建立的新客户端可以继续使用仍有效的引用。

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

## 请求头与来源校验

现代客户端必须发送协议版本、方法、名称等标准请求头。tabId 声明 `x-mcp-header: Tab-Id`，对应 `Mcp-Param-Tab-Id`；官方 SDK 负责解码并检查请求头与请求体一致，服务仍会校验标签页和引用是否属于该租约。请求头与逐请求 `_meta` 中的版本必须一致且为 2026-07-28。

服务校验精确的 Host 与端口，以及 Origin。允许缺省 Origin（本机非浏览器客户端）；存在时默认必须等于服务自身的源。嵌入时可用 `allowedOrigins` 放宽，但不会因此免除认证。服务不提供通用 CORS 或 OAuth。Host 或 Origin 被拒绝时返回 403，缺少令牌或令牌错误返回 401，POST 不带 `Content-Type: application/json` 返回 415，请求体超限返回 413。

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

令牌到认证主体的映射来自宿主的可信配置，客户端不能指定。`createBrowserMcpHttpService()` 提供同样的 fetch/close 接口供宿主挂载，宿主须保持回环与精确 authority 约束。`browser` 选项与已有的 `manager` 只能二选一。`service.close()` 也会关闭注入的管理器，因此它应由一个应用服务独占；`startBrowserMcpHttpServer()` 监听失败时不会关闭注入的管理器。

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

不传 binding 的 `createBrowserMcpServer(options)` 会创建私有的管理器与租约。连接保留该租约直到 EOF 或 close，然后清理自有 Chrome；外部 Chrome 只断开连接。InMemory 省去传输编解码，但 MCP 图片仍是 base64；需要 Buffer 时直接使用库的 `screenshot()`。

## 浏览器分配

- **普通租约**：各自懒分配独立的 BrowserContext，多个租约可共用一个受控的 Chrome 进程。同一浏览器进程上的操作逐个执行，跨租约也不会争抢焦点；`browser_tabs`、`browser_dialog` 与 `browser_downloads` 不进入队列。BrowserContext 隔离 Cookie 与存储，但不是对抗性租户之间的安全沙箱。进程达到配置容量后拒绝分配，不会继续创建或等待。输入被阻塞的浏览器不会获得新分配，并在无人使用后关闭。
- **持久 profile 与外部连接**：`userDataDir` 和 `connect` 使用排他分配，每个管理器最多一个活跃分配，因此不会有两个 Chrome 打开同一 profile。持久目录在关闭后保留；外部连接只断开，其页面保留。
- **释放**：释放普通租约时关闭其上下文。空闲进程可短暂复用；到期或服务退出时将其关闭并删除临时 profile。`browser_close` 释放当前分配与引用但保留租约，之后可再次 open；`DELETE /leases/{id}` 则永久结束租约。浏览器崩溃后旧引用失效，需要 close 后重新 open。动作不会重放。

## 限额、取消与关闭

| 默认值                                  | 范围                                                |
| --------------------------------------- | --------------------------------------------------- |
| 16 租约 / 2 Chrome / 每 Chrome 4 上下文 | 管理器总上限                                        |
| 32 个等待操作                           | 每租约及每个共享进程的队列，满时明确失败            |
| 30000 ms                                | 操作期限，包括排队时间                              |
| 1800000 ms / 30000 ms                   | 租约闲置到期 / 空闲进程关闭                         |
| 256 KiB                                 | HTTP 请求体上限（按实际流式读入计），读取也有期限   |
| 16 请求 / 4 订阅                        | 每租约上限                                          |
| ≥ 35000 ms / ≥ 60000 ms                 | 请求建流期限 / 响应流最长寿命（随操作期限上调）     |
| 64 KiB / 8 MiB                          | 订阅输出缓冲 / 一般响应输出缓冲；过慢的客户端被断开 |

对应的 CLI 参数见 [MCP](mcp.md#cli-选项)，更细的限额通过嵌入选项设置。进行中的请求与操作会保护租约不被闲置回收。长订阅受响应流寿命限制，客户端应重新订阅并读取最新资源。

SSE 断流会取消对应请求，但不释放租约，也不影响其他请求。JSON 模式只返回最终结果；需要进度或断流取消时使用 SSE。已派发的点击和输入不能回滚。取消排队中的操作会将其移出队列，执行中的操作持有写锁直到结束。服务关闭时以 503 拒绝新请求，取消并等待已有工作，再释放租约和进程。MRTR 和网络恢复都不重放页面动作；由于流无法恢复，带 `Last-Event-ID` 的请求返回 400。

## 资源、进度与人工交互

两个标准资源只包含当前租约的信息。`browser://state` 包含标签页、frame、对话框、所属上下文、队列与引用数。`browser://events` 保留最近 64 条有序状态事件（导航、标签页、对话框、下载、被对话框挂起的动作的结果等），不是完整的 DOM 或网络事件总线。在 `/mcp` 上，订阅通过 `subscriptions/listen` 的 resourceSubscriptions 选择 URI，不支持旧的 `resources/subscribe` 和 GET SSE。每个租约有独立的通知总线，状态变化合并后再通知。断开后读取最新资源即可，已淘汰的事件不会补发。

请求携带 progressToken 时，工具依次报告 Queued、Running、Completed 三个阶段。auto 模式在需要通知时升级为 SSE，强制 JSON 模式按 SDK 语义省略中间通知。进度记录当前阶段，不包含完成百分比或时延。

`browser_handoff({ tabId })` 请用户在可访问的浏览器界面中完成手工任务并确认。它不收集密码，不提供远程桌面，也不自动登录或恢复之前的点击。使用条件：显式 `--headful` / `launch.headless: false`，或由已确认界面可访问的宿主设置 `humanInteraction: true`（`--allow-handoff`），并且客户端声明 `elicitation.form`；否则返回明确的错误。启用人工接管前，应为调用方安排浏览器界面的访问方式，远程服务同样如此。

`/mcp` 的人工交互使用 2026-07-28 的 InputRequiredResult/MRTR；兼容入口启用 SDK 的 legacy elicitation shim。requestState 是五分钟后过期的随机标识，服务端保存其标签页、租约和阶段。篡改、跨租约或未知的状态被拒绝，已完成的状态不会再执行前面的步骤。完成后只返回当前页面状态，调用者应重新 snapshot。秘密应由用户直接在浏览器中输入。

## 远程人工接管

`browser_handoff({ tabId, mode: "remote", resumeCondition })` 让用户在本 HTTP 服务提供的查看页面上操作标签页，例如在没有屏幕的服务器上完成登录步骤。需要开启 `--remote-handoff`（嵌入时为 `remoteHandoff: true` 或选项对象），在无头模式下也能使用。stdio 和 socket 传输不支持。

工具通过 URL 型 elicitation 把私密链接交给客户端，链接不进入模型上下文，需要客户端声明 `elicitation.url` 能力。用户拒绝时接管结束。只有开启 `--remote-handoff-link-in-result`（`linkInResult: true`）时，链接才出现在工具结果里，模型可以读到。调用返回 `{ handoffId, expiresAt }`；之后反复调用 `browser_handoff_wait({ handoffId, timeout })`，直到 `state` 为 `ended`，也可以传 `cancel: true` 取消。`browser://events` 会发出 `handoff-started`、`handoff-connected` 和 `handoff-ended`。

`resumeCondition` 满足、用户点击完成、取消、标签页关闭或过期，任一发生即结束接管。`resumeCondition` 为 `{ url?, selector?, timeout }`：`url` 是主 frame 的完整 URL，`*` 匹配任意字符；`selector` 在隔离世界中查询；同时给出时两者都要满足。`reason` 的取值为 `condition`、`completed`、`cancelled`、`expired`、`tab-closed` 或 `released`。除非主机设置 `maxDuration`，接管最长 15 分钟。

接管期间，该租约的其他工具立即以 `HandoffActiveError` 失败，不会排队，`browser_tabs` 和 `browser_handoff_wait` 除外。`browser_handoff_wait` 报告 `ended` 后，这些工具即可再次运行。闲置清理不会回收该租约。结束后请重新读取快照，原有 ref 可能已失效。

服务只监听本机回环地址，并保留 Host 和 Origin 校验；需要从其他机器访问时，请自行建立隧道，例如 `ssh -L 3100:127.0.0.1:3100 host`，并保持本地端口相同。链接包含 256 位令牌，只能使用一次，5 分钟后过期（`tokenTtl`），并绑定认证主体、租约和标签页；链接在此期间未被打开时，接管以 `expired` 结束。打开链接时，令牌被换成 `HttpOnly; SameSite=Strict`、路径限定在该次接管的 cookie，地址栏里不再保留令牌。页面发出的请求必须同源。页面的 CSP 为 `default-src 'self'` 并设置 `frame-ancestors 'none'`，没有内联脚本。未打开的链接落到谁手里谁就能使用，请按密钥对待。跨机器的传输加密由隧道提供，而不是本服务。

画面通过 SSE 传输 `Page.startScreencast` 的帧，每帧在查看页读取之后才确认，所以连接较慢时帧率会自动降低。同一时刻只有一个查看页接收画面：新的 `/frames` 请求会取代之前的流，多个请求依次打开。输入通过 POST 回传并转成 CDP 输入：鼠标、滚轮和按键；输入法的合成文本和粘贴走 `Input.insertText`。`audit` 选项接收 `started`、`connected`、`ended` 记录和输入次数，不包含输入内容；CLI 把它们写到 stderr。

## 测试覆盖

测试覆盖 JSON 与 SSE、旧协议拒绝、跨请求与跨连接复用、认证与请求头、标签页与引用权限、取消、超时与配额、订阅过滤、人工交互、远程人工接管（含在真实页面上的点击）、profile 归属，以及真实 CDP 流量中的禁止命令。HTTP 与真实 stdio 子进程运行同一套行为断言。平台与版本见[支持范围](support.md)。
