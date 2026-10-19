# 性能基准

`bun run bench:mcp` 运行 `benchmarks/mcp.ts`：原始 JSON 结果写 stdout，进度写 stderr。基准使用本地 fixture、全新临时 profile、显式 headless 和默认 sandbox，不访问外部站点。请在没有并行测试或其他高负载任务时运行；功能测试的耗时不能代替基准。

## 工作负载

- **传输**：Chrome Pipe 与 WebSocket 各冷启动 3 次；预热 10 次后测 100 次 `Browser.getVersion` 往返，报告 p50/p95/p99 与全部样本。
- **快照**：100 / 1000 / 10000 个按钮的页面，AX 预热一次后各快照 7 次。输出 limit 固定 200，分别记录完整 CDP AX 响应的节点数与 JSON 字节、实际返回的 JSON 字节和端到端耗时。插桩的 JSON 解析开销计入结果，字节数不含传输分隔符与帧头。
- **并发 context**：1 / 5 / 20 个独立 context 经官方 InMemory MCP 执行 fill → click → snapshot 并校验文字。每进程最多 4 个 context，基准池上限提高到 5 个进程、20 个租约；预先创建引用、预热一轮后默认测量 5 轮，保留浏览器级串行锁。报告任务分布、吞吐、错误、控制器与 Chrome 的 CPU 和内存，以及全部释放后的池状态。

环境变量 `BENCH_SAMPLES`、`BENCH_ROUNDS`、`BENCH_NODES`、`BENCH_LEASES` 调整样本数和逗号分隔的规模。输出包含 Bun、Chrome、操作系统、CPU、内存与方法说明；任务出错、池未释放或发送了默认禁止的命令都会使脚本失败。

## 指标口径

- **控制器内存**：`process.memoryUsage()`。
- **Chrome 内存**：CDP `SystemInfo.getProcessInfo` 列出的进程 RSS 之和（Linux 读 `/proc/PID/status` 的 VmRSS，Windows 读 WorkingSet64）。共享页会被重复计算，不含未列出的 crash handler，不等于 PSS 或峰值。采样前已退出的进程记为 missing，不当作零。
- **CPU**：控制器和该 Chrome 进程集合的累计 CPU 时间差；期间退出的进程可能未计入。
- **尾延迟**：低样本量下 p99 接近最大样本，不代表稳定尾延迟。

端点采样只描述有限工作负载下的状态，不能证明不存在内存泄漏。

## 基线结果

Ryzen 5 5600X，Bun 1.4.3；Windows 使用 Chrome 155.0.8059.80，WSL2 Ubuntu 26.04（12 个逻辑 CPU、约 7.72 GiB 内存）使用 Chrome for Testing 155.0.8059.79。两个平台顺序运行。表中为单次运行的中位数，不能外推到其他机器，也不能归因于某一语言或传输实现。

| 指标                     | Windows Pipe | Windows WS | WSL Pipe | WSL WS |
| ------------------------ | -----------: | ---------: | -------: | -----: |
| 冷启动，3 次，ms         |          307 |        301 |      228 |    195 |
| 预热后 RTT，100 次，ms   |        0.132 |      0.208 |    0.175 |  0.327 |
| 100 按钮快照，7 次，ms   |          9.0 |        9.9 |     12.3 |   11.1 |
| 1000 按钮快照，7 次，ms  |         58.7 |       61.5 |     79.1 |   77.5 |
| 10000 按钮快照，7 次，ms |        523.9 |      571.1 |    724.5 |  832.4 |

10000 按钮页面的 AX 响应约 13.61 MB、30012 个节点，最终 200 节点的快照约 23 KB。截断输出不减少读取完整 AX 树的成本。

| context 数（进程数） | Windows 任务 p50 / p95，ms | Windows 任务/秒 | WSL 任务 p50 / p95，ms | WSL 任务/秒 |
| -------------------- | -------------------------: | --------------: | ---------------------: | ----------: |
| 1（1）               |                40.9 / 41.7 |            24.4 |            46.1 / 62.3 |        19.5 |
| 5（2）               |              165.9 / 177.0 |            29.5 |          183.8 / 195.0 |        26.7 |
| 20（5）              |              208.6 / 268.0 |            87.9 |          203.7 / 216.9 |        96.0 |

