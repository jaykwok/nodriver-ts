# Performance benchmarks

[简体中文](zh-CN/performance.md)

The [2026-10-21 phased AX and queue results](performance-phases.md) include measured alternatives and the reasons full-tree reads and serialization are retained. The benchmark now records raw AX alternatives, observer/dispatch/after-dispatch costs, and snapshot-only versus mixed queue waits.

`npm run bench:mcp` runs `benchmarks/mcp.ts`: raw JSON results go to stdout and progress to stderr. The benchmark uses local fixtures, a fresh temporary profile, explicit headless mode and the default sandbox, and never contacts external sites. Run it when no tests or other heavy workloads are running in parallel; timings from functional tests are no substitute for the benchmark.

## Workloads

- **Transport**: 3 cold launches each for Chrome Pipe and WebSocket; after 10 warm-up runs, 100 `Browser.getVersion` round trips, reporting p50/p95/p99 and all samples.
- **Snapshots**: pages with 100 / 1000 / 10000 buttons; after one AX warm-up, 7 snapshots each. The output limit is fixed at 200. It records the node count and JSON bytes of the full CDP AX response, the JSON bytes actually returned and the end-to-end time. The instrumentation's JSON parsing cost is included in the results, and byte counts exclude transport delimiters and frame headers.
- **Concurrent contexts**: 1 / 5 / 20 independent contexts run fill → click → snapshot through the official InMemory MCP and check the text. Each process holds at most 4 contexts, and the benchmark pool limit is raised to 5 processes and 20 leases. Refs are created in advance; after one warm-up round, 5 rounds are measured by default, with the browser-level serial lock kept. It reports the task distribution, throughput, errors, controller and Chrome CPU and memory, and the pool state after everything is released.

The environment variables `BENCH_SAMPLES`, `BENCH_ROUNDS`, `BENCH_NODES` and `BENCH_LEASES` adjust the sample count and the comma-separated sizes. The output includes the runtime, Chrome, OS, CPU, memory and a description of the method. A failed task, an unreleased pool or a default-forbidden command makes the script fail.

## Metrics

- **Controller memory**: `process.memoryUsage()`.
- **Chrome memory**: the sum of RSS for the processes listed by CDP `SystemInfo.getProcessInfo` (VmRSS from `/proc/PID/status` on Linux, WorkingSet64 on Windows). Shared pages are counted more than once, unlisted crash handlers are excluded, and this is neither PSS nor a peak. Processes that exited before sampling are recorded as missing, not as zero.
- **CPU**: the difference in cumulative CPU time for the controller and that set of Chrome processes; processes that exit in the meantime may not be counted.
- **Tail latency**: with few samples, p99 is close to the largest sample and does not represent a stable tail latency.

Endpoint sampling only describes the state under a limited workload; it cannot prove the absence of memory leaks.

Historical MCP baselines are in the [0.2.0 release documentation](https://github.com/jaykwok/nodriver-ts/blob/v0.2.0/docs/performance.md#基线结果) (Chinese).

## Comparison with Python nodriver

`npm run bench:compare` runs `benchmarks/compare.ts`: the same machine, the same Chrome, headless, WebSocket, a fresh temporary profile and the same local fixture, with both sides running the same workload. The Python side runs nodriver 0.50.6 in isolated mode through `uv` (Python 3.12, websockets 17.2); its script is `benchmarks/compare/nodriver_bench.py`. TypeScript runs first by default, and Python first with `BENCH_PYTHON_FIRST=1`. `BENCH_SAMPLES` adjusts the number of round-trip samples (200 by default).

- **Cold launch**: launch the browser and open a blank page, 5 times each. This historical run used the previous default UA masking probe, which nodriver does not perform, so `maskHeadless: false` was measured separately. Masking is now opt-in; these historical cold-launch numbers do not describe the current default.
- **Round trips**: after 20 warm-up runs, 200 `Browser.getVersion` and 200 `evaluate("1+1")` calls.
- **Query**: 100 lookups of `#b500` on a page with 1000 buttons (`tab.select` in nodriver, `tab.query` in this project).
- **Navigation**: 20 same-origin navigations to new URLs. This project's `goto` waits for the load event; nodriver's `get` returns before load, so the script polls `document.readyState` every 5 ms until it is complete.
- **AX tree**: 5 `Accessibility.getFullAXTree` calls (30003 nodes) on a page with 10000 buttons, including response parsing.
- **Memory**: the controller process's RSS at the end of the run. Memory models differ between runtimes, so this is for reference only.

Ryzen 5 5600X, Windows 11, Chrome 155.0.8059.80, nodriver-ts on Node.js 24.22.0, one run in each order; the table shows median / p95 (ms):

| Metric                     | nodriver-ts, TS first | nodriver-ts, Python first | nodriver, TS first | nodriver, Python first |
| -------------------------- | --------------------: | ------------------------: | -----------------: | ---------------------: |
| Cold launch (default)      |        577.3 / 1033.6 |             442.0 / 539.1 |      374.4 / 801.6 |          342.7 / 354.3 |
| Cold launch (UA untouched) |         333.6 / 347.9 |             329.3 / 333.5 |                  — |                      — |
| `Browser.getVersion`       |           0.18 / 0.44 |               0.18 / 0.39 |        0.24 / 0.34 |            0.29 / 0.41 |
| `evaluate("1+1")`          |           0.24 / 0.31 |               0.24 / 0.33 |        0.34 / 0.61 |            0.34 / 0.73 |
| CSS query                  |           1.01 / 1.46 |               1.04 / 1.38 |      19.93 / 48.76 |          20.34 / 50.78 |
| Navigation                 |         11.22 / 15.56 |             11.05 / 11.73 |      12.69 / 14.59 |          12.68 / 14.68 |
| AX tree, 30003 nodes       |         627.3 / 652.0 |             603.7 / 696.1 |    1401.0 / 1604.3 |        1418.4 / 1541.5 |
| Controller RSS, MiB        |                   241 |                       206 |                494 |                    495 |

These are single runs and describe only this workload on this machine. With 5 cold launches, p95 is the largest sample and is affected by occasional slow launches. The query difference comes from different implementations (nodriver's `select` fetches the full DOM tree with `DOM.getDocument(depth=-1, pierce=true)` every time and then searches the nodes recursively in Python); it does not reflect a difference in CDP communication itself. For navigation, the two sides decide completion differently.

## Not covered

- The long-term cost of high-frequency queries on large pages, and resource curves over several days (for long runs see the [soak test](soak.md)).
- Any conclusion about percentages of memory reduction or throughput gains.
