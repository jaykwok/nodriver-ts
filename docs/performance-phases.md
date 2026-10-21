# AX and queue measurements, 2026-10-21

[简体中文](zh-CN/performance-phases.md) · [Benchmark method](performance.md)

Windows x64 / Ryzen 5 5600X / Chrome 155.0.8059.85 / Node.js 24.22.0, headless with the then-default UA mask; 7 AX samples and 5 pool rounds after warmup. The fixture adds a named section with a deeply nested button.

| Transport | Buttons | AX bytes | Output bytes | Total p50 / p95 ms | Send→receive p50 ms | Dispatch p50 ms | After dispatch p50 ms |
| --------- | ------: | -------: | -----------: | -----------------: | ------------------: | --------------: | --------------------: |
| Pipe      |     100 |   142283 |         8881 |        6.75 / 7.85 |                4.89 |            0.67 |                  0.48 |
| Pipe      |    1000 |  1355663 |        16089 |      63.47 / 67.31 |               48.11 |            5.91 |                  1.93 |
| Pipe      |   10000 | 13612812 |        16093 |    644.27 / 701.30 |              480.11 |           61.84 |                 15.21 |
| WebSocket |     100 |   142290 |         8881 |        7.69 / 8.35 |                5.77 |            0.67 |                  0.36 |
| WebSocket |    1000 |  1355667 |        16089 |      81.56 / 87.92 |               65.15 |            5.98 |                  1.56 |
| WebSocket |   10000 | 13612816 |        16093 |    750.26 / 848.28 |              554.86 |           92.10 |                 17.67 |

These are controller observations. Send→receive combines Chrome calculation/serialization, transport, OS scheduling and decoding before the string callback. Dispatch combines the connection's JSON parse, validation and delivery. After dispatch combines local filtering/ref conversion, microtasks and ancillary DOM requests, including password protection; it is not pure CPU conversion time. The observer's extra JSON parse and byte count cost a median 64.44 ms (Pipe) / 86.64 ms (WebSocket) at 10000 buttons, included in total but separate from dispatch. Byte counts exclude framing. Marginal medians need not add to the median total. Chrome-internal calculation and transport/serialization cannot be separated here.

On the 10000-button Pipe fixture, raw full AX was 645.82 ms / 13,612,812 bytes; depth 1 was 356.03 ms / 7,137,890 bytes, depth 2 was 523.07 ms / 11,011,057 bytes. Both depth limits omitted the nested button. Partial AX was 3.29 ms / 75,200 bytes (6 nodes), also incomplete. An unfiltered root query was 7.22 ms / 3,619 bytes (8 nodes), retaining the nested button on that simple page. A production rooted snapshot returned 3 semantic nodes after reading the full 13.6 MB.

`npm run bench:ax-subtree` follows up across four frames and a closed shadow host. Main-frame and same-process roots matched the full-tree converter; cross-process and nested-frame queries exceeded the 1 s experiment deadline on both transports. Earlier differential runs timed out after 30 s. The experiment substitutes the command on the wire, so its connection errors still name the originally queued getFullAXTree. This does not mean every root query fails, but rules out a general replacement. Full reads, root/frame validation, generation/ref lifetimes and paging remain. No partial result is presented as complete. Lazy child expansion would require Accessibility.enable and a separate completeness/lifecycle contract.

| Workload | Contexts | Processes | Task p50 / p95 ms | Tasks/s | Browser queue p50 / p95 ms |
| -------- | -------: | --------: | ----------------: | ------: | -------------------------: |
| Reads    |        1 |         1 |       1.44 / 2.08 |  650.46 |              0.003 / 0.004 |
| Reads    |        5 |         2 |       2.80 / 5.03 | 1003.18 |                1.06 / 3.44 |
| Reads    |       20 |         5 |     18.63 / 29.86 |  749.19 |               9.51 / 22.89 |
| Mixed    |        1 |         1 |   308.99 / 310.02 |    3.23 |              0.001 / 0.002 |
| Mixed    |        5 |         2 | 1249.57 / 1264.41 |    3.98 |             10.85 / 930.76 |
| Mixed    |       20 |         5 | 1265.59 / 1289.18 |   15.68 |             23.83 / 936.76 |

Reads are snapshot-only; mixed is fill→click→snapshot with verified text. Different processes overlap. Queue observation wraps existing queues only in the benchmark. Session queue p50 was below 0.01 ms. Browser queue wait is per operation; task latency covers the entire workload and MCP dispatch. All 260 measured tasks completed, with no errors, forbidden commands or remaining browsers after release. Small rounds and tiny read pages cannot establish production tails or an optimal pool size. High mixed queue tails include focus/input serialization. No concurrent candidate has adequate race coverage: locks remain, including for snapshots/refs; readOnlyHint does not change scheduling. The data do not establish a speedup from removing a lock.

All samples and raw alternatives are emitted by the benchmarks and retained locally in `test-results/`. Reproduce on the target platform before comparing changes. AX memory evidence is separately recorded in [soak results](soak.md). Calculation and memory costs do not establish a stable page-visible detection signal.
