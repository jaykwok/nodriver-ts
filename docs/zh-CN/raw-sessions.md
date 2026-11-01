# Raw target session

[English](../raw-sessions.md)

`Browser.launch()` 和 `Browser.connect()` 都支持 `attach: 'none'`，供应用自行管理页面初始化、target 和 CDP 命令。

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
域初始化、录屏帧 ack 和停止录屏由调用方负责。托管输入是唯一的例外：`inputScope()` 的 run
和 `keyboard.compose()` 默认发送 `Page.enable`，让导航能够中断输入；传入 `pageEvents: false`
即可让所有域初始化完全由你掌握。

launch/connect 使用一个总初始化 deadline（默认 30 秒），覆盖端点发现、版本、contexts、
target discovery/listing 及自动 attach。signal 贯穿上述阶段。
launch 失败会断开连接并清理自有进程，connect 失败只断开连接。
进程清理使用独立且有界的终止等待，可能超过初始化 deadline；宿主硬崩溃仍无法执行清理。

## 托管 raw 输入

`browser.inputScope(session)` 和 `createInputScope(session)` 与 Tab 输入及独立 mouse/keyboard 对象共享连接队列。每次 `run()` 管理持有的按键、按钮和显式 composition，共用一次 deadline/signal/guard，逆序清理并返回 `InputReport`。Raw scope 为跟踪导航启用 Page 事件，但不激活 target；`pageEvents: false` 时不发送任何 `*.enable` 命令。直接调用 `session.sendWith()` 仍独立于该队列。接口及中断约定见[输入 scope、composition 与清理](input.md)。

## 有界后台呈现租约

`browser.presentationLease(session, options)` 通过 `Page.startScreencast` 和
`Page.stopScreencast` 在限定时间内保持 raw target 可观察。租约与 target 焦点、Runtime、
输入重发和连接上的其他工作相互独立。

```ts
const lease = browser.presentationLease(session, {
  screencast: { format: 'jpeg', quality: 30, maxWidth: 320, maxHeight: 240 },
  maxDuration: 3000,
  maxFrames: 8,
  maxBytes: 2_000_000,
  maxInFlightAcks: 4,
});
try {
  await lease.start();
  // 在后台 target 上执行操作。
} finally {
  const report = await lease.close();
  console.log(report.state, report.frames, report.acknowledgedFrames);
}
```

默认值均有界：总时长 5 秒、最多送出 16 帧 ACK、4 MiB 解码后帧字节、最多 4 个并发 ACK、
启动期限 2 秒、每个 ACK 期限 1 秒，以及 2 秒的停止和 ACK 清理预算。达到总时长、帧数、
字节数或 ACK 并发上限时会停止租约并记录原因。`close()` 幂等，会等待停止命令和该租约
自己的 ACK 工作；连接上的其他命令继续按各自生命周期运行。session 断开后，最终报告为
`disconnected`，清理随连接生命周期结束。

`screencast` 会把 `format`、`quality`、`maxWidth`、`maxHeight` 和 `everyNthFrame` 传给
`Page.startScreencast`，未指定的字段使用 Chrome 默认值。时长和超时最大为 2147483647 毫秒，
即 Node.js 定时器的上限。在已结束的 session 上启动租约会以 `DisconnectedError` 拒绝，
其 `cause` 为该 session 的 `closeReason`。

同一个 session 同时只能有一个活动中的呈现租约。仍处于 `idle` 的租约会在当前租约关闭后
重新启动。租约处于 `starting` 时收到的帧，也会按与 `active` 阶段相同的帧数、字节数和
ACK 限制处理。这个协调只覆盖托管呈现租约；租约活动期间不要在同一个 session 上直接调用
`Page.startScreencast` 或 `Page.stopScreencast`。