三档分别完成 5 / 25 / 100 个任务，错误为 0；释放后租约、浏览器和分配数均为 0。运行中 Chrome 进程 RSS 之和：Windows 约 0.67 / 1.81 / 5.90 GiB，WSL 约 1.36 / 3.96 / 13.15 GiB（最后一项超过 WSL 内存额度，说明 RSS 求和重复计算了共享页，不代表物理占用）。控制器结束时 RSS 约 80–102 MiB。

## 与 Python nodriver 对照

`bun run bench:compare` 运行 `benchmarks/compare.ts`：同一台机器、同一个 Chrome、headless、WebSocket、全新临时 profile 和同一个本地 fixture，两侧执行相同的工作负载。Python 侧通过 `uv` 以隔离模式运行 nodriver 0.50.6（Python 3.12，websockets 17.2），脚本位于 `benchmarks/compare/nodriver_bench.py`。默认先运行 TypeScript，`BENCH_PYTHON_FIRST=1` 时先运行 Python；`BENCH_SAMPLES` 调整往返样本数（默认 200）。

- **冷启动**：启动浏览器并打开空白页，各 5 次。headless 启动默认用探测页去除 UA 中的 HeadlessChrome，nodriver 不做这一步，因此另测 `maskHeadless: false` 作为对等口径。
- **往返**：预热 20 次后测 200 次 `Browser.getVersion` 与 200 次 `evaluate("1+1")`。
- **查询**：1000 个按钮的页面上 100 次 `#b500`（nodriver 为 `tab.select`，本项目为 `tab.query`）。
- **导航**：20 次同源导航到新 URL。本项目 `goto` 等待 load 事件；nodriver 的 `get` 在 load 前返回，脚本以 5 ms 间隔轮询 `document.readyState` 至 complete。
- **AX 树**：10000 个按钮的页面上 5 次 `Accessibility.getFullAXTree`（30003 个节点），含响应解析。
- **内存**：运行结束时控制器进程的 RSS。两种运行时的内存模型不同，只作参考。

Ryzen 5 5600X、Windows 11、Chrome 155.0.8059.80、Bun 1.4.3，两种顺序各运行一次，表中为中位数 / p95（ms）：

| 指标                 | nodriver-ts，TS 先行 | nodriver-ts，Python 先行 | nodriver，TS 先行 | nodriver，Python 先行 |
| -------------------- | -------------------: | -----------------------: | ----------------: | --------------------: |
| 冷启动（默认）       |        473.9 / 499.4 |            496.6 / 522.1 |     320.5 / 337.6 |         320.0 / 345.0 |
| 冷启动（不处理 UA）  |        372.3 / 516.1 |            343.6 / 373.5 |                 — |                     — |
| `Browser.getVersion` |          0.15 / 0.35 |              0.16 / 0.42 |       0.22 / 0.29 |           0.23 / 0.30 |
| `evaluate("1+1")`    |          0.24 / 0.32 |              0.24 / 0.30 |       0.31 / 0.57 |           0.33 / 0.70 |
| CSS 查询             |          1.02 / 1.55 |              0.98 / 1.39 |     19.55 / 47.49 |         19.36 / 46.23 |
| 导航                 |        11.14 / 13.25 |            10.60 / 11.92 |     17.16 / 21.55 |         12.29 / 13.83 |
| AX 树，30003 节点    |        568.7 / 639.9 |            566.7 / 681.5 |   1362.1 / 1549.9 |       1379.9 / 1557.1 |
| 控制器 RSS，MiB      |                  135 |                      171 |               496 |                   496 |

单次运行，结果只描述此工作负载在此机器上的表现。查询差异来自实现方式不同（nodriver 的 `select` 每次以 `DOM.getDocument(depth=-1, pierce=true)` 取回完整 DOM 树，再在 Python 中递归查找节点），不代表 CDP 通信本身的差距；导航一项两侧的完成判定方式不同。

## 未覆盖

- 大页面高频查询的长期成本和多日资源曲线（长稳运行见 [长稳测试](soak.md)）。
- 任何内存下降或吞吐提升比例的结论。
