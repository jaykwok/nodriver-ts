# 输入策略、事件与取消

[English](../input.md)

默认 `instant` 策略执行快速、确定的动作。`tab.setInputPolicy({ mode: 'human', seed: 42 })` 启用带加减速的连续指针轨迹、停顿、按下/抬起间隔、分段滚动和逐字输入节奏。这是可配置的程序化行为模型，不等同于物理输入，也不承诺通过检测。

```ts
tab.setInputPolicy({
  mode: 'human',
  seed: 42,
  pause: [0, 15],
  pressDelay: [25, 70],
  keyDelay: [35, 110],
  wheelProfile: 'trackpad', // trackpad | wheel
  targetInset: 0.2,
  typing: 'auto', // auto | keys | insertText；auto 在 human 模式下使用按键事件
  scroll: 'auto', // auto | wheel | dom；auto 在 human 模式下先用滚轮把元素滚到视口附近
  presentationRecovery: 250, // 输入命令停滞多少毫秒后请求绘制一帧；false 表示关闭
  lateMoves: 'send', // send | skip；skip 丢弃已过时的指针采样点
});
const input = await tab.waitForSelector('input');
await input.fill('replace all');
await input.type('中文👨‍👩‍👧‍👦é'); // 在当前光标/选区输入；不全选、不提交
await input.type(['明确提交片段', '😀']);
await tab.keyboard.press('Control+A'); // macOS 上全选为 Meta+A
await tab.mouse.wheel(0, 420);
console.log(tab.inputBehavior.lastReport);
```

## 新标签页的默认策略

`Browser.launch()` / `Browser.connect()` 选项中的 `inputPolicy` 作用于浏览器的所有标签页，包括启动时的标签页和连接时附加的标签页。`browser.setDefaultInputPolicy(policy)` 为之后打开的标签页设置默认策略；`newContext({ inputPolicy })` 或 `context.setDefaultInputPolicy(policy)` 为单个上下文覆盖它。弹出页在打开者所在的上下文中打开，因此使用该上下文的默认策略，而不是打开者标签页自己的策略。已打开的标签页保持原策略，`tab.setInputPolicy()` 为单个标签页覆盖默认值。传入 `undefined` 取消默认值。默认策略不含种子时，每个标签页各有独立的随机序列；含种子时，每个新标签页都从同一个序列开始。

```ts
await using browser = await Browser.launch({ inputPolicy: { mode: 'human' } });
const page = await browser.newTab(); // human
const popup = await page.waitForPopup(); // human
```

## 参数

