# 自动化痕迹审计

[English](../automation-audit.md)

默认架构不自动发送 `Runtime.enable`，也不向页面主世界注入任何东西。这减少了一类常见的 CDP 检测面，但不等于隐藏全部浏览器自动化行为，也不承诺任何站点放行。

## 默认行为

| 检查项              | 行为                                                                                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime.enable      | 主页面、popup、同进程 iframe、嵌套 OOPIF 和重连都不自动发送，也不先 enable 再 disable；Console、Debugger 域同样不启用                                                                                                                                                                    |
| 主世界定位          | `Page.createIsolatedWorld` 获取精确 frame；隔离世界 Document → `DOM.describeNode` → `DOM.resolveNode`（省略 executionContextId）得到同一 Document 的主世界对象                                                                                                                           |
| objectId 校验       | 严格检查 V8 格式、上下文范围、隔离世界官方 ID、isolate 一致性和主世界 Document 的 backendNodeId；不兼容时抛 `UnsupportedError`，不退回启用 Runtime                                                                                                                                       |
| 上下文生命周期      | 缓存绑定 frame、session 与文档代次；导航、BFCache、进程切换、崩溃、`setContent` 后失效。上下文消失使下一次调用重新发现，当前用户脚本不重放                                                                                                                                               |
| 临时对象            | 发现过程产生的对象以 objectGroup 在 finally 中释放，调用者取消后仍尝试清理                                                                                                                                                                                                               |
| 主世界注入          | 无 `Runtime.addBinding`、postMessage 通道、插入 script 或框架全局对象，没有固定 sourceURL。用户显式的 evaluate/addInitScript 保留各自语义；init script 使用每个标签页随机的 world 名称                                                                                                   |
| DOM 辅助            | 查询与动作检查在随机命名的隔离世界执行，不申请跨源通用访问权限                                                                                                                                                                                                                           |
| navigator.webdriver | 通过 Chromium 的 AutomationControlled 启动开关关闭，getter 保持原生实现，navigator 上不增加属性                                                                                                                                                                                          |
| Headless UA         | `maskHeadless`（显式启用，显式 `userAgent` 时不生效）在页面 session 上用 `Emulation.setUserAgentOverride` 去掉 HeadlessChrome，并附上从 `chrome://version` 读取的原生 UA-CH，避免 Client Hints 消失。文档、HTTP 请求头与专用 Worker 一致；Shared/Service Worker 是独立目标，可能保留原值 |
| 协议面              | `Network.enable` 按需发送；路由与认证只用 Fetch 域。默认穿透查询用 `DOM.getDocument` 识别 closed shadow root，这会让该 session 收到 DOM 结构事件                                                                                                                                         |
| 输入                | human 模式下 US 布局字符发送成对 keyDown/keyUp（大写与上档符号自动按 Shift），修饰键与无文本键用 rawKeyDown；按下及按住移动时 pointer pressure 为 0.5；首个指针位置在视口 15–85% 随机；只在其他标签页可能处于前台时调用 `Page.bringToFront`                                              |
| 浏览器机制          | 保留 sandbox、站点隔离和 CSP。Pipe 不监听调试 TCP 端口，WebSocket 仍支持本地与远程连接。agent 预设只关闭首次运行、搜索引擎选择、崩溃恢复气泡和后台节流                                                                                                                                   |

