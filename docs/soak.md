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

尚未完成一次 24 小时运行。已有的最长运行在 Windows 与 WSL 上各约 40 分钟（156 轮与 152 轮），通过 STOP 正常收尾：没有失败，自有浏览器、租约和分配计数归零，临时 profile 已删除。这不足以说明长时间运行的稳定性。
