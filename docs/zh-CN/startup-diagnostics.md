# 启动失败诊断

[English](../startup-diagnostics.md)

通过 `getStartupDiagnostics(error)` 读取 launch/connect 失败的结构化诊断。
保留原有错误类型，包括 `TimeoutError`、`ProfileInUseError`。
调用方的取消 reason 保持原对象和消息，冻结的 Error 也可查询诊断；其他错误消息附加阶段、耗时和可用的进程信息。

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

快照包含 `stage`、`elapsedMs`、`stageElapsedMs` 和可选的 `process`。
使用单调时钟，在失败清理前采样，不包含进程终止等待。
未创建子进程时、以及 `Browser.connect()` 失败时，没有 process 字段。
process 包含 `pid`、`exited`、`exitCode`、`signal`、`stderr`、`stderrStatus`。
exitCode/signal 为 null 表示未观测到对应退出信息，不能解释为成功。
快照被冻结，不会因随后终止 Chrome 而改变。

| 阶段                        | 工作                                             |
| --------------------------- | ------------------------------------------------ |
| `process-launch`            | 查找可执行文件与 OS 进程启动                     |
| `profile-preparation`       | profile 创建、锁与启动配置                       |
| `port-file`                 | 等待有效 DevToolsActivePort，仅 WebSocket launch |
| `endpoint-discovery`        | HTTP `/json/version` 发现，仅 connect            |
| `websocket-connect`         | WebSocket 连接                                   |
| `protocol-handshake`        | Browser.getVersion                               |
| `target-initialization`     | context/target 发现、自动 attach、启动 Tab 就绪  |
| `environment-configuration` | 可选的 headless UA 配置                          |

所有阶段共用一个总初始化期限；失败清理使用独立的终止期限。非法 timeout 在初始化前拒绝。
阶段字段标识失败或超时所在的启动操作。

普通启动最多保留 stderr 的末尾 16,384 个字符；浏览器日志可能含 URL 或其他敏感文本，调用方选择记录位置。
普通 detached 启动返回 `stderrStatus: 'discarded'`。
启用 `detached: true, supervised: true` 后，独立 helper 保留末尾 16,384 字节并返回 `captured`，
覆盖协议/target 初始化失败。release 时 helper 转为独立排走并丢弃日志，不留下增长的日志文件或原宿主管道。

平台边界与 helper 生命周期见[监管所有权](lifecycle-ownership-design.md)。
