# 输入策略、事件与取消

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

时间单位为毫秒，各 range 为最小/最大值：步数 1–120，时间 0–3000，`targetInset`（排除可见目标边缘的比例）0–0.45。seed 决定每个标签页的随机序列；相同的起点、布局、配置和调用序列会复现相同的计划轨迹与延迟，但实际调度、帧率和事件时间不保证逐毫秒一致。策略不制造错字、额外提交或随机业务动作，动作执行期间不能修改策略。

## 文本与按键

- **`fill()`**：整段替换，使用焦点、选择区和一次 `Input.insertText`。
- **`type()`**：在当前选择区按字素（Intl.Segmenter）逐个提交，也接受字符串片段数组；不拆开 emoji 代理对、ZWJ 序列或组合字符。单次最多 100000 个 UTF-16 单元。
- **按键事件**：`typing: 'keys'`，或 human 模式下的默认 `auto`，对 US 布局可打字符（字母、数字、常用符号、空格）逐个发送 keyDown/keyUp，大写与上档符号自动按住 Shift；keyUp 与 keyDown 的 key 一致。中日韩、emoji、换行和制表符使用 `insertText`。`typing: 'insertText'` 全部使用 `insertText`。
- **`press()`**：支持命名键（Enter、Tab、Escape、方向键、Home/End、PageUp/PageDown、F1–F12、Space 等）、修饰键组合与 US 布局字符，例如 `Shift+Tab`、`Control++`；按住 Shift 时发送上档字符。`keyDefinition()` 与 `parseChord()` 已导出。
- **macOS 编辑快捷键**：浏览器运行在 macOS 时，按键事件附带 AppKit 编辑命令（CDP `commands`），使 `Meta+A` 全选、`Meta+Z` 撤销、`Alt+ArrowLeft` 按词移动、`Control+A` 移到段首等组合与 Mac 键盘一致；平台按浏览器自身的 UA 判断，不受 UA 覆盖影响。
- **`select()`**：通过 DOM 修改选项并派发合成 input/change，isTrusted 不改写；需要指针或按键交互时由调用者显式操作。

不模拟操作系统输入法候选窗、composition 生命周期或非 US 键盘布局。

## 指针与点击

点击先滚动到视口，检查可见、启用、遮挡，并两次取点（间隔 32 ms）确认位置稳定。轨迹结束后再次检查目标坐标与父 frame 命中，位置改变或被遮挡时拒绝按下，不自动重新定位或重放。

human 模式的首个指针位置在视口 15–85% 范围内随机，按下及按住移动时 pressure 为 0.5。OOPIF 内的 hover 会确认事件确实投递；仅当指针已停在同一坐标时才额外发送 0.25px 探针，该探针本身会产生可观察事件。

## 串行与取消

同一浏览器内的高层输入和公开的 mouse/keyboard 方法共享一个可重入的串行通道（最多 128 个等待或执行中的调用），不同标签页或租约的输入不会争抢焦点。低层 `down`/`up` 可组合自定义动作，两次独立调用之间的调度由调用者负责；高层 `press`/`click`/`drag` 在 finally 中释放自己按下的键或按钮。不要在长时间等待中一直按住修饰键。

鼠标与键盘动作返回 `InputReport`：事件数、已提交片段数、seed、最多 2000 项计划 trace 和清理错误，不记录输入文本。取消、到期、导航、文档失效或失去焦点会停止逐步输入，`InputActionError.report` 说明已完成的部分（MCP 返回 `partialInput`）。已送达浏览器的点击、输入或滚动不会回滚或重放；finally 尝试抬起当前动作持有的按钮和键，连接已断开时无法保证远端释放，`cleanupErrors` 会记录这种情况。取消不会让仍在收尾的写操作提前放行。

## MCP

`browser_input_policy` 设置标签页策略，`browser_click`、`browser_fill`、`browser_type`、`browser_press_key`、`browser_scroll` 等动作使用同一输入层。只有调用方显式启用 human 模式才会改变轨迹与节奏。`browser_handoff` 是人工接管确认，与输入策略无关。