时间单位为毫秒，各 range 为最小/最大值：步数 1–120，时间 0–3000，`targetInset`（目标可见区域每条边排除的比例）0–0.45。`presentationRecovery` 为 10–60000 ms 或 `false`，见[不绘制帧的页面](#不绘制帧的页面)。`wheelNotch`（1–1000 px）和 `pointerGrid` 没有默认值，说明见[下文](#human-动作规划)：`wheelNotch` 要求 `wheelProfile: 'wheel'`，且不能与 `scrollSteps` 同时使用；`pointerGrid.scale` 为 0.25–20。省略的策略参数以及设为 `undefined` 的参数恢复默认值，种子除外。未指定种子时，Tab 的输入行为创建时用 Node crypto 生成一个，之后的动作、模式切换和不带种子的 configure 都沿用它。显式传入种子（即使与当前相同）会重启该行为实例的随机序列，不影响其他标签页。动作执行期间不能修改策略；策略也不会制造错字、额外提交或随机业务动作。

省略 `moveDuration`、`moveSteps` 或 `scrollSteps` 表示自动规划，见[下文](#human-动作规划)；显式配置的范围会取代它。MCP 工具 `browser_input_policy` 接受相同的字段。

相同的种子、起点、布局、配置和调用序列会复现相同的计划轨迹与延迟，但实际调度、帧率和事件时间戳仍可能有毫秒级差异。只凭种子复现某个动作，还需要它之前的全部随机采样；`randomState` 可在动作边界重启 PRNG。完整复现一个动作还需要相同的策略、布局、指针/键盘状态和参数。未显式指定种子时，每次运行使用不同的随机序列。

## human 动作规划

human 输入在 Node 侧规划，页面中不运行任何代码来产生它。

- **路径**：三次贝塞尔曲线，采用最小加加速度（minimum-jerk）进度，叠加首尾渐弱的 8–12 Hz 微颤。起点和终点都在视口内的路径不会越过视口的上边缘和左边缘。
- **耗时**：`70 + 90 * log2(1 + 距离 / targetWidth)` 毫秒，上限 1800 ms，按每秒约 120 个点规划。`click()` 以元素盒较短的一边作为 `targetWidth`；`hover()`、`mouse.move()` 以及 `drag()` 移向起点的过程使用 24 px。显式的 `moveDuration` 或 `moveSteps` 会取代规划的耗时或点数。按住按键后，`drag()` 按其 `steps` 等分直线移动，每步之后等待 `pause` 加 10 ms。
- **过冲**：超过 350 px 的移动有四分之一的概率过冲 4–12 px，并追加 3–5 个修正点，因此可能超过 1800 ms。按住鼠标按键时，或显式设置了 `moveDuration` 或 `moveSteps` 时，不会过冲。
- **计时**：每个点在上一个点发出后（第一个点自路径开始起）经过其规划的延迟时到期，等待 Chrome 回复所花的时间计入该延迟。停顿、按住时长、按键间隔和滚轮事件间隔也同样计算，因此只有回复慢于延迟时才会增加耗时。宿主的计时器精度可能拉长较短的等待；Windows 上常为约 16 ms，实际采样率会因此降低。
- **过时采样点**：回复慢于采样间隔时（例如在后台窗口中），路径默认仍发送每个采样点，耗时超过规划。设置 `lateMoves: 'skip'` 后，下一个采样点也已到期时，当前采样点会被丢弃，指针因此保持在规划的时间线上。路径的最后一个点总会发送；按住按钮时的移动（例如 `drag()` 的移动）、按下、按键和滚轮事件也总会发送。`report.skippedMoves` 统计被丢弃的采样点。
- **指针网格**：实体鼠标以整设备像素报告位置。`pointerGrid: { scale, phase }` 把每个指针坐标放到该网格上：取 `1 / scale` CSS 像素的整数倍，再偏移 `phase`（`{ x, y }`，单位为 CSS 像素，默认 0）。`scale` 是每 CSS 像素对应的设备像素数，即包含页面缩放的 `devicePixelRatio`；相位取决于视口在屏幕上的位置。两者都随机器和窗口而定，因此没有默认值。移动、按下、释放和滚轮事件都使用对齐后的位置，`guard` 收到的也是该位置；不会移动指针的规划采样点不发送。
- **落点**：在元素位于视口内的部分中，于 `targetInset` 范围内按截断高斯分布采样，横向居中、纵向略偏上。
- **按压**：部分按压在 `pressDelay` 过半时产生 1 px 的按住移动。元素点击会先对该位置做命中检查，检查不通过则跳过；跨进程 frame 内从不发生。释放使用最终位置。
- **滚动**：`wheelProfile: 'trackpad'`（默认）发送先加速再衰减的滚轮事件，每 18 px 距离一个，间隔约 8 ms；`'wheel'` 发送等量的滚轮事件，每 100 px 一个，间隔 45 ms。两者都发送 1–120 个事件，每个间隔再加上 `pause`，并保持有符号、含小数的滚动总量。显式的 `scrollSteps` 指定事件数。设置 `wheelNotch`（目标平台滚轮一档的像素数）后，`'wheel'` 改为每档发送一个事件，每个事件只沿一个轴滚动，间隔 45 ms，滚动距离取整为整档：一档 100 px 时，`wheel(0, 250)` 滚动三档。instant 模式发送一个携带精确距离的事件。human 模式下把元素滚入视口时，最多用滚轮滚动 3 秒，其余由 Chrome 完成。
- **打字**：间隔服从对数正态分布，限制在 `keyDelay` 范围内，并按 QWERTY 键距和双手交替加权。小写 `th`、`he`、`in`、`er` 可能重叠按住，规划时长 5–12 ms；修饰键、重复键和非 ASCII 片段不重叠。取消时两个键都会释放。

## 文本与按键

- **`fill()`**：整段替换，使用焦点、选区和一次 `Input.insertText`。
- **`type()`**：在当前选区按字素（Intl.Segmenter）逐个提交，也接受字符串片段数组；不会拆开 emoji 代理对、ZWJ 序列或组合字符。`type(text, { replace: true })` 先像 `fill()` 一样选中全部内容，再逐字输入覆盖它；文本为空时用 Backspace 删除原内容。单次最多 100000 个 UTF-16 单元。
- **按键事件**：`typing: 'keys'`，或 human 模式下的默认 `auto`，会把可输入的 US 布局字符（字母、数字、常用符号、空格）逐个作为按键发送，大写字母与上档符号自动按住 Shift。产生字符的按键先发送 `rawKeyDown`，再发送 `char`，因此与物理按键一样，keydown 处理函数阻止默认行为时不会输入该字符；按住 Control、Alt 或 Meta 时只发送 `rawKeyDown`。keyUp 与 keydown 的 `key`、`code`、键码和位置一致。用 `keyboard.down('Shift')` 按住 Shift 期间，不需要 Shift 的字符改用 `insertText` 输入，以免被按住的 Shift 变成上档字符。中日韩文字、emoji、换行和制表符使用 `insertText`；`typing: 'insertText'` 则全部使用 `insertText`。
- **`press()`**：支持命名键（Enter、Tab、Escape、方向键、Home/End、PageUp/PageDown、F1–F12、Space 等）、修饰键组合与 US 布局字符，例如 `Shift+Tab`、`Control++`；按住 Shift 时发送上档字符。`keyDefinition()` 与 `parseChord()` 已导出。
- **左右键与数字键盘**：`Shift`、`Control`、`Alt`、`Meta` 指左侧按键；`ShiftLeft`、`ShiftRight`、`ControlLeft`、`ControlRight`、`AltLeft`、`AltRight`、`MetaLeft`、`MetaRight` 指定左右。`Numpad0`–`Numpad9`、`NumpadAdd`、`NumpadSubtract`、`NumpadMultiply`、`NumpadDivide`、`NumpadDecimal` 和 `NumpadEnter` 按 Num Lock 开启时的方式输入。这些按键的 keydown、keypress 和 keyup 事件都把 `KeyboardEvent.location` 设为 1（左）、2（右）或 3（数字键盘），`keyDefinition()` 返回相同的 `location`。按键按物理键记录按住状态：`up('ControlLeft')` 会释放用 `down('Control')` 按下的键，`pressedKeys` 按按下时使用的名称列出按键。
- **macOS 编辑快捷键**：浏览器运行在 macOS 上时，按键事件附带 AppKit 编辑命令（CDP `commands`），因此 `Meta+A` 全选、`Meta+Z` 撤销、`Alt+ArrowLeft` 按词移动、`Control+A` 移到段首等都与 Mac 键盘一致。启动的浏览器按宿主平台判断，`userAgent` 启动选项不影响结果；连接的浏览器按 `Browser.getVersion` 报告的 UA 判断。
- **`select()`**：通过 DOM 修改选项并派发合成的 input/change 事件，不改写 isTrusted；需要指针或按键交互时由调用者显式执行。

普通 `type()` 不产生 composition 生命周期；显式 CDP composition 由 `keyboard.compose()` 和输入作用域提供。两者都不模拟操作系统输入法候选窗或非 US 键盘布局。

## 指针与点击

点击先把元素滚动到视口内，检查其可见、启用且未被遮挡，并间隔 32 ms 两次取点，确认位置稳定。轨迹结束后会再次检查目标坐标和父 frame 的命中测试。位置改变或目标被遮挡时拒绝按下，绝不自动重新定位或重放点击。

`setChecked(checked)` 是一个完整的输入动作：超时、取消信号和 `guard` 覆盖读取状态、点击，以及最多 1 s 的等待目标状态。它点击 checkbox 或 radio 本身；当点击控件中心无法命中控件时（例如原生控件隐藏在带样式的 label 之后），改为点击控件的第一个已渲染的 `<label>`。返回 `{ changed, clicked }`，其中 `clicked` 为 `'control'` 或 `'label'`。radio 无法通过点击取消选中，因此对已选中的 radio 调用 `setChecked(false)` 会在发出任何输入前被拒绝；`setChecked(true)` 可以选中未选中的 radio。被禁用的控件（包括位于被禁用的 `<fieldset>` 内的控件）会在同一期限内等待其变为可用；控件被禁用期间，既不点击控件本身，也不点击它的 label。点击后未达到目标状态时报告错误，不会重复点击。普通 `click()` 不会改为点击其他元素。

鼠标按钮按下期间（包括按住按钮移动时），指针压力为 0.5。human 模式下，首个指针位置在视口 15–85% 范围内随机。在 OOPIF 内悬停时会确认事件确实已投递；只有指针已停在同一坐标时，才额外发送一次探测移动，偏移 0.25 px 或指针网格的一格，该探测本身也会产生可观察的事件。

## 守卫函数

动作在每个检查点用一个 `InputCheckpoint` 调用 `InputOptions.guard`。它抛出异常或返回被拒绝的 Promise 时，动作以 `InputActionError` 停止，`cause` 为该错误，动作按住的按键和按钮仍会释放。`checkpoint.type` 取值如下：

- `step`：每个步骤的开始和结束，以及停顿前后。
- `move` 和 `wheel`，带 `x`、`y`：每次指针移动或滚轮事件之前。
- `mouseDown`，带 `button`、`x`、`y`：按下按钮之前。`mousePressed`，字段相同：Chrome 确认按下之后、按住期间发出任何其他输入之前。即使守卫函数抛出异常也会释放按钮，因此目标仍在指针下方时，点击会完成。
- `keyDown`，带 `key`（按下时使用的名称）和 `code`：按键按下之前。`char`，字段相同：按键已按下，接下来是它的字符、keypress 和文本输入。守卫函数在 `char` 抛出异常时不会发送字符，按键仍会释放。不产生字符的按键，以及在按住 Control、Alt 或 Meta 时按下的按键，没有 `char` 检查点。
- `text`：`Input.insertText` 之前。`composition`：composition 更新或提交之前。

守卫函数的耗时计入动作的期限，并随动作的取消信号停止。元素动作还有自己的检查：`type()` 在 `keyDown`、`char` 和 `text` 检查元素是否有焦点，`click()` 在 `mouseDown` 对目标做命中测试。

```ts
const field = await tab.waitForSelector('#code');
await field.focus();
await tab.keyboard.type('1234', {
  // 只在输入框有焦点时输入每个字符。
  guard: async (checkpoint) => {
    if (checkpoint.type !== 'char' && checkpoint.type !== 'text') return;
    if (!(await field.evaluate((el) => el === document.activeElement)))
      throw new Error('Focus moved');
  },
});
```

## 串行与取消

Tab 输入、独立构造的 `new Mouse(session)` / `new Keyboard(session)` 和原始输入作用域共享每个 `Connection` 的同一个可重入队列，最多容纳 128 个等待或执行中的调用。不同连接不共享队列，直接调用 `Session.send()` / `sendWith()` 也不经过该队列。动作开始前，如果其他标签页可能位于前台，Tab 输入会调用 `Page.bringToFront`。独立的 `down()` 成功后保持按下，直到调用 `up()`；需要让多次调用作为整体保持所有权时使用作用域。作用域会按取得顺序的逆序自动释放持有的输入。

`InputOptions.timeout` 是输入阶段的总预算，默认 10000 ms，从调用动作时开始计算，包含排队和准备时间；元素的 `click`、`hover`、`fill`、`type`、`setChecked` 也把前置准备计入其中。每条输入命令通过 `sendWith()` 接收剩余时间和合并后的取消信号。作用域内的子操作可以缩短预算、增加取消信号或 `guard`，但不能延长作用域的期限，也不能替换原 `guard`。

取消和到期会立即以 `InputActionError` 拒绝，并保留 cause。`error.report` 记录动作停止时的状态；`error.cleanup` 在清理结束后解析为 `{ status, report }`，status 为 `completed`、`failed` 或 `disconnected`。报告包含：

- `phase`（`queued`、`running`、`cleaning`、`done`）、`cleanup` 和清理错误。
- `events` 和 `completedSegments`：已确认的事件数与文本片段数。
- `sent`：动作发出的输入命令，按类别统计，发出时即计数而非得到回复时：`moves`、`wheels`、`presses`、`keys`（按键按下）、`characters`（按键按下后的 `char`）、`releases`（按钮和按键释放，包括清理时发出的释放）、`text`（`Input.insertText`，包括 composition 提交）和 `composition`（更新和取消）。`dispatched` 是可能改变页面的各类之和，即除移动和滚轮事件外的所有类别；悬停仍可能改变页面，因此只有 `sent` 能说明完全没有发出输入。作用域回调在运行期间自己发出的原始输入命令也计入。
- `skippedMoves`：`lateMoves: 'skip'` 丢弃的指针采样点数。
- `lateReplies`：调用方已停止等待后才到达的、动作自身请求的回复数，例如动作超时时仍在途、随后由清理等待的命令。
- `presentationRecoveries`：见[不绘制帧的页面](#不绘制帧的页面)。
- `plannedMs` 和 `actualMs`：规划延迟的毫秒数（指针运动、停顿、按压与按键间隔，以及作用域的 `wait()` 调用），以及从取得输入到输入结束、清理开始前的耗时。instant 模式下只有作用域的等待计入规划。
- 种子、动作开始时的 `randomState` 和最多 2000 项 `trace`。不保存输入文本。

调用方已停止等待的命令，仍可通过清理结果和连接生命周期观察到。

`cleanupTimeout` 默认 5000 ms，独立于输入超时时间和已中止的取消信号，限定释放资源和排空迟到响应的总时间。下一个托管输入会等到清理完成；清理失败后，后续托管输入会被拒绝，其 cause 为 `InputBlockedError`。输入动作保留原命令结果，从不重发命令。清理只等待该动作自己的迟到响应：它的输入命令、元素准备命令和回调中在任意连接上发出的原始命令（包括调用方已停止等待的命令），以及该动作的附加操作迟到返回时库为其发送的分离命令。其他待响应命令（例如另一个标签页的求值）既不会延迟清理，也不会使其失败。

动作用到的页面上打开了 JavaScript 对话框时，清理预算暂停计时，因为在对话框关闭前，Chrome 会扣住该页面正在处理的输入的响应。对话框关闭后预算重新计时，`trace` 记录 `dialogWait`。页面关闭时，其输入状态随之结束：该页面不再回复的请求、因其 session 结束而失败的步骤都不算清理失败，`trace` 记录 `pageClosed`。已关闭页面上的其他失败仍会报告，但不封锁任何输入。

如果只有 composition 取消未得到确认，其余清理和待响应命令都已完成，并且整条连接上没有仍被按住的托管按键或鼠标按钮，封锁范围仅限该 composition 所属的顶层页面 target，即该页面的所有附加实例和跨域子 frame。其他已知页面可以继续使用同一连接和输入队列。通过所属页面的任一附加实例完成托管释放，或该页面已关闭，按住的按键或按钮即视为已释放。关闭页面后，收到 `Target.targetDestroyed` 时清除该页面的封锁；分离或重新附加 session、导航、渲染进程崩溃、销毁子 frame 都不会清除。原动作仍报告清理失败；缩小封锁范围既不代表 composition 已结束，也不会撤销 Chrome 在失焦时可能已提交的文字。

如果无法根据 target 元数据和附加实例层级确定页面归属，composition 清理失败仍会封锁整条连接。存在页面封锁时，归属不明的 session 上的托管输入也会被拒绝，以免通过新的原始 frame 附加实例绕过封锁。按键或按钮未释放、其他释放失败、排空超时和断连同样封锁整条连接：请恢复目标状态并建立新连接后再继续。直接发送的原始 CDP 输入既不经过托管按住状态的跟踪，也不受这些封锁限制。

如需在不关闭 target 的情况下解除页面级 composition 封锁，先等待失败动作的 `error.cleanup`，检查并恢复页面（包括其子 frame），再调用 `await browser.inputScope(session).recoverComposition()` 或 `createInputScope(session).recoverComposition()`。这一调用表示你确认页面已就绪：它不发送 CDP 命令，不取消 composition，也不验证 DOM。如果可能还有残留的 composition，请先用原始 CDP 取消并验证最终文档。只在焦点编辑器的选区为折叠状态（只有光标）时发送空的 `Input.imeSetComposition`，因为没有 composition 时，Chrome 会改为删除选中的文字。恢复使用同一输入队列，清除该页面所有 附加实例/frame 上的封锁时返回 `true`，没有封锁时返回 `false`；其他页面的封锁和原动作的失败报告保持不变。归属不明或已关闭的 session、连接级封锁、该页面上仍按住的托管按键/按钮，以及比调用时已有的失败更新的失败，都会使恢复被拒绝；其他页面上的按住状态和待响应命令不影响恢复。在清理结束前发起的调用，无法确认清理随后才记录的失败。

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

清理结果描述托管释放和协议响应。文档的最终状态由应用负责，已送达的输入无法撤回。用户回调应响应传入的取消信号。作用域结束后，仍被保留的控制器会拒绝继续输入。

## 不绘制帧的页面

Chrome 随页面绘制帧向页面投递指针和按键输入，并在页面处理完输入后才回复输入命令。不绘制帧的页面（例如位于最小化窗口中的页面）会扣住输入，命令因此停滞。动作的某条输入命令超过 `presentationRecovery` 毫秒（默认 250）仍未得到回复时，动作发送一次 `Page.captureScreenshot`，让 Chrome 绘制一帧。Chrome 只能截取顶层 target，因此该请求经由附加到命令所属顶层页面的 session 发出：发往跨进程 frame 的输入通过其所属页面恢复。作用域回调在另一条连接上发出的原始命令，依据该连接上已知的页面恢复并等待对话框。每条命令最多触发一次这样的请求，输入也绝不会重发。因动作超时或被取消而调用方已停止等待的命令，也以同样方式恢复，使清理能够排空它们；清理同样等待该截图的回复。页面上打开着 JavaScript 对话框时不会发出请求。`report.presentationRecoveries` 统计请求次数，`trace` 为每次请求记录 `presentationRecovery`。`presentationRecovery: false` 关闭此功能。

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

向 `keyboard.compose()` 或作用域的 `run()` 传入 `{ forceCancel: true }` 后，显式 `cancel()` 和自动清理会向该 session 的当前焦点发送空的 `Input.imeSetComposition`，即使焦点或文档已经改变。这样可以取消跟随焦点转到另一个编辑器的 composition，也可能取消该编辑器自身的 composition。焦点离开原编辑器后，只有当前焦点是探针能检查的编辑器且选区为折叠状态时才发送取消：没有 composition 时，Chrome 收到空更新会删除选中的文字；而被后续焦点移动打断的 composition，已经在原编辑器中结束。其他情况不发送取消，清理与不设 `forceCancel` 时一样失败，包括最后一次 `update()` 设置了范围选区，以及焦点位于跨域 frame 中。更新和提交仍要求原焦点和文档有效；提交失败的动作即使强制清理成功，也仍是中断的动作。取消得到确认且其余清理成功时，页面可以继续使用；取消失败或未得到确认时仍会封锁输入，且不会重试。如果第一次更新在发送前的焦点检查中就已失败，则不发送取消。

焦点检查和 CDP 输入是两个独立操作，因此调用方应验证最终文档。库不启用 Runtime，也不修改浏览器方法。焦点探针运行在库通过 `Page.createIsolatedWorld` 创建的隔离世界中，并在文档存续期间复用，页面脚本不能替换其使用的 JavaScript 原语；焦点和 DOM 效果仍可观察。向 `compose()` 或 `run()` 传入 `executionContextId` 可改用你自己的上下文，请传入当前文档的 ID。控制器在第一次更新前解析一次该上下文的全局对象，之后都通过这个句柄探测，因此复用同一数字 ID 的新文档不会被探测。始终不启用 DOM 域：closed shadow root 通过 `DOM.describeNode` 和 `DOM.resolveNode` 检查，这两个命令不会启用该域。

第一次 `update()` 会先确认焦点能接收文本，否则在发送任何 composition 命令前失败。能接收文本的焦点包括：既非只读也未禁用（包括被所在 fieldset 禁用）的文本类 `input`（`text`、`search`、`url`、`tel`、`email`、`password` 或 `number`）或 `textarea`，以及 contenteditable 内容（包括 `designMode` 文档）。失败时抛出 `InputActionError`，其 `cause` 为 `ActionabilityError`。控制器会沿焦点进入开放和 closed shadow root 以及同源 frame，并按编辑宿主检查 contenteditable 内容，因为 composition 开始时，Chrome 会把焦点从可聚焦的后代元素移到编辑宿主。跨域 frame 内的焦点无法从父 session 检查：其可编辑性未知，composition 照常进行，报告的 `trace` 记录 `compositionFocusUnknown`，且检测不到该 frame 内的焦点变化。如需完整检查，请通过该 frame 自己的 target session 执行 composition。超时、断连和文档变化仍会中止动作。

## 原始输入作用域

在取消清理期间才收到成功回包的指针移动，也会更新作用域下一次运行的起点；失败或未确认的移动不会更新。`sent` 也统计作用域回调发出的原始输入命令，包括发往其他连接的命令；计数发生在传输派发时，而非调用刚进入队列时。

`browser.inputScope(session)` 或导出的 `createInputScope(session, { policy?, mac?, pageEvents?, pointer? })` 为 target session 创建可复用的作用域工厂。每次 `run()` 提供新的鼠标、键盘和 composition 控制器，共用一个期限、原 `guard` 和一份最终报告。指针位置会延续：每次运行的鼠标从 Chrome 最后确认的上一次运行的指针位置开始，因此不必为了把指针放回原处而发送移动。`pointer` 指定第一次运行的起始位置，例如作用域驱动标签页的页面时传入 `tab.mouse.position`；不指定时，第一次运行与新建的 `Mouse` 一样，从 (0, 0) 开始，human 模式下从视口内的随机点开始。同级控制器的调用串行执行；按住的按键、按钮和 composition 会按逆序清理，之后连接队列才交给下一个所有者。显式调用 `up()` 或 `cancel()` 可提前释放。已有按钮被按住时，点击或拖动不能替换它。

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

原始作用域和 `keyboard.compose()` 默认发送 `Page.enable`，使导航能够中断输入；它们从不改变 target 焦点。托管输入是库唯一会在原始 session 上启用域的地方。run 结束后，该域在调用方的 session 上保持启用，作用域自有的监听器则会移除。设置 `pageEvents: false`（`inputScope()`、`createInputScope()` 和 `compose()` 的选项）后不发送任何 `*.enable` 命令。此时只有该 session 已通过其他途径启用 Page 域，导航才会中断 run；否则 run 在到期、你的 `signal` 中止或 session 结束时停止，composition 仍会在每一步前检查焦点和文档。对话框事件同样只经由启用了 Page 域的 session 送达；没有这样的 session 时，清理无法等待对话框关闭。`browser.inputScope()` 与 Tab 输入用相同方式选择 macOS 编辑命令；`createInputScope()` 的 `mac` 默认为 false。在作用域内请使用 `input.composition`，不要嵌套 `keyboard.compose()`。

外层 `run()` 负责 `cleanupTimeout`，子操作沿用该预算。子操作失败会结束本次 run，即使回调捕获了它的异常。作用域内的鼠标事件携带该作用域键盘当前按住的修饰键。

## MCP

`browser_input_policy` 设置标签页的策略，`browser_click`、`browser_fill`、`browser_type`、`browser_press_key`、`browser_scroll` 等动作使用同一输入层。只有调用方显式启用 human 模式，轨迹与节奏才会改变。`browser_handoff` 用于请人接管并确认，与输入策略无关。
