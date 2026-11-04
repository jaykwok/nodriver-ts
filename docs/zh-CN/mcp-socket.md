# 本地 socket / Windows 命名管道

[English](../mcp-socket.md)

`--mcp-transport socket` 或 `nodriver-ts/mcp/socket` 提供常驻的本地 IPC 服务：Linux 和 macOS 上为 Unix domain socket，Windows 上为本机命名管道。它与其他接入（[MCP](mcp.md)）共用工具、应用租约、浏览器池、资源和取消机制，仅支持 MCP 2026-07-28。这是需要配套客户端的自定义传输；普通 MCP 客户端请使用 stdio 或 HTTP。

服务在 `StdioServerTransport` 之上运行官方 SDK 的 `serveStdio(factory, { transport, legacy: 'reject' })`，复用其 UTF-8 NDJSON 分帧、协议发现、订阅和取消。分帧方式见 [MCP 自定义传输](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)，路径格式见 [Node IPC](https://nodejs.org/api/net.html#ipc-support)。

## 启动

先把 `NODRIVER_MCP_TOKEN` 设为随机秘密（至少 32 个字符）：

```sh
npm run build
node dist/mcp/cli.js --mcp-transport socket
```

服务在前台运行，实际路径写 stderr，stdout 不输出日志或凭证。默认使用随机路径：在系统临时目录下新建的 `nodriver-mcp-*` 目录中的 `mcp.sock`，Windows 上为 `\\.\pipe\nodriver-<随机值>`。`--socket-path PATH` 可改为指定路径，`--token-env` 可改用其他令牌变量。Chrome 参数与其他传输相同。

- **Linux 和 macOS**：路径必须是绝对路径，最多 100 个 UTF-8 字节。父目录必须属于运行用户，没有组或其他用户权限，且路径中不能经过符号链接。socket 权限为 0600；默认临时目录为 0700，关闭时删除。已存在的文件或 socket 一律不会被替换，崩溃残留需由调用者核实后删除。
- **Windows**：只接受名为 `\\.\pipe\nodriver-` 加 1–80 个字母、数字、`.`、`_` 或 `-` 的本机管道，不接受远程管道。使用系统默认的管道 ACL，并在其上强制令牌认证；不提供跨用户沙箱。

选项与路径在创建临时目录或 manager 之前完成校验。服务启动失败时，只关闭它自己创建的 manager，并删除其临时目录。`close()` 是幂等的。

## 客户端

```ts
import { Client } from '@modelcontextprotocol/client';
import {
  startBrowserMcpSocketServer,
  BrowserMcpSocketClientTransport,
} from 'nodriver-ts/mcp/socket';

const token = process.env.NODRIVER_MCP_TOKEN!;
const service = await startBrowserMcpSocketServer({ tokens: { [token]: 'local-operator' } });
const transport = new BrowserMcpSocketClientTransport({ path: service.path, token });
const client = new Client(
  { name: 'local-agent', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
try {
  await client.connect(transport);
  console.log((await client.listTools()).tools);
  const leaseId = transport.leaseId; // 保存后可显式重连，重连同样需要令牌
} finally {
  await client.close();
  await service.close();
}
```

完整示例见 `examples/mcp-socket.ts`。租约绑定预配令牌所映射的 principal；clientInfo 不受信任，一个 principal 无法使用另一个 principal 的租约。客户端关闭会取消该连接的在途请求，浏览器和引用保留到显式 `browser_close`、租约释放或闲置到期。重连时须重新认证并传入 `leaseId`；不会自动重连或重放动作。

可信宿主可以注入已有的 `BrowserSessionManager`，并调用 `manager.release(principal, leaseId)` 立即释放租约，这会关闭该租约的连接。关闭服务也会关闭注入的 manager，因此共享 manager 的宿主应统一安排停机。租约、浏览器池以及自有和外部浏览器的生命周期规则见 [HTTP 接入](mcp-http.md#浏览器分配)。

## 认证前导

连接的第一行是应用认证前导，不是 MCP 方法：

```json
{
  "type": "nodriver-auth",
  "token": "预配的随机秘密",
  "leaseId": "可选的租约 ID 或租约名称"
}
```

认证成功后，服务回复一行 `{"type":"nodriver-auth","leaseId":"..."}`，此后只交换标准 NDJSON JSON-RPC。省略 `leaseId` 时创建新租约；传入租约名称（1–64 个字母、数字、`.`、`_` 或 `-`）时使用该 principal 下同名的租约，首次使用时创建。首次 `browser_open` 之前不会启动 Chrome。认证失败（包括未知的租约 ID）会直接关闭连接，不回显凭证。前导可以被拆成多个数据包，也可以与第一条 MCP 消息一起到达。令牌以明文在本机 IPC 中传输，不要用于远程连接或不可信租户。

## 限制

| 默认值           | 范围                          |
| ---------------- | ----------------------------- |
| 32               | 连接数，含未认证连接          |
| 4 KiB / 5 秒     | 认证前导大小与期限            |
| 16 / 4           | 每连接未完成请求数 / 订阅数   |
| 256 KiB / 128 条 | 输入消息缓冲 / 待分派消息     |
| 8 MiB / 60 秒    | 输出缓冲 / 写入期限           |
| 8 MiB            | 客户端可接收的最大响应        |
| 30 秒 / 30 分钟  | 浏览器操作期限 / 租约闲置到期 |

重复的在途请求 ID、超出限额、不是 JSON-RPC 消息的 JSON 行以及过慢的写入都会关闭连接；不是合法 JSON 的行会被跳过。除协议通知外，不向流中写入 CDP 事件。

取消使用 `notifications/cancelled`，连接 EOF 会中止该连接的全部请求。已产生的副作用不能撤销，各连接仍共用租约与浏览器的写队列。资源更新由 SDK 的 `subscriptions/listen` 过滤，不支持旧的 `resources/subscribe`。一起到达的通知与响应按顺序分派，因此 SDK 的异步进度回调会在请求完成之前运行。
