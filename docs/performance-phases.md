# AX and queue measurements

[简体中文](zh-CN/performance-phases.md) · [Benchmark method](performance.md)

`npm run bench:mcp` on Windows x64 / Ryzen 5 5600X / Chrome 155 / Node.js 24.22.0, headless; 7 AX samples and 5 pool rounds after warmup. The fixture adds a named section with a deeply nested button.

| Transport | Buttons | AX bytes | Output bytes | Total p50 / p95 ms | Send→receive p50 ms | Dispatch p50 ms | After dispatch p50 ms |
| --------- | ------: | -------: | -----------: | -----------------: | ------------------: | --------------: | --------------------: |
| Pipe      |     100 |   142283 |         8881 |        6.75 / 7.85 |                4.89 |            0.67 |                  0.48 |
| Pipe      |    1000 |  1355663 |        16089 |      63.47 / 67.31 |               48.11 |            5.91 |                  1.93 |
| Pipe      |   10000 | 13612812 |        16093 |    644.27 / 701.30 |              480.11 |           61.84 |                 15.21 |
| WebSocket |     100 |   142290 |         8881 |        7.69 / 8.35 |                5.77 |            0.67 |                  0.36 |
| WebSocket |    1000 |  1355667 |        16089 |      81.56 / 87.92 |               65.15 |            5.98 |                  1.56 |
| WebSocket |   10000 | 13612816 |        16093 |    750.26 / 848.28 |              554.86 |           92.10 |                 17.67 |

These are controller observations. Send→receive combines Chrome calculation/serialization, transport, OS scheduling and decoding before the string callback. Dispatch combines the connection's JSON parse, validation and delivery. After dispatch combines local filtering/ref conversion, microtasks and ancillary DOM requests, including password protection; it is not pure CPU conversion time. The observer's extra JSON parse and byte count cost a median 64.44 ms (Pipe) / 86.64 ms (WebSocket) at 10000 buttons, included in total but separate from dispatch. Byte counts exclude framing. Marginal medians need not add to the median total. Chrome-internal calculation and transport/serialization cannot be separated here.

Alternatives on the 10000-button Pipe fixture:

| Request               |     ms |      Bytes | Complete                     |
| --------------------- | -----: | ---------: | ---------------------------- |
| Full AX tree          | 645.82 | 13,612,812 | Yes                          |
| Depth 1               | 356.03 |  7,137,890 | No, misses the nested button |
| Depth 2               | 523.07 | 11,011,057 | No, misses the nested button |
| Partial AX (6 nodes)  |   3.29 |     75,200 | No                           |
| Unfiltered root query |   7.22 |      3,619 | On this simple page only     |

A rooted `browser_snapshot` still reads the full tree and then returns only the semantic nodes under the root.

`npm run bench:ax-subtree` tries root queries across four frames and a closed shadow host. Main-frame and same-process roots match the full-tree result, but cross-process and nested-frame queries do not return in time on either transport, so root queries cannot replace full reads in general. Snapshots therefore keep full reads with root/frame validation, ref lifetimes and paging, and never present a partial result as complete. Lazy child expansion would require `Accessibility.enable`.

| Workload | Contexts | Processes | Task p50 / p95 ms | Tasks/s | Browser queue p50 / p95 ms |
| -------- | -------: | --------: | ----------------: | ------: | -------------------------: |
| Reads    |        1 |         1 |       1.44 / 2.08 |  650.46 |              0.003 / 0.004 |
| Reads    |        5 |         2 |       2.80 / 5.03 | 1003.18 |                1.06 / 3.44 |
| Reads    |       20 |         5 |     18.63 / 29.86 |  749.19 |               9.51 / 22.89 |
| Mixed    |        1 |         1 |   308.99 / 310.02 |    3.23 |              0.001 / 0.002 |
| Mixed    |        5 |         2 | 1249.57 / 1264.41 |    3.98 |             10.85 / 930.76 |
| Mixed    |       20 |         5 | 1265.59 / 1289.18 |   15.68 |             23.83 / 936.76 |

Reads are snapshot-only; mixed is fill→click→snapshot with verified text. Different processes overlap. Browser queue wait is per operation; task latency covers the whole workload and MCP dispatch. Session queue p50 is below 0.01 ms. The high mixed queue tails come from serializing focus and input, which is intentional: operations in one lease, including snapshots and ref resolution, stay serialized, and `readOnlyHint` does not change scheduling.

The benchmarks print every sample as JSON; run them on the target platform before comparing changes. AX memory behavior is described in the [soak test](soak.md).
