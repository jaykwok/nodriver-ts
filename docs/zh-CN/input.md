# 输入策略、事件与取消

[English](../input.md)

默认 `instant` 策略执行快速、确定的动作。`tab.setInputPolicy({ mode: 'human', seed: 42 })` 启用带加减速的连续指针轨迹、停顿、按下/抬起间隔、分段滚动和逐字输入节奏。这是可配置的程序化行为模型，不等同于物理输入，也不承诺通过检测。

```ts
tab.setInputPolicy({
  mode: 'human',
  seed: 42,
  moveDuration: [90, 220],
  moveSteps: [8, 18],
  pause: [0, 15],
  pressDelay: [25, 70],
  keyDelay: [35, 110],
  scrollSteps: [3, 8],
  targetInset: 0.2,
  typing: 'auto', // auto | keys | insertText；auto 在 human 模式下使用按键事件
  scroll: 'auto', // auto | wheel | dom；auto 在 human 模式下先用滚轮把元素滚到视口附近
});
const input = await tab.waitForSelector('input');
await input.fill('replace all');
await input.type('中文👨‍👩‍👧‍👦é'); // 在当前光标/选区输入；不全选、不提交
await input.type(['明确提交片段', '😀']);
await tab.keyboard.press('Control+A'); // macOS 上全选为 Meta+A
await tab.mouse.wheel(0, 420);
console.log(tab.inputBehavior.lastReport);
```

## 参数

时间单位为毫秒，各 range 为最小/最大值：步数 1–120，时间 0–3000，`targetInset`（目标可见区域每条边排除的比例）0–0.45。省略的策略参数恢复默认值，seed 除外。未指定 seed 时，Tab 的输入行为创建时用 Node crypto 生成一个，之后的动作、模式切换和不带 seed 的 configure 都沿用它。显式传入 seed（即使与当前相同）会重启该行为实例的随机序列，不影响其他标签页。动作执行期间不能修改策略；策略也不会制造错字、额外提交或随机业务动作。

相同的 seed、起点、布局、配置和调用序列会复现相同的计划轨迹与延迟，但实际调度、帧率和事件时间戳仍可能有毫秒级差异。只凭 seed 复现某个动作，还需要它之前的全部随机采样；`randomState` 可在动作边界重启 PRNG。完整复现一个动作还需要相同的策略、布局、指针/键盘状态和参数。未显式指定 seed 时，每次运行使用不同的随机序列。

## 文本与按键

- **`fill()`**：整段替换，使用焦点、选区和一次 `Input.insertText`。
- **`type()`**：在当前选区按字素（Intl.Segmenter）逐个提交，也接受字符串片段数组；不会拆开 emoji 代理对、ZWJ 序列或组合字符。单次最多 100000 个 UTF-16 单元。
- **按键事件**：`typing: 'keys'`，或 human 模式下的默认 `auto`，会把可输入的 US 布局字符（字母、数字、常用符号、空格）逐个发送为 keyDown/keyUp，大写字母与上档符号自动按住 Shift；keyUp 与 keyDown 的 key 一致。用 `keyboard.down('Shift')` 按住 Shift 期间，不需要 Shift 的字符改用 `insertText` 输入，以免被按住的 Shift 变成上档字符。中日韩文字、emoji、换行和制表符使用 `insertText`；`typing: 'insertText'` 则全部使用 `insertText`。
- **`press()`**：支持命名键（Enter、Tab、Escape、方向键、Home/End、PageUp/PageDown、F1–F12、Space 等）、修饰键组合与 US 布局字符，例如 `Shift+Tab`、`Control++`；按住 Shift 时发送上档字符。`keyDefinition()` 与 `parseChord()` 已导出。
- **macOS 编辑快捷键**：浏览器运行在 macOS 上时，按键事件附带 AppKit 编辑命令（CDP `commands`），因此 `Meta+A` 全选、`Meta+Z` 撤销、`Alt+ArrowLeft` 按词移动、`Control+A` 移到段首等都与 Mac 键盘一致。启动的浏览器按宿主平台判断，`userAgent` 启动选项不影响结果；连接的浏览器按 `Browser.getVersion` 报告的 UA 判断。
- **`select()`**：通过 DOM 修改选项并派发合成的 input/change 事件，不改写 isTrusted；需要指针或按键交互时由调用者显式执行。

普通 `type()` 不产生 composition 生命周期；显式 CDP composition 由 `keyboard.compose()` 和 input scope 提供。两者都不模拟操作系统输入法候选窗或非 US 键盘布局。

## 指针与点击