报告将租约生命周期（`state`）与清理状态（`cleanup`）分开。`state` 表示租约正在活动、
已停止、已超时、失败或已断开；`cleanup` 为 `pending`、`completed`、`timed-out`、`failed`
或 `disconnected`。`timed-out` 表示租约已经结束，但仍有 ACK 工作未完成。`inFlightAcks` 是
报告关闭时仍在途的 ACK 数量；`close()` 返回后报告保持稳定。报告还记录送出 ACK 的帧、
已确认帧、丢弃帧、编码字节、ACK 错误和清理错误。screencast ACK 与输入动作分别统计。
后台节流行为取决于 Chrome 和操作系统。

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
应用应串行管理操作与清理，再移交操作权。

### 原生 drain

`await browser.drain({ timeout: 11000, signal })` 委托给 `connection.drain()`，通过状态变化通知等待，
不进行轮询。覆盖待发送/待结算请求、未响应发送、取消 attach 的晚回复与独立清理，
以及失败 detach 的异步重试衔接。同步观察回调及其排队发送先于空闲检查。

| 结果                         | 行为                                         |
| ---------------------------- | -------------------------------------------- |
| 连接仍开放，所有跟踪工作排空 | 正常返回 `void`                              |
| 调用前或等待期间断连         | 抛 `DisconnectedError`，`cause` 为原断连原因 |
| 超过期限                     | 抛 `TimeoutError`                            |
| signal 取消                  | 抛 signal 的错误 reason                      |

默认期限使用 connection 的 timeout；每个等待者的期限和 signal 独立。
drain 超时或取消不取消命令、不重发输入、不自动断连；attachment 清理失败可能按其独立期限断连。
先停止命令生产者：drain 不阻止未来发送，不等待任意应用 Promise、事件等待器或所有浏览器副作用。
协议错误响应也会偿还未响应计数，但不会把原命令的失败变成成功。
target 崩溃可能留下永不回复的命令，仍须设置期限。

```ts
await browser.drain({ timeout: 11000 });
await session.detach({ timeout: 5000 });
await browser.drain({ timeout: 11000 });
```

### 可选分阶段性能观察

配置 `observe.onPerformance(entry)`，收到不含载荷的指标；复用现有 JSON 解析，不保存消息正文。
`bytes` 是 JSON 的 UTF-8 字节数，不含 WebSocket 帧或 pipe 分隔符；时间基于 `performance.now()`。

| direction | 指标                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`    | `seq`、`method`、`sessionId`、`at`、`bytes`；`queueMs` 为请求进入连接队列到序列化开始；`serializationMs` 为 JSON 序列化耗时                                          |
| `receive` | `kind`（`response` / `event` / `invalid`）、`at`、`bytes`、`parseMs`、`dispatchMs`；匹配响应还含 `seq`、`method`、`sessionId`，发送时已开启指标则含 `responseWaitMs` |

`responseWaitMs` 从 transport 调用前（onSend 后）到接收回调入口，包含传输、网络和 Chrome 等待，
不能单独解释为 Chrome 执行时间。`dispatchMs` 覆盖同步协议处理、事件和 onResponse 回调，
不含性能观察回调自身、onSettle 等 Promise 微任务或异步监听器后续工作。
queueMs 只反映连接的重入发送队列，不含应用或输入队列。指标和回调本身有开销，不能将这些数值直接等同于端到端输入耗时。

晚回复保留原 seq；重复/未知响应没有关联字段。观察回调异常被隔离。
同步 transport 可能先发 receive 指标，再发 send 指标，应按 seq 关联。
序列化前拒绝的发送没有消息指标；指标不包含载荷或协议错误文本。

## 测试

`ScriptedChrome.connect({ attach: 'none' })` 构造真实 Browser/TargetSession。
fixture 支持独立 attachment、`detachSession(id)`、`crashTarget(id)`、`destroyTarget(id)`；
`attachReplyDelayMs` 在 attachment 已建立并发出事件后延迟响应，用于取消后迟到响应测试。
`commands` 记录 detachFromTarget 等命令及参数。
