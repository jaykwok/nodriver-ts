# 输入策略、事件与取消

默认 `instant` 保留快速确定性动作。显式 `tab.setInputPolicy({mode:'human',seed:42})` 启用连续指针轨迹、加减速、停顿、按下/抬起间隔、分段滚动和逐步文本节奏。这是可配置的程序化行为模型，没有物理输入或检测必过保证。

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
  typing: 'auto', // auto|keys|insertText；auto 在 human 模式下使用按键事件
  scroll: 'auto', // auto|wheel|dom；auto 在 human 模式下先用滚轮把元素滚到视口
});
const input = await tab.waitForSelector('input');
await input.fill('replace all');
await input.type('中文👨‍👩‍👧‍👦é'); // 当前 caret/selection；不选中全部、不提交
await input.type(['明确提交片段', '😀']);
await tab.keyboard.press('Control+A');
await tab.mouse.wheel(0, 420);
console.log(tab.inputBehavior.lastReport);
```

时间单位为毫秒，各 range 是最小/最大值；步数 1–120，时间 0–3000，targetInset 为可见目标边缘排除比例 0–0.45。seed 控制每个 tab 的随机序列；相同起点、布局、配置和调用序列能复现计划轨迹和延迟。实际调度/帧率/事件时间不保证逐毫秒相同。不会制造错字、额外提交或随机业务动作。动作执行期间不能改策略。

`fill()` 仍为整段替换，使用焦点、选择区和一次 Input.insertText。`type()` 在当前选择区逐字素提交（Intl.Segmenter），也接受完整字符串片段数组；不拆开 emoji 的代理对、ZWJ 家庭或组合附加字符。输入最多 100000 UTF-16 单元。`typing` 为 `keys`，或为默认 `auto` 且处于 human 模式时，US 布局可打字符（字母、数字、常用符号、空格）逐个发送 keyDown/keyUp，大写与上档符号自动按住 Shift；其余文本（中日韩、emoji、换行、制表符）使用 CDP insertText。`insertText` 强制全部使用 insertText。不模拟操作系统输入法候选窗、composition 生命周期或完整原生 IME，也不模拟非 US 键盘布局。物理 `press()` 支持命名键（Enter、Tab、Escape、方向键、Home/End、PageUp/PageDown、F1–F12、Space 等）、修饰键组合与 US 布局字符，例如 `Shift+Tab`、`Control++`；按住 Shift 时发送上档字符，keyUp 与 keyDown 的 key 一致。`keyDefinition()`、`parseChord()` 已导出。`select()` 继续通过 DOM 改选项并发送合成 input/change，isTrusted 不改写；需要指针/按键交互时由调用者显式操作。

Browser 内的所有高层输入和公开 mouse/key 方法共享可重入串行通道（最多 128 个等待/执行调用）；不同 tab/租约的输入不会抢焦点。MCP 仍保留管理器/浏览器池的有界操作队列。低层 down/up 可供调用者构建自定义组合，但两次独立调用之间的业务调度由调用者负责；高层 press/click/drag 负责自身按下状态的 finally 释放。不要在自己的长等待中无限持有物理修饰键。

点击先滚动、检查可见/启用/遮挡和两次取点稳定性。human 模式的首个指针位置随机落在视口 15–85% 范围内；按下及按住移动时 pressure 为 0.5。现有稳定检查仍是 32ms 时间间隔，不称为两个 requestAnimationFrame；后台/无界面页的 rAF 可能受节流。轨迹结束后再次检查目标坐标与父 frame 命中，位置改变或遮挡时拒绝按下，不自动重新定位重放点击。OOPIF 实际 hover 确认保留；只有指针已停在相同坐标时才使用 0.25px 探针，避免每次固定往返。该探针仍会产生可观察事件。

鼠标/键盘动作返回 InputReport，包含事件数、已提交片段数、seed、最多 2000 项计划 trace 与清理错误，不记录输入文本。取消、时限、导航、失效或焦点丢失使逐步输入停止；InputActionError.report 表明已完成部分，MCP 返回 partialInput。已经送到浏览器的点击、输入或滚动不可回滚，不会重放。finally 尝试抬起当前动作持有的按钮/键；连接已断时无法保证远端实际释放，cleanupErrors 会明确记录。动作取消不提前让仍在收尾的写操作放行，已发出的 CDP 命令仍受协议期限限制。

MCP 新增 browser_input_policy、browser_type、browser_scroll，原 browser_click/fill/press_key 自动使用相同输入对象。HTTP、stdio、socket、InMemory 共用实现。只有调用方明确启用 human 模式才改变轨迹和节奏；browser_handoff 仍是人工接管确认，与该策略无关。
