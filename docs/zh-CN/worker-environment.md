# Worker 启动与网络一致性实验

[English](../worker-environment.md)

这项能力实验用于验证启动参数和暂停 Target 后配置的实际作用，为浏览器级环境策略提供依据。实验只使用临时浏览器和本地夹具，不改变 `Browser.launch()`、`maskHeadless`、默认挂载策略或生产代码中的 Worker 处理方式。

## 复现

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

稳定版 Windows/Linux 和 Beta/Dev/Canary 工作流会采集 Pipe 矩阵并上传原始报告。采集失败会使任务失败；观测到的配置差异保留在报告中，不会被解释为环境配置已通过验收。

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

JSON 分开保存命令结果、首段脚本观测、请求值核验、跨上下文比较和请求头。命令成功不会覆盖字段不匹配。上下文/请求缺失、意外的侵入式命令、重复预处理、恢复失败或连接清理不完整，会使采集失败。Locale 所有权冲突等命令拒绝属于能力证据，明确保留。运行器成功退出只表示采集完成，不代表所有覆盖都成功。

`zh-CN`、`en-US` 等都是正常的用户语言偏好，不是自动化指标，也不要求统一成某种语言。`matchesFirstScriptLanguages` 不区分大小写地比较有序语言列表，进度计数命名为 `languageHeaderDifferences`；两者只记录差异，不判定失败。[Chromium 会扩展语言列表](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/http/http_util.h)，补充不含地区的回退项；请求头权重及偏好列表不必与 `navigator.languages` 完全相等。是否回归，应对照同一浏览器和配置的原生基线及用户明确要求的行为判断，不能只看字符串是否相同。库默认保留原生语言。

## 本地证据，2026-10-21

Windows x64、Chrome **156.0.8078.48**、Node **24.22.0**：五组配置、两种传输的 headless 矩阵重复两次，共 **20 次运行、140 份样本**；另跑 headful Pipe 五组，共 **5 次运行、35 份样本**。全部收集到预期上下文及初始/样本请求，恢复 Target，并在关闭连接后达到零待处理请求、零监听器。没有启用 Runtime/Console/Debugger、创建 binding 或注入初始化脚本。

- `native`：已采样字段和 UA 请求头跨上下文一致。
- `launch-flags`：本次 Windows 实验中，UA 字符串和语言值一致。UA-CH 仍保留 Chromium 品牌，部分高熵字段为空；修改 UA 字符串并未生成与之对应的自定义品牌/元数据。
- `paused-overrides`：Shared/Service Worker 的 `navigator.userAgent` 保留启动值，但后续请求头已采用覆盖值。即使挂载事件报告 `waitingForDebugger`，主文档仍可能在配置完成前执行夹具的第一条语句。初始脚本请求与后续请求也可能不同。
- `combined`：启动 UA 消除了本夹具中的 UA/请求头不匹配，但直接导航仍暴露早期语言列表、Intl 和 UA-CH 差异。
- `prepared-navigation`：本地五次运行中，请求的同步字段、含异步高熵值的跨上下文观测，以及 UA/请求头比较均一致。Service Worker 和嵌套 Worker 的初始请求采用启动时的 Accept-Language 列表（`fr-FR,fr,en-US,en`），后续请求采用 CDP 列表（`fr-FR,fr`）；q 值保留在原始请求头中。这记录了各请求实际采用哪组配置，不表示英语回退项或语言列表差异就是自动化痕迹。此外每次仍记录 **4 个 Locale 命令冲突**；值一致不代表这些命令成功，也不代表 Locale 能按 Target 独立控制。

后续以 `prepared-navigation` 为对照，增加 `prepared-locale-check`。在两种传输上各重复两次 Headless 实验（**8 次运行、56 个样本**），另跑两种传输的 Headful 实验（**4 次运行、28 个样本**），对照组每次复现 4 个 Locale 所有权冲突，新组命令错误为 0，请求的首段脚本字段均符合设置，Target 恢复与连接清理均完成。最初尝试在暂停的 OOPIF 中读取 Locale 时，因默认执行上下文尚未创建而失败，原始报告保留在本地。修订后的实验只在已有执行上下文的空白页和 Worker 中读取；OOPIF 仍在上下文创建前显式覆盖，随后用夹具样本核验。

`already-observed` 只表示读到了所需 Locale，不表示取得覆盖所有权。这一组会在受控夹具第一条语句之前额外执行 `Runtime.evaluate`，但不启用 Runtime 事件；它不证明任意页面中执行的安全性、另一会话脱离后设置仍然保持，或共享渲染进程的上下文可以独立配置 Locale。即使后续读取一致，被拒绝的命令仍保留为错误。

上述结果只描述这份夹具、浏览器版本和宿主环境，不证明任意 Target 的启动过程、没有时序副作用或完整 HTTP Client Hints 等价。Worker 请求中缺少的 Client Hints 按实际缺失记录，不人为补成页面请求的样子。持久化 Profile、Service Worker 激活/更新/重启、既有 Worker、弹窗、外部浏览器所有权与跨客户端隔离不在本次验证范围内。

## 接入生产策略前的约束

启动器已有 `userAgent`、`lang`、`windowSize` 和统一 Headless 的 `--headless=new`。待解决的是生效范围和应用顺序。CDP 中 Dedicated Worker 的类型是 `worker`；同进程 Frame 并不各自拥有 Target。[`Target.setAutoAttach`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Target.pdl) 作用于相关 Target，可能需要递归挂载。

实验由 Browser 根挂载接管 Shared/Service Worker，由子挂载接管 Dedicated Worker/OOPIF。开发阶段，Browser/Page 重复挂载 Service Worker 曾使预处理停滞，直到恢复看门狗触发。最终夹具避开该重叠，为每个已观测 Target 设置有界预处理和恢复，并在失败时关闭自己创建的浏览器。这是夹具策略，不能替代生产代码的所有权检查。

[Chromium 的 Locale 控制器](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/locale_controller.cc) 共享渲染进程状态，会拒绝第二个 agent 取得覆盖所有权。生产实现需要处理这一作用域、定义部分应用失败的行为，并核验实际值，不能静默将命令错误当成成功。还应在导航前准备自有页面，区分仅启动时可设的配置与动态配置，保留 `attach: 'none'`/外部浏览器行为，并补测 Worker 持久化和清理，再启用通用策略。这些问题解决前继续保留原生默认值。
