# Worker 启动环境基准

[English](../worker-environment.md)

这项基准比较把 UA、语言和时区应用到所有执行上下文的几种方式，从启动参数到通过 CDP 配置暂停的 Target。它只使用临时浏览器和本地夹具，与库本身相互独立：`Browser.launch()`、`maskHeadless` 和 Target 挂载都不使用这些策略。

## 运行

```sh
npm run bench:worker-environment
```

需要 Node.js 24.22.0 或以上，以及已安装的 Chromium 浏览器；`CHROME_PATH` 可指定可执行文件。默认通过 WebSocket、Pipe 运行下表六组配置，将结果写入 `test-results/worker-environment.json`，并在 stdout 输出简要进度。

| 变量                      | 默认值 / 含义                          |
| ------------------------- | -------------------------------------- |
| `WORKER_AUDIT_VARIANTS`   | 默认六组全跑；可用下表名称，以逗号分隔 |
| `WORKER_AUDIT_TRANSPORTS` | `websocket,pipe`                       |
| `WORKER_AUDIT_REPEATS`    | `1`，范围 1–5                          |
| `WORKER_AUDIT_HEADFUL`    | `1` 选择 headful，否则 headless        |
| `WORKER_AUDIT_REPORT`     | 输出 JSON 路径                         |

稳定版 Windows/Linux 和 Beta/Dev/Canary 工作流会采集 Pipe 矩阵并上传报告。采集失败会使任务失败；配置差异记录在报告中，不视为失败。

## 测量范围

同一份夹具脚本的第一条语句同步采集 UA、语言、Intl Locale/时区和低熵 UA-CH。覆盖七种上下文：主文档、同进程 Frame、OOPIF、Dedicated Worker、嵌套 Dedicated Worker、Shared Worker、Service Worker。高熵 UA-CH 异步采集并单独标注。服务端分别记录文档/Worker 的初始请求和随后发送的样本 POST，保留 UA、Accept-Language 和实际存在的 Client Hints。

| 配置组                  | 配置                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `native`                | 只发现 Target 的 CDP 连接，保留原生环境                                                  |
| `launch-flags`          | 仅设置启动参数 `--user-agent` 和 `--lang`                                                |
| `paused-overrides`      | Browser/子 Target 自动挂载，恢复前发送 UA/CH、时区、Locale 命令；直接以夹具 URL 创建页面 |
| `combined`              | 启动参数与暂停覆盖组合，直接以目标 URL 创建页面                                          |
| `prepared-navigation`   | 同组合配置，但先创建空白页，完成配置后再调用 `Page.navigate`                             |
| `prepared-locale-check` | 导航前配置；先读取空白页和 Worker 当前的 Locale，再决定是否申请覆盖                      |

UA 和 Client Hints 使用刻意构造的测试标记，不是推荐的设备身份。`native` 也不是无 CDP 或物理输入基线；这些对照请参阅[差分审计](differential-audit.md)。

JSON 分开保存命令结果、首段脚本观测、请求值核验、跨上下文比较和请求头。命令成功不会覆盖字段不匹配。上下文/请求缺失、意外的侵入式命令、重复预处理、恢复失败或连接清理不完整，会使采集失败。Locale 所有权冲突等命令拒绝会明确记录。成功退出只表示采集完成，不代表所有覆盖都成功。

`zh-CN`、`en-US` 等都是正常的用户语言偏好，不是自动化指标，也不要求统一成某种语言。`matchesFirstScriptLanguages` 不区分大小写地比较有序语言列表，进度计数命名为 `languageHeaderDifferences`；两者只记录差异，不判定失败。[Chromium 会扩展语言列表](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/http/http_util.h)，补充不含地区的回退项；请求头权重及偏好列表不必与 `navigator.languages` 完全相等。应对照同一浏览器和配置的原生基线及明确请求的值来比较，不能只看字符串是否相同。库默认保留原生语言。

## 观测到的行为

- `native`：已采样字段和 UA 请求头在所有上下文中一致。
- `launch-flags`：UA 字符串和语言值一致，但 UA-CH 保留 Chromium 品牌，部分高熵字段为空；只改 UA 字符串不会生成对应的品牌与元数据。
- `paused-overrides`：Shared/Service Worker 的 `navigator.userAgent` 保留启动值，后续请求头却采用覆盖值。即使挂载事件报告 `waitingForDebugger`，主文档仍可能在配置完成前执行第一条语句，因此初始请求与后续请求可能不同。
- `combined`：启动 UA 消除了 UA/请求头不匹配，但直接导航仍暴露早期语言列表、Intl 和 UA-CH 差异。
- `prepared-navigation`：请求的字段、跨上下文值（含高熵 UA-CH）与 UA 请求头均一致。Service Worker 和嵌套 Worker 的初始请求使用启动时的 `Accept-Language` 列表（如 `fr-FR,fr,en-US,en`），后续请求使用 CDP 列表（`fr-FR,fr`）。由于 Locale 覆盖按渲染进程共享，每次运行还会产生 4 个 Locale 命令冲突。
- `prepared-locale-check`：先读取空白页和 Worker 上已生效的 Locale，只在需要时申请覆盖；不产生命令错误，请求的首段脚本字段一致。暂停的 OOPIF 尚无默认执行上下文，因此在上下文创建前覆盖，再通过夹具样本核对。

`already-observed` 只表示读到了所需 Locale，不表示取得覆盖所有权。该检查会在夹具第一条语句之前额外执行 `Runtime.evaluate`，但不启用 Runtime 事件。Worker 请求中缺少的 Client Hints 按实际缺失记录，不会补成与页面请求一致。持久化 Profile、Service Worker 更新/重启、已在运行的 Worker、弹窗与外部浏览器不在本基准范围内。

## 浏览器级策略的约束

启动器已支持 `userAgent`、`lang`、`windowSize` 和 `--headless=new`；各策略的区别在于每项设置能到达哪些上下文、何时生效。CDP 中 Dedicated Worker 的类型是 `worker`；同进程 Frame 并不各自拥有 Target。[`Target.setAutoAttach`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Target.pdl) 作用于相关 Target，可能需要递归挂载。

基准由 Browser 根挂载接管 Shared/Service Worker，由子挂载接管 Dedicated Worker/OOPIF；Browser 与 Page 同时挂载同一个 Service Worker 会使预处理停滞。每个已观测的 Target 都在有界的预处理步骤内恢复，失败时关闭自己创建的浏览器。

[Chromium 的 Locale 控制器](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/locale_controller.cc) 共享渲染进程状态，会拒绝第二个 agent 取得覆盖所有权。浏览器级策略需要处理这一作用域和部分应用失败，在导航前准备自有页面，区分仅启动时可设的配置与动态配置，并保持 `attach: 'none'` 与外部浏览器行为不变。因此库默认保留原生值。
