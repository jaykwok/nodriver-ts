# 启动失败诊断

[English](../startup-diagnostics.md)

launch 和 connect 失败时会附带一份快照，可通过 `getStartupDiagnostics(error)` 读取，冻结的错误对象也不例外。原有的错误类型保持不变，包括 `TimeoutError` 和 `ProfileInUseError`。来自调用方 signal 的 abort reason 保持原对象和原消息；其他错误的消息会附加阶段、耗时、可用的进程信息以及保留的 stderr。

```ts
import { Browser, getStartupDiagnostics } from 'nodriver-ts';

try {
  await Browser.launch({ headless: true, timeout: 30000 });
} catch (error) {
  const startup = getStartupDiagnostics(error);
  console.error(startup?.stage, startup?.elapsedMs, startup?.process);
  throw error;
}
```

快照包含 `stage`、`elapsedMs`、`stageElapsedMs` 和可选的 `process`。时间使用单调时钟，在清理失败的自有进程之前采样，因此不含进程终止的等待。子进程尚未创建时以及 `Browser.connect()` 失败时没有 `process`；否则它包含 `pid`、`exited`、`exitCode`、`signal`、`stderr` 和 `stderrStatus`。退出码或信号为 null 表示没有观测到相应的退出状态，并不代表执行成功。快照是冻结的，之后清理终止 Chrome 时也不会改变。

| 阶段                        | 工作                                                   |
| --------------------------- | ------------------------------------------------------ |
| `process-launch`            | 查找可执行文件并启动 OS 进程，包括监管 helper          |
| `profile-preparation`       | 创建 profile、加锁和生成启动配置                       |
| `port-file`                 | 等待有效的 `DevToolsActivePort`（仅 WebSocket launch） |
| `endpoint-discovery`        | 通过 HTTP `/json/version` 发现端点（仅 connect）       |
| `websocket-connect`         | 建立 WebSocket 传输                                    |
| `protocol-handshake`        | `Browser.getVersion`                                   |
| `target-initialization`     | context/target 发现、自动 attach 和启动 Tab 就绪       |
| `environment-configuration` | 可选的 headless UA 配置                                |

所有阶段共用一个总初始化期限，`stage` 指出失败或超时的那一步操作。失败清理有独立的终止期限。非法的 timeout 参数会在初始化之前被拒绝。

普通启动时，`stderr` 最多保留末尾 16,384 个字符。其中可能含有浏览器生成的 URL 或其他敏感文本，请自行决定记录位置。普通 detached 启动返回 `stderrStatus: 'discarded'`。启用 `detached: true, supervised: true` 后，独立 helper 保留末尾 16,384 字节并返回 `captured`，协议/target 初始化失败时也是如此；release 之后它会丢弃 stderr。平台边界与 helper 生命周期见[监管所有权](lifecycle-ownership-design.md)。
