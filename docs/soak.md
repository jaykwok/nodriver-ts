# 持续运行与资源回收测试

运行 `bun run test:soak -- --hours 48 --output dev/soak-my-run` 启动前台长稳任务。默认每轮间隔 15 秒，使用两个独立临时 Chrome：本地 Streamable HTTP / Chrome Pipe，以及本地 socket / Chrome WebSocket。浏览器、HTTP fixture 与协议服务均为本地资源，HTTP 只监听 loopback；测试不会访问外部检测站。

每轮验证：MCP 中文输入、实际点击计数恰好增加一次、AX 快照、引用及事件缓冲上限；再创建第二个隔离租约，加载四个 frame，验证 Cookie 隔离、导航后句柄失效、context 关闭，并等待 tab/context/session/监听/pending 回到基线。长驻主租约和浏览器持续保留，不通过每轮重启进程规避资源增长。

每分钟写入控制器 RSS/heap/CPU、Chrome 进程 RSS/CPU、Windows handle 或 Linux fd、目标 JS heap/DOM、引用数和内部资源计数。RSS 会重复计算共享页，单个采样点不能证明不存在泄漏；需结合时间曲线与资源基线判断。默认禁止 Runtime.enable/disable/addBinding、Console.enable、Debugger.enable 和自动 init script，记录真实 CDP 命令计数。

输出目录必须没有已有 `status.json`，避免覆盖旧证据。包含：

- `status.json`：状态、PID、开始/预计结束时间、轮数、心跳间隔、源码哈希及资源归属。
- `samples.jsonl`：逐分钟内存、CPU 与资源样本。
- 标准输出：每轮进度；后台启动时保存为 `stdout.log`。
- `STOP`：创建此文件会在当前轮收尾后停止，关闭所有自有浏览器和租约并验证临时 profile 删除。

`status` 可为 starting、running、completed、completed-cycles、stopped、failed。`--cycles 5 --interval-ms 50` 用于快速自检，其 completed-cycles 不能计为 48 小时通过。连续运行依赖主机保持唤醒；超过两分钟或三倍配置间隔的心跳缺口会记录失败并清理，避免把宿主休眠期间计为持续测试。浏览器断开或操作错误同样失败，不自动重启或重放输入。

```powershell
# Windows 停止指定任务
New-Item -ItemType File -Path '<输出目录>STOP'
```

```sh
# Linux/WSL 停止指定任务
touch <输出目录>/STOP
```

状态文件中的时间使用 ISO UTC。真正到达计划时长且清理检查通过才会标记 completed；中止、失败或仍在运行都不算数日长稳验收。

## 已有记录（2026-10-16）

Windows 与 WSL 两端从冻结源码独立运行，原计划 48 小时，于 2026-10-16 按维护者要求经 STOP 文件正常收尾，状态为 stopped。Windows 完成 156 轮、2435.591 秒；WSL 完成 152 轮、2360.264 秒。两端 failure 均为空，自有浏览器/租约/分配计数归零，临时 profile 不再存在。没有完成 48 小时，不能据此宣称数日稳定性；该任务不会自动重启。

结束后的只读核对覆盖逐轮日志、状态、结束尾段、源码快照哈希、资源基线和清理，两端 completed48Hours 均为 false，唯一检查项为主动停止而未完成计划时长。原始日志与样本保留在维护者本地，不随仓库或安装包发布。
