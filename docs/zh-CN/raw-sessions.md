# Raw target session

[English](../raw-sessions.md)

0.3.0 起，`Browser.launch()` 和 `Browser.connect()` 支持 `attach: 'none'`，供应用自行管理页面初始化、target 和 CDP 命令。

```ts
import { Browser } from 'nodriver-ts';

const browser = await Browser.launch({ attach: 'none', headless: true, detached: true });
try {
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
  const session = await browser.attachSession(targetId, { timeout: 5000 });
  console.log((await session.send('Runtime.evaluate', { expression: '6 * 7' })).result.value);
  await session.detach();
  const endpoint = await browser.release();
  // 保存 endpoint，之后 Browser.connect({ endpoint, attach: 'none' })。
} finally {
  await browser.close(); // release 后只断开连接。
}
```

## 策略与就绪

| attach 策略   | 自动接管页面                 | 显式 newTab / attachTarget |
| ------------- | ---------------------------- | -------------------------- |
| `all`（默认） | 现有页面、后续页面及 popup   | 允许                       |
| `created`     | 本客户端创建的页面及其 popup | 允许                       |
| `none`        | 不接管；`tabs` 始终为空      | 发送 CDP 前拒绝            |

所有策略下都可调用 `attachSession()`，每次获得独立 attachment，不按 target 去重。
none 下初始页面、后续页面、popup 和 `Target.attachedToTarget` 都不创建 Tab/Frame。

none 的 ready 条件是连接建立及 `Browser.getVersion`、`Target.getBrowserContexts`、
`Target.setDiscoverTargets({ discover: true })`、`Target.getTargets` 完成，不等待启动页；
可以在零页面时就绪。用 `pageTargets` 和根 session 的 `Target.*` 事件追踪页面。

none 跳过可选 headless UA 探针和覆盖；显式 `maskHeadless: true` 会报错。Chrome 启动参数仍然生效。
每次 raw attach 只发送 `Target.attachToTarget({ targetId, flatten: true })`，
不发送 `Page.enable`、`Page.setLifecycleEventsEnabled`、`Target.setAutoAttach` 或任何 `Runtime.*`。
域初始化、录屏帧 ack 和停止录屏由调用方负责。

launch/connect 使用一个总初始化 deadline（默认 30 秒），覆盖端点发现、版本、contexts、
target discovery/listing 及自动 attach。signal 贯穿上述阶段。
launch 失败会断开连接并清理自有进程，connect 失败只断开连接。
进程清理使用独立且有界的终止等待，可能超过初始化 deadline；宿主硬崩溃仍无法执行清理。

## 生命周期

`TargetSession extends Session`，新增 `targetId`、`endReason`、`ended: Promise<EndReason>` 和
`detach({ signal?, timeout? })`；继承 `send`、`sendWith`、`on`、`onAny`、`waitFor`、`id`、`closed`。

首个终止原因生效，`ended` 只 resolve 一次：

| 原因               | 触发条件                                             |
| ------------------ | ---------------------------------------------------- |
| `detach-requested` | 本地调用 detach                                      |
| `detached`         | 收到 Target.detachedFromTarget                       |
| `target-destroyed` | 先收到 Target.targetDestroyed                        |
| `target-crashed`   | 收到 Inspector.targetCrashed 或 Target.targetCrashed |
| `disconnected`     | 连接断开，包括 release/disconnect                    |

结束时 pending 请求和 waitFor 立即以 `SessionEndedError` 拒绝，监听器被清理。
该错误继承 `DisconnectedError`，携带 `reason` 和 `targetId`。之后的 send/waitFor 拒绝，
新增事件订阅抛错。其他 attachment 保持可用，除非共享已崩溃/销毁的 target 或整个连接结束。
关闭 target 时 Chrome 可能先发 detached，所以最终原因取决于事件顺序。

crash 是库的逻辑生命周期终点。虽然 Chrome 允许原 CDP attachment 在 crash 后继续
reload/evaluate，但 raw API 会关闭旧 session 并清理 attachment，恢复必须重新 attach。
先观察根 `Target.targetCrashed`，再重新 attach 和发送 `Page.reload`：
session 级 crash 通知可能更早到达。高层 Tab 的 crash/reload 行为不变。
新 attachment 也可能遇到再次 crash，重新 attach 不保证恢复成功。

`detach()` 同步结束本地生命周期，再等待 `Target.detachFromTarget` 回应，重复调用共享同一个 Promise。
调用前 signal 已中止则 session 保持打开；发送后取消不会重新打开 session，并会启动独立清理。

## 取消与迟到响应

attach 超时或 signal 中止立即 reject，普通取消不影响其他 attachment。
迟到的成功响应到达后，用独立的 5 秒 deadline 发送 `Target.detachFromTarget`。

