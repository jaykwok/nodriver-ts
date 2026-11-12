# 原始 target session

[English](../raw-sessions.md)

如果由应用自己负责页面初始化、target 追踪和 CDP 命令，可在 `Browser.launch()` 或 `Browser.connect()` 上使用 `attach: 'none'`。

```ts
import { Browser } from 'nodriver-ts';

const browser = await Browser.launch({ attach: 'none', headless: true, detached: true });
try {
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
  const session = await browser.attachSession(targetId, { timeout: 5000 });
  const result = await session.send('Runtime.evaluate', { expression: '6 * 7' });
  console.log(result.result.value);
  await session.detach();
  const endpoint = await browser.release();
  // 保存 endpoint，之后用 Browser.connect({ endpoint, attach: 'none' }) 重连。
} finally {
  await browser.close(); // release 之后只断开连接。
}
```

## 策略与就绪

| 附加策略      | 自动接管页面                 | 显式 `newTab` / `attachTarget` |
| ------------- | ---------------------------- | ------------------------------ |
| `all`（默认） | 现有页面、后续页面及弹出页   | 允许                           |
| `created`     | 本客户端创建的页面及其弹出页 | 允许                           |
| `none`        | 不接管；`tabs` 始终为空      | 发送 CDP 前拒绝                |

任何策略下都能调用 `attachSession()`，每次都新建一个独立的附加实例，不按 target 去重。`none` 下，任何页面、弹出页或 `Target.attachedToTarget` 事件都不会创建 Tab 或 Frame。

`none` 下，连接建立且 `Browser.getVersion`、`Target.getBrowserContexts`、`Target.setDiscoverTargets({ discover: true })` 和 `Target.getTargets` 完成后，launch/connect 即告就绪。它不等待启动页，返回时可能没有任何页面 target。请用 `pageTargets` 和根 session 的 `Target.*` 事件追踪页面，而不是 `tabs`。

`none` 会跳过可选的 headless UA 伪装探测与覆盖，显式传入 `maskHeadless: true` 会被拒绝；Chrome 启动参数照常生效。每次原始附加只发送 `Target.attachToTarget({ targetId, flatten: true })`，不发送 `Page.enable`、`Page.setLifecycleEventsEnabled`、`Target.setAutoAttach` 或任何 `Runtime.*` 命令。域初始化、录屏帧 ACK 和收尾都由你负责。唯一的例外是托管输入：`inputScope()` 的 run 和 `keyboard.compose()` 默认发送 `Page.enable`，以便导航能中断输入；传入 `pageEvents: false` 则不发送任何 `*.enable` 命令。

launch/connect 在端点发现、版本、上下文、target 发现与列举以及自动附加各阶段共用一个总初始化期限（默认 30 秒）和同一个取消信号。launch 失败会关闭连接并清理自有进程；connect 失败只断开连接。进程清理有独立且有界的终止等待，可能超出该期限；宿主硬崩溃时仍无法执行清理。

## 托管原始输入

`browser.inputScope(session)` 和 `createInputScope(session)` 与 Tab 输入及独立的鼠标/键盘对象共用连接的输入队列。每次 `run()` 在同一个期限、取消信号和 `guard` 下管理按住的按键、按钮和显式 composition，按逆序清理，并返回 `InputReport`。作用域从不激活 target。直接调用 `session.sendWith()` 不经过该队列。接口与中断约定见[输入作用域、composition 与清理](input.md)。

## 有界后台呈现租约

