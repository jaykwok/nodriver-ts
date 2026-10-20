# 长稳测试

```sh
npm run test:soak -- --hours 24 --output dev/soak-my-run
```

任务在前台运行，默认每 15 秒一轮，使用两个独立的临时 Chrome：本地 Streamable HTTP + Chrome Pipe，以及本地 socket + Chrome WebSocket。浏览器、HTTP fixture 和协议服务都是本地资源，HTTP 只监听 loopback，不访问外部站点。

## 每轮检查

- MCP 中文输入、实际点击计数恰好增加一次、AX 快照、引用和事件缓冲上限。
- 创建第二个隔离租约，加载四个 frame，验证 Cookie 隔离、导航后句柄失效和 context 关闭。
- 等待 tab、context、session、监听器和 pending 请求回到基线。

主租约和浏览器在整个运行期间保持存活，不通过每轮重启进程来规避资源增长。默认禁止 `Runtime.enable/disable/addBinding`、`Console.enable`、`Debugger.enable` 和自动 init script，并记录真实 CDP 命令计数。

每分钟采样控制器 RSS/heap/CPU、Chrome 进程 RSS/CPU、Windows handle 或 Linux fd、目标页面 JS heap/DOM、引用数和内部资源计数。RSS 会重复计算共享页，判断泄漏需要结合时间曲线与资源基线，单个采样点不能说明问题。

## 输出与控制

输出目录中不能已有 `status.json`，以免覆盖之前的结果。目录包含：

- `status.json`：状态、PID、开始与预计结束时间（ISO UTC）、轮数、心跳间隔、源码哈希和资源归属。
- `samples.jsonl`：逐分钟的内存、CPU 与资源样本。
- `stdout.log`：后台启动时保存的逐轮进度。
- `STOP`：创建此文件后，任务在当前轮收尾时停止，关闭所有自有浏览器与租约，并验证临时 profile 已删除。

```powershell
New-Item -ItemType File -Path '<输出目录>\STOP'   # Windows
```

```sh
touch <输出目录>/STOP                            # Linux / WSL
```

`status` 取值为 starting、running、completed、completed-cycles、stopped 或 failed。只有达到计划时长且清理检查通过才标记 completed。`--cycles 5 --interval-ms 50` 用于快速自检，结果为 completed-cycles，不计为长稳通过。任务依赖主机保持唤醒：心跳缺口超过两分钟或三倍间隔即记为失败并清理，避免把休眠时间算作运行时间。浏览器断开或操作出错同样失败，不自动重启或重放输入。

## 当前结果

Windows 11 x64（Ryzen 5 5600X），Node.js 24.22.0，Chrome 155.0.8059.80，2026-10-19 02:53 至 2026-10-20 02:53（UTC）运行满 24 小时，状态 completed：

- 两种模式各完成 5342 轮，没有失败或重试；最大心跳间隔 21.6 秒，主机全程未休眠。
- 两条传输各发送 586,355 条 CDP 命令，默认禁止的命令为 0。
- 每轮结束时 tab、context、session、监听器与 pending 请求均回到基线（2 / 3 / 4 / 32 / 0），保留的引用数恒为 22。
- 控制器 RSS 各小时中位数在 110–119 MiB 之间，JS heap 34–40 MiB，没有上升趋势；10 个采样点出现最高 191 MiB 的瞬时峰值，随后回落。
- Chrome 进程 working set 之和由约 1.45 GiB 降至约 0.94 GiB；全部进程的 handle 总数由 8845 变为 8899（各取首末一小时的中位数），进程数恒为 19。
- 结束时两个浏览器均已关闭，租约、浏览器和分配计数归零，临时 profile 已删除。

主标签页的 V8 JS heap 与 DOM 计数保持平稳；`Runtime.getHeapUsage` 中有两项随轮数线性上升。600 轮快速运行（`--cycles 600 --interval-ms 50`）的每轮增量与 24 小时运行相同，说明增长取决于操作次数而非时间：

- **backingStorageSize**（外部字符串与 ArrayBuffer）24 小时增加约 0.1 MiB。来源是测试 fixture：页面脚本把每次 input 事件的值追加到 `globalThis.inputs` 且从不清空，每轮增量等于当轮文本长度；清空该数组并强制回收后回到初始值。
- **embedderHeapUsedSize**（Blink 堆）回收后的低点由约 1.3 MiB 升至约 7 MiB，约 1 KB/轮。单独复现时，只用原始 CDP 对同一页面反复执行"聚焦并全选输入框 + `Input.insertText` + `Accessibility.getFullAXTree`"，强制回收后每 2000 次同样增加约 1.2 MiB；去掉 AX 快照或改用脚本赋值时增量小且有界，DOM 不变时反复快照不增长，`Accessibility.disable` 不释放，页面导航后全部释放。这是 Chrome 在同一文档内交替编辑文本与读取 AX 树时保留的内存，不经过框架，也不在框架持有的资源中。长时间停留在同一页面、反复输入并调用 `browser_snapshot` 时会看到同样的增长，导航或重新加载页面即可释放。

以上为单台主机的一次运行，不代表其他平台或负载下的结果。
