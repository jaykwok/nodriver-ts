# Soak test

[简体中文](zh-CN/soak.md)

```sh
npm run test:soak -- --hours 24 --output dev/soak-my-run
```

The task runs in the foreground, one cycle every 15 s by default, using two independent temporary Chromes: local Streamable HTTP + Chrome Pipe, and local socket + Chrome WebSocket. The browsers, HTTP fixture and protocol services are all local; HTTP listens only on loopback, and no external sites are contacted.

## Checks in each cycle

- MCP Chinese text input, a real click counter that increases by exactly one, an AX snapshot, refs, and the event buffer limit.
- Create a second, isolated lease, load four frames, and verify cookie isolation, handle invalidation after navigation and context closing.
- Wait for tabs, contexts, sessions, listeners and pending requests to return to their baseline.

The main lease and browser stay alive for the whole run; processes are not restarted each cycle to hide resource growth. By default `Runtime.enable/disable/addBinding`, `Console.enable`, `Debugger.enable` and automatic init scripts are forbidden, and real CDP command counts are recorded.

Every minute the test samples controller RSS/heap/CPU, Chrome process RSS/CPU, Windows handles or Linux fds, the target page's JS heap/DOM, ref counts and internal resource counts. RSS counts shared pages more than once; judging a leak needs the curve over time and the resource baselines, and no single sample says anything on its own.

## Output and control

The output directory must not already contain `status.json`, so earlier results are never overwritten. The directory contains:

- `status.json`: state, PID, start and expected end times (ISO UTC), cycle count, heartbeat interval, source hash and resource ownership.
- `samples.jsonl`: per-minute memory, CPU and resource samples.
- `stdout.log`: per-cycle progress, saved when started in the background.
- `STOP`: once this file is created, the task stops at the end of the current cycle, closes every owned browser and lease, and verifies that the temporary profiles were deleted.

```powershell
New-Item -ItemType File -Path '<output directory>\STOP'   # Windows
```

```sh
touch <output directory>/STOP                            # Linux / WSL
```

`status` is one of starting, running, completed, completed-cycles, stopped or failed. Only a run that reaches the planned duration and passes the cleanup checks is marked completed. `--cycles 5 --interval-ms 50` is for a quick self-check; its result is completed-cycles, which does not count as a soak pass. The task relies on the host staying awake: a heartbeat gap longer than two minutes or three intervals is recorded as a failure and cleaned up, so time spent asleep is never counted as run time. A browser disconnect or an operation error also fails the run; there is no automatic restart or input replay.

## Current results

Windows 11 x64 (Ryzen 5 5600X), Node.js 24.22.0, Chrome 155.0.8059.80. The run lasted the full 24 hours, from 2026-10-19 02:53 to 2026-10-20 02:53 (UTC), with status completed:

- Each mode completed 5342 cycles with no failures or retries. The largest heartbeat gap was 21.6 s, and the host never slept.
- Each transport sent 586,355 CDP commands, with 0 default-forbidden commands.
- At the end of every cycle, tabs, contexts, sessions, listeners and pending requests were back at their baseline (2 / 3 / 4 / 32 / 0), and the number of retained refs stayed at 22.
- The hourly median of controller RSS stayed between 110 and 119 MiB, and the JS heap between 34 and 40 MiB, with no upward trend. 10 samples showed transient peaks of up to 191 MiB, which then fell back.
- The total working set of Chrome processes went from about 1.45 GiB down to about 0.94 GiB. The total handle count across all processes went from 8845 to 8899 (medians of the first and last hour), and the process count stayed at 19.
- At the end both browsers were closed, the lease, browser and allocation counts were zero, and the temporary profiles were deleted.

The main tab's V8 JS heap and DOM counts stayed flat; two values from `Runtime.getHeapUsage` grew linearly with the cycle count. A quick 600-cycle run (`--cycles 600 --interval-ms 50`) showed the same per-cycle increase as the 24-hour run, which shows that the growth depends on the number of operations rather than on time:

- **backingStorageSize** (external strings and ArrayBuffers) grew by about 0.1 MiB over 24 hours. The cause is the test fixture: the page script appends the value of every input event to `globalThis.inputs` and never clears it, so each cycle adds that cycle's text length. Clearing the array and forcing a garbage collection returns it to the initial value.
- **embedderHeapUsedSize** (the Blink heap) rose from a post-GC low of about 1.3 MiB to about 7 MiB, roughly 1 KB per cycle. In an isolated reproduction using only raw CDP against the same page, repeating "focus and select all in an input + `Input.insertText` + `Accessibility.getFullAXTree`" also added about 1.2 MiB per 2000 iterations after forced GC. Without the AX snapshot, or with a script assignment instead, the increase was small and bounded; repeated snapshots without DOM changes did not grow; `Accessibility.disable` did not release it; navigating the page released all of it. This is memory Chrome retains when text edits and AX tree reads alternate in the same document. It does not pass through the library and is not in any resource the library holds. You will see the same growth if you stay on one page for a long time, typing repeatedly and calling `browser_snapshot`; navigating or reloading the page releases it.

These results come from one run on one host and do not represent other platforms or workloads.