`browser.presentationLease(session, options)` 通过 `Page.startScreencast` 和 `Page.stopScreencast`，在一段有界的短时间内保持原始 target 可观察。租约与 target 焦点、Runtime、输入重试以及连接上的其他工作互不影响。

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
  // 在这里执行后台 target 上的工作。
} finally {
  const report = await lease.close();
  console.log(report.state, report.frames, report.acknowledgedFrames);
}
```

默认值：总时长 5 秒、最多送出 16 帧待 ACK、4 MiB 解码后帧字节、4 个并发 ACK、启动期限 2 秒、每个 ACK 期限 1 秒，以及 2 秒的停止与 ACK 清理预算。达到时长、帧数、字节或 ACK 上限，或某个 ACK 超时，都会停止租约并记录原因。`close()` 幂等，会等待停止命令和该租约自己的 ACK 工作；连接上的其他命令按各自的生命周期运行。session 断开时，报告为 `disconnected`，清理随连接一起结束。

`screencast` 会把 `format`、`quality`、`maxWidth`、`maxHeight` 和 `everyNthFrame` 传给 `Page.startScreencast`，未指定的字段使用 Chrome 默认值。时长和超时最大为 2147483647 毫秒，即 Node.js 定时器的上限。在已结束的 session 上启动租约会以 `DisconnectedError` 拒绝，其 `cause` 为该 session 的 `closeReason`。

一个 session 同一时间最多只有一个活动的呈现租约；仍处于 idle 的租约可以在当前租约关闭后启动。租约处于 `starting` 时收到的帧，与 `active` 阶段一样计入帧数、字节和 ACK 上限。租约活动期间，不要在同一个 session 上直接调用 `Page.startScreencast` 或 `Page.stopScreencast`。

报告把租约结果（`state`）与清理状态（`cleanup`）分开。`state` 为 `active`、`stopped`、`timed-out`（因某项上限或 ACK 超时而结束）、`failed` 或 `disconnected`。`cleanup` 为 `pending`、`completed`、`timed-out`（清理预算耗尽时仍有 ACK 未完成）、`failed` 或 `disconnected`。`reason` 记录租约结束的原因；`Page.stopScreencast` 失败时 `reason` 保持不变，`state` 变为 `failed`，错误记入 `cleanupErrors`。报告还统计送出、已确认和丢弃的帧数、编码字节、ACK 错误和清理错误，`inFlightAcks` 为关闭时仍未完成的 ACK 数。`close()` 返回后，报告是稳定的快照。screencast ACK 与输入动作分开统计。后台节流仍取决于 Chrome 和操作系统。

## 生命周期

`TargetSession` 继承 `Session`，新增 `targetId`、`endReason`、`ended: Promise<EndReason>` 和 `detach({ signal?, timeout? })`，并沿用有类型的 `send`、`sendWith`、`on`、`onAny`、`waitFor`、`id`、`closed` 和 `closeReason`。

最先到达的终止事件生效，`ended` 只 resolve 一次，原因为以下之一：

| 原因               | 触发条件                                                        |
| ------------------ | --------------------------------------------------------------- |
| `detach-requested` | 调用了本 session 的 `detach()`                                  |
| `detached`         | Chrome 发出 `Target.detachedFromTarget`                         |
| `target-destroyed` | Chrome 先发出 `Target.targetDestroyed`                          |
| `target-crashed`   | Chrome 发出 `Inspector.targetCrashed` 或 `Target.targetCrashed` |
| `disconnected`     | CDP 连接结束，包括 release/disconnect                           |

session 结束时，其待响应请求和 `waitFor` 立即以 `SessionEndedError` 拒绝；该错误是 `DisconnectedError` 的子类，带有 `reason` 和 `targetId`。事件订阅随之移除，之后的发送和等待会被拒绝，新订阅会抛错。其他附加实例仍可使用，除非它们属于同一个已销毁/崩溃的 target，或整个连接已结束。关闭 target 时，Chrome 可能先发出 `detached` 再发出 `target-destroyed`，取决于事件顺序。

崩溃会结束**库**层面的生命周期，尽管 Chrome 允许原 CDP 附加实例在渲染进程崩溃后继续 reload 和 evaluate：原始 session 会被关闭，其附加实例也会被清理。要恢复，先等待根 session 的 `Target.targetCrashed` 通知（session 级的崩溃通知可能更早到达），再重新附加并发送 `Page.reload`。如果 target 再次崩溃，在收到下一次根 session 崩溃通知后重新执行恢复。高层 Tab 的 崩溃/reload 行为与此无关。

`detach()` 同步结束本地生命周期，再等待 `Target.detachFromTarget`；重复调用共用同一个 Promise。调用前取消信号已中止时 session 保持打开；发送后再中止不会重新打开 session，而是启动独立清理。如果 session 已经结束，或 Chrome 已不再持有该附加实例，`detach()` 直接成功，不再发送命令。

如果根级 `Target.attachedToTarget` 监听器为 `attachSession()` 正在创建的附加实例调用 `connection.session(id)`，得到的是普通 `Session`。附加完成后，事件改发给返回的 `TargetSession`，普通 `Session` 随之结束：`closed` 为 true，`closeReason` 说明原因，其命令会被拒绝。

## 取消与迟到响应

附加中止或超时会立即拒绝，不影响其他附加实例。如果之后仍收到成功响应，连接会以独立的 5 秒期限为该 session ID 发送 `Target.detachFromTarget`。

如果取消后 5 秒内没有收到附加响应，或者清理用的分离命令（包括 `detach()` 失败后的那次）在其独立的 5 秒内无法确认，库会断开 CDP 连接。协议响应表明 session 已不存在时视为成功。这种异常关闭会结束该连接上的**所有** session，确保没有无法追踪的附加实例残留，并通过 `onError` 报告清理失败。请按 `connection_lost` 处理；普通取消只影响被取消的调用方。断开连接不会终止 WebSocket 浏览器；Pipe Chrome 会在传输关闭时退出。

## 发送、调用结算与响应观察（不记录载荷）

```ts
const browser = await Browser.connect({
  endpoint,
  attach: 'none',
  observe: {
    onSend({ seq, method, sessionId, at }) {
      // 在这里把应用当前的阶段与该命令关联。
    },
    onSettle({ seq, durationMs, error }) {
      // 调用方已完成或失败；已取消的命令可能仍在 Chrome 中执行。
    },
    onResponse({ seq, method, sessionId, at, durationMs, late, error }) {
      // 收到匹配的响应，可能发生在取消、超时或 session 结束之后。
    },
  },
});
```

`onSend` 在调用传输层的发送方法之前同步执行。`seq` 是连接内单调递增的 CDP 请求 ID（允许有空隙），三个回调使用同一个值。`at` 是 `performance.now()` 的毫秒值。它记录发送尝试；Chrome 的回复通过 `onResponse` 观察。观察回调中发起的发送会排队，以保持传输层的调用顺序。观察回调的异常会被隔离。回调应保持简短；在回调中中止也无法撤回已观察到的发送尝试。

`onSettle` 在调用方的 Promise 结算时对每个已发送的请求执行一次，按完成顺序触发，提供从发送尝试起算的耗时，失败时提供协议错误码或错误名。迟到的响应不会让调用方再次结算。

`onResponse` 在处理匹配的响应时同步执行。`sessionId` 是请求的 session ID，浏览器级返回的、关于已分离 session 的错误也是如此。`at` 是收到响应时的 `performance.now()`，`durationMs` 是从发送到响应的耗时。`late` 表示响应到达前，请求已因取消、超时、session 结束或发送失败而退出等待，与 `onSettle` 微任务是否已运行无关。`error` 存在时是字符串形式的 CDP 错误码。重复或未知的响应会被忽略；session 不匹配时会断开连接，而不是确认该命令。所有观察回调都拿不到参数、结果或协议错误文本。

对于普通响应，`onResponse` 先于异步的 `onSettle` 执行。内部响应处理以及取消附加的清理调度都在 `onResponse` 之前完成。如果传输层在发送期间同步返回响应，该清理发送可能仍在排队：此时 `pendingCount` 已包含它，`unansweredCount` 尚未包含。`trace` 回调在命令完成时运行，其格式和 stderr 输出与观察回调无关。

### 未响应计数与有期限的等待

`connection.pendingCount` 统计尚未结算的调用方请求，包括排队中的发送。`connection.unansweredCount` 统计已尝试发送、尚未收到匹配响应的请求。例如已发送的命令超时后，两者可以分别为 `0` 和 `1`；迟到的响应使 `unansweredCount` 归零，但不会让调用方再次结算。取消附加的迟到回复所触发的清理分离命令也会计入。

取消、超时和 session 结束**不会**移除未响应的命令。发送报错同样保留计数，因为任意传输层都可能在部分发送后才报错。预先中止的请求、序列化失败的请求，以及在发送尝试前就从队列中取消的请求不计入。每条记录只保存 ID、方法、session 和时间戳元数据，直到收到响应或连接关闭，与应用淘汰了多少历史记录无关。对端一直不回复时，这些元数据会持续增长；应停止发起新工作，设置自己的清理期限，无法确认响应时断开连接。

连接关闭会清空计数，但不会合成响应，因此务必检查 `closed` 或断开事件：断开后的零来自本地记录清空。连接开放时，新命令会继续改变计数；浏览器侧的工作也可能在 CDP 回复后继续运行。应用应先串行管理操作与清理的归属，再交出这份归属。

### 原生 drain

`await browser.drain({ timeout: 11000, signal })` 委托给 `connection.drain()`。它不轮询，等待待响应和排队中的请求、未响应的发送尝试、被放弃的附加操作，以及库的附加实例清理（包括重试失败分离命令的后续步骤）。同步观察回调及其排队的发送在空闲检查之前运行。

| 结果                         | 行为                                                  |
| ---------------------------- | ----------------------------------------------------- |
| 连接仍开放，所有跟踪工作排空 | resolve 为 `void`                                     |
| 调用前已断开或等待期间断开   | 以 `DisconnectedError` 拒绝，`cause` 为连接的失败原因 |
| 超过期限                     | 以 `TimeoutError` 拒绝                                |
| 取消信号中止                 | 以取消信号的中止原因拒绝                              |

默认期限为连接的超时时间。每个等待者有自己的期限和取消信号；等待者超时或取消不会取消命令、重发输入或断开连接，而库的附加实例清理保留其独立期限，失败时仍可能断开连接。先停止命令的生产者：drain 不是阻止后续发送的锁，也不等待应用的 Promise、事件等待或浏览器侧的所有副作用。协议错误响应同样会偿还未响应计数，但不会把命令的失败变成成功。崩溃的 target 可能留下永远得不到回复的命令，因此 drain 仍须设置期限。

```ts
// 先停止或取消操作，等待其线上回复，再 detach 该 session。
await browser.drain({ timeout: 11000 });
await session.detach({ timeout: 5000 });
await browser.drain({ timeout: 11000 });
```

### 可选分阶段性能观察

设置 `observe.onPerformance(entry)` 可收到不含载荷的测量值。启用后不会额外解析 JSON，也不保存消息正文。`bytes` 是 JSON 消息的 UTF-8 字节数，不含 WebSocket 帧头或 pipe 分隔符。所有时间戳均基于 `performance.now()`。

| direction | 字段与测量范围                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `send`    | `seq`、`method`、`sessionId`、`at`、`bytes`；`queueMs` 为请求进入队列到开始序列化；`serializationMs` 为 JSON 序列化耗时                                                  |
| `receive` | `kind`（`response`、`event`、`invalid`）、`at`、`bytes`、`parseMs`、`dispatchMs`；匹配的响应还含 `seq`、`method`、`sessionId`，若发送时已开启测量，还含 `responseWaitMs` |

`responseWaitMs` 从传输层调用（`onSend` 之后）到进入接收回调为止，包含传输、网络和 Chrome 的时间，无法单独分离出 Chrome 的执行时间。`dispatchMs` 覆盖同步协议处理和事件/响应回调，不含性能回调本身、`onSettle` 等 Promise 后续步骤以及异步监听器的工作。`queueMs` 中的队列是连接的可重入发送队列，不是应用或输入队列。测量和观察回调本身有开销；这些阶段不能当作端到端输入延迟的分解。

迟到的响应保留原来的 `seq`；未知和重复的响应没有关联字段。回调异常会被隔离。同步传输层可能先发出 receive 指标再发出 send 指标，因此应按 `seq` 关联，而不是按回调顺序。序列化前就被拒绝的发送不产生指标。任何条目都不包含载荷或协议错误文本。

## 测试

`nodriver-ts/testing` 中的 `ScriptedChrome` 驱动同样的真实对象：`(await ScriptedChrome.start()).connect({ attach: 'none' })`。它模拟独立的附加实例，以及 `detachSession(id)`、`crashTarget(id)` 和 `destroyTarget(id)`。`attachReplyDelayMs` 在附加实例及其事件已存在之后再延迟附加回复，用于测试取消后的迟到回复。包括分离在内的每条命令都记录在 `commands` 中。