点击先把元素滚动到视口内，检查其可见、启用且未被遮挡，并间隔 32 ms 两次取点，确认位置稳定。轨迹结束后会再次检查目标坐标和父 frame 的命中测试。位置改变或目标被遮挡时拒绝按下，绝不自动重新定位或重放点击。

鼠标按钮按下期间（包括按住按钮移动时），指针 pressure 为 0.5。human 模式下，首个指针位置在视口 15–85% 范围内随机。在 OOPIF 内 hover 时会确认事件确实已投递；只有指针已停在同一坐标时，才额外发送一次 0.25px 的探测移动，该探测本身也会产生可观察的事件。

## 串行与取消

Tab 输入、独立构造的 `new Mouse(session)` / `new Keyboard(session)` 和 raw input scope 共享每个 `Connection` 的同一个可重入队列，最多容纳 128 个等待或执行中的调用。不同连接不共享队列，直接调用 `Session.send()` / `sendWith()` 也不经过该队列。动作开始前，如果其他标签页可能位于前台，Tab 输入会调用 `Page.bringToFront`。独立的 `down()` 成功后保持按下，直到调用 `up()`；需要让多次调用作为整体保持所有权时使用 scope。scope 会按取得顺序的逆序自动释放持有的输入。

`InputOptions.timeout` 是输入阶段的总预算，默认 10000 ms，从调用动作时开始计算，包含排队和准备时间；元素的 `click`、`hover`、`fill`、`type` 也把前置准备计入其中。每条输入命令通过 `sendWith()` 接收剩余时间和合并后的取消信号。scope 内的子操作可以缩短预算、增加 signal 或 guard，但不能延长 scope 的 deadline，也不能替换原 guard。

取消和到期会立即以 `InputActionError` 拒绝，并保留 cause。`error.report` 记录动作停止时的状态；`error.cleanup` 在清理结束后解析为 `{ status, report }`，status 为 `completed`、`failed` 或 `disconnected`。报告包含 `phase`（`queued`、`running`、`cleaning`、`done`）、`cleanup`、已确认的事件数与片段数、seed、动作开始时的 `randomState`、最多 2000 项 trace 以及清理错误，不保存输入文本。调用方已停止等待的命令，仍可通过清理结果和连接生命周期观察到。

`cleanupTimeout` 默认 5000 ms，独立于输入 timeout 和已中止的 signal，限定释放资源和排空迟到响应的总时间。下一个托管输入会等到清理完成；清理失败后，后续托管输入会被拒绝，其 cause 为 `InputBlockedError`。输入动作保留原命令结果，从不重发命令。清理只等待该动作自己的迟到响应：它的输入命令、元素准备命令和回调中在任意连接上发出的 raw 命令（包括调用方已停止等待的命令），以及该动作的 attach 迟到返回时库为其发送的 detach。其他待响应命令（例如另一个标签页的求值）既不会延迟清理，也不会使其失败。

动作用到的页面上打开了 JavaScript 对话框时，清理预算暂停计时，因为在对话框关闭前，Chrome 会扣住该页面正在处理的输入的响应。对话框关闭后预算重新计时，trace 记录 `dialogWait`。页面关闭时，其输入状态随之结束：该页面不再回复的请求、因其 session 结束而失败的步骤都不算清理失败，trace 记录 `pageClosed`。已关闭页面上的其他失败仍会报告，但不封锁任何输入。

如果只有 composition 取消未得到确认，其余清理和待响应命令都已完成，并且整条连接上没有仍被按住的托管按键或鼠标按钮，封锁范围仅限该 composition 所属的顶层页面 target，即该页面的所有 attachment 和跨域子 frame。其他已知页面可以继续使用同一连接和输入队列。通过所属页面的任一 attachment 完成托管释放，或该页面已关闭，按住的按键或按钮即视为已释放。关闭页面后，收到 `Target.targetDestroyed` 时清除该页面的封锁；分离或重新附加 session、导航、渲染进程崩溃、销毁子 frame 都不会清除。原动作仍报告清理失败；缩小封锁范围既不代表 composition 已结束，也不会撤销 Chrome 在失焦时可能已提交的文字。

如果无法根据 target 元数据和 attachment 层级确定页面归属，composition 清理失败仍会封锁整条连接。存在页面封锁时，归属不明的 session 上的托管输入也会被拒绝，以免通过新的 raw frame attachment 绕过封锁。按键或按钮未释放、其他释放失败、排空超时和断连同样封锁整条连接：请恢复目标状态并建立新连接后再继续。直接发送的 raw CDP 输入既不经过托管按住状态的跟踪，也不受这些封锁限制。