Chromium 在未指定上下文时把 DOM 节点包装到所属 frame 的主世界，见 [ResolveNode 源码](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/resolve_node.cc)。[V8 的 objectId 格式](https://github.com/v8/v8/blob/main/src/inspector/remote-object-id.cc)是内部实现，CDP 不保证其稳定。

独立的 [Chromium 预览版工作流](../../.github/workflows/chromium-preview.yml) 每周、手动及修改相关核心/审计文件的 PR 运行 Beta、Dev、Canary，环境为 Linux/Node.js 24。它记录实际浏览器版本，运行 `test:audit`、`test:compat`（Pipe/WebSocket 的主世界发现、导航、OOPIF 和上下文失效）及差分回归门槛，不重试。预览版失败时通过调整发现逻辑处理，绝不增加 `Runtime.enable` 回退。

在大页面上读取完整 AX 树需要时间（见[分阶段性能结果](performance-phases.md)）；文本编辑与完整 AX 读取交替进行时，Chrome 会保留部分 Blink 内存直到导航（见[长稳测试](soak.md)）。页面自有探针看不到直接的 AX 信号，但这不代表 AX 读取无法被观察。[差分审计](differential-audit.md)分离了启动参数、端点、原始连接、库初始化、覆盖与操作。

## 回归检查

```sh
npm run test:audit
npm run test:all
```

- `test/integration/runtime.test.ts` 在浏览器启动前截取 `Transport.send` 的真实消息，覆盖双传输、四类 frame（含嵌套 OOPIF）、中文输入、closed shadow root、JSHandle、导航、BFCache、popup 与 WebSocket 重连，断言禁用域、绑定和自动 init script 命令为零。另用独立浏览器显式启用 Runtime 作阳性对照，证明采集器能看到这些命令及 executionContextCreated/consoleAPICalled 事件。
- 所有集成测试、HTTP/socket/嵌入 MCP 测试和长稳测试同样断言自动发送的禁用命令为零。
- 页面自有探针比较操作前后的主世界全局属性、元素属性、DOM 结构与属性变更、console 函数和 webdriver getter；查询与输入没有留下这些痕迹，四类 frame 的 webdriver 均为 false 且 getter 为原生。页面仍能观察鼠标事件、表单值和滚动。
- Chrome 155 中 Error.stack getter 在启用 Runtime 的阳性对照里也不被读取，Error.name 会在 console 调用本身被读取。因此测试以协议命令与事件为断言对象，老式 stack 探针无法说明 CDP 能否被检测。
- `test/integration/stealth.test.ts` 固化 UA/UA-CH、pointer pressure 与按键序列；单元测试覆盖不兼容 objectId、错误的世界或文档、临时句柄清理、发现期间导航和上下文消失后的恢复。

## 第三方检测

### 开源检测器

使用 Chrome 155，在 Windows 与 Linux（WSLg）上以有界面/无界面 × Pipe/WebSocket 四种组合运行，不打开 DevTools，不修改 UA、字体、时区或网络出口。

- [rebrowser-bot-detector e1a25b1](https://github.com/rebrowser/rebrowser-bot-detector/tree/e1a25b1ff264cc9a5b5ea7fe8a6dfc26e3b1c718)：Windows 四种组合无正向命中；WSL 的 UA 检查提示 Chrome for Testing 的品牌集合缺少 Google Chrome。exposeFunction 检查不适用，runtimeEnableLeak 依赖上文所述的 stack 探针。
- [Brotector 98b3309](https://github.com/ttlns/brotector/tree/98b330999e9928a226ca0c8254dddf909d1583bd)：每种组合分别在 crash 探针关闭与开启时运行，CSP 允许所需的同源和 Blob Worker；均无检测回调，开启 crash 探针时未崩溃。

### 在线检测页

CreepJS、BrowserScan 与 Pixelscan，Windows 上的 Chrome 155 / Pipe。每格使用新的临时 profile，不拦截请求、不覆盖 UA 或环境、不配置代理或 WebRTC 限制。headless 列使用原生 HeadlessChrome UA（默认行为）。

| 检测项                                      | 有界面，instant  | headless，instant | 有界面，human（seed=42） |
| ------------------------------------------- | ---------------- | ----------------- | ------------------------ |
| CreepJS：like-headless / headless / stealth | 19% / 0% / 0%    | 25% / 67% / 0%    | 19% / 0% / 0%            |
| BrowserScan                                 | Normal           | Robot             | Normal                   |
| Pixelscan：Bot check                        | 未报告自动化行为 | 报告自动化行为    | 未报告自动化行为         |
| Pixelscan：指纹一致性                       | inconsistent     | inconsistent      | inconsistent             |

- Linux（WSLg）上结果相同：headless 为 Robot 并报告自动化行为，有界面为 Normal；CreepJS like-headless 有界面 44%、headless 50%。
- Pixelscan 另显示 Timezone spoofed、Proxy detected。原生 JS 时区与站点推断的出口时区不同，这些标签不说明库伪造了环境。
- human 策略没有改变判定。这些页面不评估点击与打字，因此无法据此判断 human 策略的效果。
- 每格的 webdriver 均为 false，且未发送任何禁止的协议命令。CreepJS 分数不是检测概率。

## 仍可观察的特征

1. **Headless**：`maskHeadless` 只改 UA 与 UA-CH，屏幕尺寸（如 800×600）等其他 headless 信号不变，有界面模式也不保证隐藏全部特征。推荐有界面模式；无图形桌面时须显式选择 headless，不自动降级。
2. **执行世界**：`evaluate()` 默认在 main world 运行，以便访问页面业务对象，页面可以 hook 自己的方法。通用 DOM 读取可用 `query()` 或 `evaluate(fn, arg, { world: 'isolated' })`；隔离世界也共享 DOM。
3. **环境一致性**：UA、Client Hints、语言、时区、屏幕、字体、GPU、Worker 信息和代理出口需要分别测量。有界面模式保留浏览器原始值；headless 也默认保留原生值；可选覆盖只修改页面/Dedicated Worker UA，可能与 Shared/Service Worker 矛盾。只改一个字段会造成不一致，`setEnvironment()` 不负责完整的 Worker/设备一致性。
4. **输入**：点击和文字经 CDP Input 派发，页面仍能观察时序与轨迹；select 等 DOM 改值派发合成事件。不承诺所有操作都像物理设备输入。
5. **外部因素**：连接前已存在的 DevTools 或其他 CDP 客户端、调用者手动启用的域、TLS/IP 信誉、代理与 WebRTC 出口都不在默认行为的覆盖范围内。Pipe 只减少本机调试端口暴露。