如果取消后 5 秒内没有 attach 响应，或者 detach 清理在其独立的 5 秒内仍无法确认成功，
库会断开整个 CDP 连接；显式 detach 失败后的清理也适用。协议确认 session 已不存在视为清理成功。
这项异常兜底会结束该连接的所有 session，通过 `onError` 报告清理失败，并避免 attachment
在不可追踪的连接上残留。应用应按 `connection_lost` 处理，不能把它视为普通取消。
断开 WebSocket 不终止外部 Chrome；Pipe Chrome 会随管道关闭退出。

## 发送、调用结算与响应观察

launch/connect 都接受 `observe: { onSend, onSettle, onResponse }`，回调均可选。

- `onSend({ seq, method, sessionId?, at })` 在调用 transport.send 前同步执行。
  seq 是连接内单调递增的请求 ID，允许空隙；at 是 `performance.now()` 的毫秒值。
  记录的是发送尝试，不代表 Chrome 已收到或执行。回调重入的发送排队以保持顺序。
  回调异常被隔离，应保持简短；回调中取消不能撤回已观察的发送尝试。
- `onSettle({ seq, durationMs, error? })` 按完成顺序触发，以 seq 关联发送；
  durationMs 从发送尝试开始计算，error 为协议错误码或错误名。
  语义保持不变：调用方 Promise 成功或失败时通知一次；取消、超时不代表 Chrome 已响应，晚响应不会再次触发结算。
- `onResponse({ seq, method, sessionId?, at, durationMs, late, error? })` 在处理匹配响应时同步触发。
  seq 与 onSend/onSettle 相同，是当前连接的 CDP 请求 ID；sessionId 取自请求，包括在浏览器级返回的 session 已分离错误。
  at 是收到响应时的 `performance.now()`，durationMs 是从发送到响应的耗时。
  late 表示收到响应前请求已因取消、超时、session 结束或发送失败退出等待；不取决于 onSettle 微任务是否已运行。
  error 只包含字符串形式的 CDP 错误码。重复或未知 ID 不触发回调，session 不匹配则断开连接，不作为成功匹配的响应。
- 普通响应的 onResponse 在异步 onSettle 通知之前执行。内部响应处理以及取消 attach 的独立 detach 清理调度先于 onResponse。
  如果 transport 在发送期间同步返回响应，清理发送可能仍在队列中，此时 pendingCount 已包含它，unansweredCount 尚未包含。
  所有观察回调均不接收参数、结果或协议错误文本，回调异常被隔离。生产 trace 的回调形状和 stderr 行为保持不变。

### 未响应计数与有期限的等待

`connection.pendingCount` 统计调用方尚未结算的请求（包含待发送队列）。
`connection.unansweredCount` 统计已尝试发送、尚未收到匹配响应的请求。
例如已发送的命令超时后，两者分别可以为 `0` 和 `1`；晚响应到达后，后者归零，不会再次结算原调用。
取消 attach 的晚响应可能触发独立 detach，该清理命令也计入未响应数量。

取消、超时和 session 结束均不清除未响应计数；发送报错也保留，因为任意 transport 可能在部分发送后报错。
预先取消、序列化失败或发送前已从队列取消的请求不产生计数。内部只保留 ID、方法、session 和时间元数据，
直到响应到达或连接关闭，与应用的历史记录淘汰无关。持续发送而对端一直不响应会积累元数据，
调用方应停止新工作并设置清理期限，无法确认响应时按自己的策略断开连接。

连接关闭会清空计数，但不会合成 onResponse。必须同时检查 closed 或断开事件；断开后的零不代表响应全部收到。
连接开放时的零也只是瞬时状态，不能阻止并发发送；CDP 响应不保证所有浏览器侧副作用均已完成。
应用应串行管理操作与清理，在自身预算内等待两个计数均归零后再移交操作权。
本次提供计数，不新增 drain 方法，也不改变取消行为。

## 测试

`ScriptedChrome.connect({ attach: 'none' })` 构造真实 Browser/TargetSession。
fixture 支持独立 attachment、`detachSession(id)`、`crashTarget(id)`、`destroyTarget(id)`；
`attachReplyDelayMs` 在 attachment 已建立并发出事件后延迟响应，用于取消后迟到响应测试。
`commands` 记录 detachFromTarget 等命令及参数。

单元测试覆盖生命周期、取消、清理失败、总 deadline 和发送顺序。
真实 Chrome 覆盖 raw evaluate、crash/recovery、关闭 target、release/reconnect 和后台进程最后窗口关闭。
最后一项用 `--no-startup-window --keep-alive-for-test` 控制后台存活，Windows 使用真实窗口，
无显示环境的 Linux 使用 headless；它不验证特定扩展的后台策略。
Node.js 24 跑源码与构建产物验收，CI 另检查最低支持版本 Node.js 24.22.0。