如需在不关闭 target 的情况下解除页面级 composition 封锁，先等待失败动作的 `error.cleanup`，检查并恢复页面（包括其子 frame），再调用 `await browser.inputScope(session).recoverComposition()` 或 `createInputScope(session).recoverComposition()`。这一调用表示你确认页面已就绪：它不发送 CDP 命令，不取消 composition，也不验证 DOM。如果可能还有残留的 composition，请先用 raw CDP 取消并验证最终文档。只在焦点编辑器的选区为折叠状态（只有光标）时发送空的 `Input.imeSetComposition`，因为没有 composition 时，Chrome 会改为删除选中的文字。恢复使用同一输入队列，清除该页面所有 attachment/frame 上的封锁时返回 `true`，没有封锁时返回 `false`；其他页面的封锁和原动作的失败报告保持不变。归属不明或已关闭的 session、连接级封锁、该页面上仍按住的托管按键/按钮，以及比调用时已有的失败更新的失败，都会使恢复被拒绝；其他页面上的按住状态和待响应命令不影响恢复。在清理结束前发起的调用，无法确认清理随后才记录的失败。

```ts
import { InputActionError } from 'nodriver-ts';

try {
  await tab.keyboard.type('中文', { timeout: 1500, signal, cleanupTimeout: 5000 });
} catch (error) {
  if (!(error instanceof InputActionError)) throw error;
  console.log(error.cause, error.report); // 输入已停止，清理可能仍在进行
  const cleanup = await error.cleanup;
  console.log(cleanup.status, cleanup.report); // 最终快照
}
```

清理结果描述托管释放和协议响应。文档的最终状态由应用负责，已送达的输入无法撤回。用户回调应响应传入的取消信号。scope 结束后，仍被保留的控制器会拒绝继续输入。

## 显式 composition

先让编辑器获得焦点，再调用 `keyboard.compose()`。回调会收到一个 composition 控制器：`update(text, selection?, options?)` 开始或更新 composition，`commit(text?, options?)` 尝试提交一次，`cancel(options?)` 取消。选区偏移按更新文本中的 UTF-16 单元计算，默认位于文本末尾。文本长度须为 1–100000 个 UTF-16 单元；要清空 composition 请使用 `cancel()`。

```ts
await input.focus();
await tab.keyboard.compose(
  async (composition) => {
    await composition.update('中文');
    await composition.update('中文😀', { selectionStart: 2, selectionEnd: 4 });
    await composition.commit(); // 提交最后一次更新的文本，最多尝试一次
  },
  { timeout: 2000, signal, cleanupTimeout: 5000 },
);
```

更新使用 `Input.imeSetComposition`，提交使用 `Input.insertText`。回调返回时如果尚未提交或取消，清理阶段会取消该 composition。重复调用 `cancel()` 没有副作用；第二次提交会被拒绝，即使第一次提交的结果不确定。

每次更新和提交前，控制器都会穿过开放和 closed shadow root 以及可访问的 iframe 祖先，确认最初的元素仍有焦点，并在文档改变时停止。默认情况下，取消也要求原编辑器仍保有焦点。如果 composition 进行中焦点离开编辑器或文档改变，清理不发送取消，报告 `failed`，并按上文所述封锁后续托管输入，范围是该 composition 所属的顶层页面或整条连接。Chrome 可能在失焦时把文本提交到原编辑器；如果焦点在 `compositionstart` 期间移动，也可能把进行中的 composition 转到新编辑器。composition 还可能在编辑器保有或重新获得焦点时自行结束，例如焦点离开后又回来；控制器在其探针世界中用监听器观察这种情况，跨域 frame 中的焦点除外。没有 composition 时，空更新会删除选中的文字，因此这时只在选区为折叠状态时发送取消；选区为范围时不发送取消，清理报告 `failed`。

向 `keyboard.compose()` 或 scope 的 `run()` 传入 `{ forceCancel: true }` 后，显式 `cancel()` 和自动清理会向该 session 的当前焦点发送空的 `Input.imeSetComposition`，即使焦点或文档已经改变。这样可以取消跟随焦点转到另一个编辑器的 composition，也可能取消该编辑器自身的 composition。焦点离开原编辑器后，只有当前焦点是探针能检查的编辑器且选区为折叠状态时才发送取消：没有 composition 时，Chrome 收到空更新会删除选中的文字；而被后续焦点移动打断的 composition，已经在原编辑器中结束。其他情况不发送取消，清理与不设 `forceCancel` 时一样失败，包括最后一次 `update()` 设置了范围选区，以及焦点位于跨域 frame 中。更新和提交仍要求原焦点和文档有效；提交失败的动作即使强制清理成功，也仍是中断的动作。取消得到确认且其余清理成功时，页面可以继续使用；取消失败或未得到确认时仍会封锁输入，且不会重试。如果第一次更新在发送前的焦点检查中就已失败，则不发送取消。

