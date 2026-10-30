# 输入策略、事件与取消

[English](../input.md)

默认 `instant` 策略执行快速、确定的动作。显式 `tab.setInputPolicy({ mode: 'human', seed: 42 })` 启用连续指针轨迹、加减速、停顿、按下/抬起间隔、分段滚动和逐字文本节奏。这是可配置的程序化行为模型，不等同于物理输入，也不承诺通过检测。

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
await input.type('中文👨‍👩‍👧‍👦é'); // 在当前光标/选择区输入；不全选、不提交
await input.type(['明确提交片段', '😀']);
await tab.keyboard.press('Control+A'); // macOS 上全选为 Meta+A
await tab.mouse.wheel(0, 420);
console.log(tab.inputBehavior.lastReport);
```

## 参数

时间单位为毫秒，各 range 为最小/最大值：步数 1–120，时间 0–3000，`targetInset`（排除可见目标边缘的比例）0–0.45。未指定 seed 时，在 Tab 的输入行为创建时用 Node crypto 生成一次。首次启用 human、后续动作、模式切换和不指定 seed 的 configure 都保留该随机序列；其他省略的策略参数仍恢复默认值。显式传 seed（即使相同）会重置该行为实例的序列，不影响其他 Tab。seed 决定每个标签页的随机序列；相同的起点、布局、配置和调用序列会复现相同的计划轨迹与延迟，但实际调度、帧率和事件时间不保证逐毫秒一致。策略不制造错字、额外提交或随机业务动作，动作执行期间不能修改策略。

`randomState` 可在动作边界恢复 PRNG；只用 seed 则需要此前的随机采样/动作历史。完整复现还需要相同策略、布局、指针/键盘状态和参数。未显式指定 seed 时，每次运行使用不同的随机序列。

## 文本与按键

- **`fill()`**：整段替换，使用焦点、选择区和一次 `Input.insertText`。
- **`type()`**：在当前选择区按字素（Intl.Segmenter）逐个提交，也接受字符串片段数组；不拆开 emoji 代理对、ZWJ 序列或组合字符。单次最多 100000 个 UTF-16 单元。
- **按键事件**：`typing: 'keys'`，或 human 模式下的默认 `auto`，对 US 布局可打字符（字母、数字、常用符号、空格）逐个发送 keyDown/keyUp，大写与上档符号自动按住 Shift；keyUp 与 keyDown 的 key 一致。中日韩、emoji、换行和制表符使用 `insertText`。`typing: 'insertText'` 全部使用 `insertText`。
- **`press()`**：支持命名键（Enter、Tab、Escape、方向键、Home/End、PageUp/PageDown、F1–F12、Space 等）、修饰键组合与 US 布局字符，例如 `Shift+Tab`、`Control++`；按住 Shift 时发送上档字符。`keyDefinition()` 与 `parseChord()` 已导出。
- **macOS 编辑快捷键**：浏览器运行在 macOS 时，按键事件附带 AppKit 编辑命令（CDP `commands`），使 `Meta+A` 全选、`Meta+Z` 撤销、`Alt+ArrowLeft` 按词移动、`Control+A` 移到段首等组合与 Mac 键盘一致；平台按浏览器自身的 UA 判断，不受 UA 覆盖影响。
- **`select()`**：通过 DOM 修改选项并派发合成 input/change，isTrusted 不改写；需要指针或按键交互时由调用者显式操作。

普通 `type()` 不生成 composition 生命周期；显式 CDP composition 由 `keyboard.compose()` 和 input scope 提供。两者都不模拟操作系统输入法候选窗或非 US 键盘布局。

## 指针与点击

点击先滚动到视口，检查可见、启用、遮挡，并两次取点（间隔 32 ms）确认位置稳定。轨迹结束后再次检查目标坐标与父 frame 命中，位置改变或被遮挡时拒绝按下，不自动重新定位或重放。

human 模式的首个指针位置在视口 15–85% 范围内随机，按下及按住移动时 pressure 为 0.5。OOPIF 内的 hover 会确认事件确实投递；仅当指针已停在同一坐标时才额外发送 0.25px 探针，该探针本身会产生可观察事件。

## 串行与取消

Tab 输入、独立构造的 `new Mouse(session)` / `new Keyboard(session)` 和 raw input scope 共享同一 `Connection` 的可重入队列，最多容纳 128 个等待或执行中的调用。不同连接不共享队列，直接调用 `Session.send()` / `sendWith()` 也不经过输入队列。独立的 `down()` 成功后保持按下，直到调用 `up()`；需要把多次调用作为一个整体持有队列时使用 scope。scope 按取得顺序的逆序自动释放持有的输入资源。

`InputOptions.timeout` 是从调用时开始计算的输入阶段总预算，包含排队和准备，默认 10000 ms。每条输入命令通过 `sendWith()` 接收剩余时间和合并后的取消信号。Element 的 `click`、`hover`、`fill`、`type` 将前置操作纳入同一预算。scope 内的子操作可以缩短预算、增加 signal 或 guard，不能延长 scope 的 deadline 或替换原 guard。

取消和到期会及时抛出 `InputActionError` 并保留 cause。`error.report` 记录动作停止时的状态；`error.cleanup` 在清理结束后返回 `{ status, report }`，status 为 `completed`、`failed` 或 `disconnected`。报告包含 `phase`（`queued`、`running`、`cleaning`、`done`）、`cleanup`、已确认的事件数和片段数、seed、取得队列时的 `randomState`、最多 2000 项 trace 和清理错误，不保存输入文本。调用方停止等待后仍在处理的命令，会通过 cleanup 结果和连接生命周期体现。

`cleanupTimeout` 默认为 5000 ms，独立于输入 timeout 和已取消的 signal，限制释放及迟到响应排空的总时间。清理完成前，后续托管输入继续排队。释放失败、清理超时或连接中断会封锁该连接后续的托管输入，其 cause 为 `InputBlockedError`；调用方恢复目标状态并建立新连接后再继续。输入动作保留原命令结果，不会自动重发。需要 drain 时覆盖整个连接，也包括其他待响应的 raw 命令。

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

清理结果描述托管释放和协议回复。业务文档的最终状态由应用负责，已送达的输入无法回滚。用户回调应观察传入的取消 signal。scope 结束后，保留的控制器会拒绝继续输入。

## 显式 composition

先将编辑器聚焦，再调用 `keyboard.compose()`。回调获得一个 composition 控制器：`update(text, selection?, options?)` 开始或更新，`commit(text?, options?)` 尝试一次提交，`cancel(options?)` 取消。选区按更新文本中的 UTF-16 单元偏移计算，默认位于文本末尾。文本长度为 1–100000 个 UTF-16 单元；清空 composition 使用 `cancel()`。

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

更新使用 `Input.imeSetComposition`，提交使用 `Input.insertText`。回调返回时尚未提交或取消的 composition 会在清理期间尝试取消。重复 `cancel()` 无副作用；再次 commit 会被拒绝，包括第一次提交结果不确定的情况。普通 `type()` 保持字素、按键和 insertText 的既有行为。

每次更新和提交前都会核对最初的焦点元素，包括开放 shadow root 和可访问的 iframe 祖先，并在文档改变时停止。只有确认仍是原编辑器时才发送提交或取消；无法检查的跨域祖先保持不变。焦点检查和 CDP 输入是不同操作，因此调用方可以继续验证最终文档。不启用 Runtime，也不修改浏览器方法。

## Raw input scope

`browser.inputScope(session)` 或导出的 `createInputScope(session, { policy?, mac? })` 为 target session 创建可复用的 scope 工厂。每次 `run()` 提供独立的鼠标、键盘、composition 控制器，共用一次 deadline、原 guard 和最终报告。同级控制器调用串行执行；按键、按钮、composition 按逆序清理后才交接连接队列。显式 `up()` 或 `cancel()` 可提前释放。已持有按钮时，click/drag 不会替换它。

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

Raw scope 为跟踪导航启用 Page 事件，不改变 target 焦点。域启用状态保留在调用方的 session 上，scope 自有监听器在结束后移除。`browser.inputScope()` 根据浏览器 UA 选择 macOS 编辑命令；`createInputScope()` 的 `mac` 默认为 false，可显式指定。scope 内使用 `input.composition`，不要嵌套 `keyboard.compose()`。

`cleanupTimeout` 由外层 `run()` 配置，子操作沿用该预算。子操作失败会终止本次 run，即使回调捕获了该操作的异常。scope 内的鼠标事件携带该键盘当前按住的修饰键状态。

## MCP

`browser_input_policy` 设置标签页策略，`browser_click`、`browser_fill`、`browser_type`、`browser_press_key`、`browser_scroll` 等动作使用同一输入层。只有调用方显式启用 human 模式才会改变轨迹与节奏。`browser_handoff` 是人工接管确认，与输入策略无关。