焦点检查和 CDP 输入是两个独立操作，因此调用方应验证最终文档。库不启用 Runtime，也不修改浏览器方法。焦点探针运行在库通过 `Page.createIsolatedWorld` 创建的隔离世界中，并在文档存续期间复用，页面脚本无法观察到。向 `compose()` 或 `run()` 传入 `executionContextId` 可改用你自己的上下文，请传入当前文档的 ID。控制器在第一次更新前解析一次该上下文的全局对象，之后都通过这个句柄探测，因此复用同一数字 ID 的新文档不会被探测。始终不启用 DOM 域：closed shadow root 通过 `DOM.describeNode` 和 `DOM.resolveNode` 检查，这两个命令不会启用该域。

第一次 `update()` 会先确认焦点能接收文本，否则在发送任何 composition 命令前失败。能接收文本的焦点包括：既非只读也未禁用（包括被所在 fieldset 禁用）的文本类 `input`（`text`、`search`、`url`、`tel`、`email`、`password` 或 `number`）或 `textarea`，以及 contenteditable 内容（包括 `designMode` 文档）。失败时抛出 `InputActionError`，其 `cause` 为 `ActionabilityError`。控制器会沿焦点进入开放和 closed shadow root 以及同源 frame，并按编辑宿主检查 contenteditable 内容，因为 composition 开始时，Chrome 会把焦点从可聚焦的后代元素移到编辑宿主。跨域 frame 内的焦点无法从父 session 检查：其可编辑性未知，composition 照常进行，报告的 trace 记录 `compositionFocusUnknown`，且检测不到该 frame 内的焦点变化。如需完整检查，请通过该 frame 自己的 target session 执行 composition。超时、断连和文档变化仍会中止动作。

## Raw input scope

`browser.inputScope(session)` 或导出的 `createInputScope(session, { policy?, mac?, pageEvents? })` 为 target session 创建可复用的 scope 工厂。每次 `run()` 提供新的鼠标、键盘和 composition 控制器，共用一个 deadline、原 guard 和一份最终报告。同级控制器的调用串行执行；按住的按键、按钮和 composition 会按逆序清理，之后连接队列才交给下一个所有者。显式调用 `up()` 或 `cancel()` 可提前释放。已有按钮被按住时，click 或 drag 不能替换它。

```ts
const session = await browser.attachSession(tab.id);
const scope = browser.inputScope(session);
await scope.run(
  async (input) => {
    await input.keyboard.down('Shift');
    await input.mouse.move(100, 100);
    await input.mouse.down();
    await input.mouse.move(220, 100);
    await input.wait(20);
    // 自动先释放鼠标按钮，再释放 Shift
  },
  { timeout: 1000, signal, cleanupTimeout: 5000 },
);
```

Raw scope 和 `keyboard.compose()` 默认发送 `Page.enable`，使导航能够中断输入；它们从不改变 target 焦点。托管输入是库唯一会在 raw session 上启用域的地方。run 结束后，该域在调用方的 session 上保持启用，scope 自有的监听器则会移除。设置 `pageEvents: false`（`inputScope()`、`createInputScope()` 和 `compose()` 的选项）后不发送任何 `*.enable` 命令。此时只有该 session 已通过其他途径启用 Page 域，导航才会中断 run；否则 run 在到期、你的 `signal` 中止或 session 结束时停止，composition 仍会在每一步前检查焦点和文档。对话框事件同样只经由启用了 Page 域的 session 送达；没有这样的 session 时，清理无法等待对话框关闭。`browser.inputScope()` 与 Tab 输入用相同方式选择 macOS 编辑命令；`createInputScope()` 的 `mac` 默认为 false。在 scope 内请使用 `input.composition`，不要嵌套 `keyboard.compose()`。

外层 `run()` 负责 `cleanupTimeout`，子操作沿用该预算。子操作失败会结束本次 run，即使回调捕获了它的异常。scope 内的鼠标事件携带该 scope 键盘当前按住的修饰键。

## MCP

`browser_input_policy` 设置标签页的策略，`browser_click`、`browser_fill`、`browser_type`、`browser_press_key`、`browser_scroll` 等动作使用同一输入层。只有调用方显式启用 human 模式，轨迹与节奏才会改变。`browser_handoff` 用于请人接管并确认，与输入策略无关。
