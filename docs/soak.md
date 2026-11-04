# Soak test

[简体中文](zh-CN/soak.md)

```sh
npm run test:soak -- --hours 24 --output dev/soak-my-run
```

The task runs in the foreground, one cycle every 15 s by default, using two independent temporary Chromes: local Streamable HTTP + Chrome Pipe, and local socket + Chrome WebSocket. The browsers, HTTP fixture and protocol services are all local; HTTP listens only on loopback, and no external sites are contacted.

## Checks in each cycle

- MCP text input read back from the page, a real click counter that increases by exactly one, an AX snapshot, refs, and the event buffer limit.
- Create a second, isolated lease, load four frames, and verify cookie isolation, handle invalidation after navigation and context closing.
- Wait for tabs, contexts, sessions, listeners and pending requests to return to their baseline.

The main lease and browser stay alive for the whole run; processes are not restarted each cycle to hide resource growth. `Runtime.enable/disable/addBinding`, `Console.enable`, `Debugger.enable` and automatic init scripts are forbidden by default: such a command is refused before it reaches Chrome and fails the run. Real CDP command counts are recorded.

Every minute the test samples controller RSS/heap/CPU, Chrome process RSS/CPU, Windows handles or Linux fds, the target page's JS heap/DOM, ref counts and internal resource counts. RSS counts shared pages more than once, so judging a leak takes the curve over time and the resource baselines, not a single sample.

## Output and control

The output directory must not already contain `status.json`, so earlier results are never overwritten. The directory contains:

- `status.json`: state, PID, start and planned end times (ISO UTC), cycle count, cycle interval, largest heartbeat gap, CDP command counts, source hashes and, per mode, the browser's PID, profile and pool counts. Each update replaces the file atomically, so a reader never sees a partial file.
- `samples.jsonl`: per-minute memory, CPU and resource samples.
- `STOP`: once this file is created, the task stops after the current cycle. SIGINT and SIGTERM do the same.

```powershell
New-Item -ItemType File -Path '<output directory>\STOP'   # Windows
```

```sh
touch <output directory>/STOP                            # Linux / WSL
```

Per-cycle progress goes to stdout; redirect it to a file such as `stdout.log` when starting in the background. Every run, however it ends, closes its browsers and leases and verifies that the temporary profiles were deleted.

`status` is one of starting, running, completed, completed-cycles, stopped or failed. Only a run that reaches the planned duration, sends no forbidden command and passes the cleanup checks is marked completed. `--cycles 5 --interval-ms 50` is a quick self-check; its result, completed-cycles, does not count as a soak pass. The host must stay awake: a heartbeat gap longer than two minutes or three intervals, whichever is greater, fails the run and cleans up, so time spent asleep never counts as run time. A browser disconnect or an operation error also fails the run; there is no automatic restart or input replay.

## Results

A full 24-hour run on Windows 11 x64 (Ryzen 5 5600X), Node.js 24.22.0 and Chrome 155 completed with:

- Each mode completed 5342 cycles with no failures or retries. The largest heartbeat gap was 21.6 s, and the host never slept.
- Each transport sent 586,355 CDP commands, with 0 default-forbidden commands.
- At the end of every cycle, tabs, contexts, sessions, listeners and pending requests were back at their baseline (2 / 3 / 4 / 32 / 0), and the number of retained refs stayed at 22.
- The hourly median of controller RSS stayed between 110 and 119 MiB, and the JS heap between 34 and 40 MiB, with no upward trend. 10 samples showed transient peaks of up to 191 MiB, which then fell back.
- The total working set of Chrome processes went from about 1.45 GiB down to about 0.94 GiB. The total handle count across all processes went from 8845 to 8899 (medians of the first and last hour), and the process count stayed at 19.
- At the end both browsers were closed, the lease, browser and allocation counts were zero, and the temporary profiles were deleted.

The main tab's V8 JS heap and DOM counts stayed flat; two values from `Runtime.getHeapUsage` grew linearly with the cycle count. A 600-cycle run (`--cycles 600 --interval-ms 50`) shows the same per-cycle increase, so the growth depends on the number of operations, not on time:

- **backingStorageSize** (external strings and ArrayBuffers) grew by about 0.1 MiB over 24 hours. The cause is the test fixture: its page script appends the value of every input event to `globalThis.inputs` and never clears it, so each cycle adds that cycle's text length. Clearing the array and forcing a garbage collection returns it to the initial value.
- **embedderHeapUsedSize** (the Blink heap) rose from a post-GC low of about 1.3 MiB to about 7 MiB, roughly 1 KB per cycle. This is memory Chrome retains when text edits and AX tree reads alternate in one document; it does not pass through the library and is not in any resource the library holds. Raw CDP alone reproduces it: repeating "focus and select all in an input + `Input.insertText` + `Accessibility.getFullAXTree`" on the same page adds about 1.2 MiB per 2000 iterations after forced GC. Without the AX snapshot, or with a script assignment instead of the insert, the increase is small and bounded; repeated snapshots without DOM changes do not grow; `Accessibility.disable` does not release it. You will see the same growth if you stay on one page for a long time, typing repeatedly and calling `browser_snapshot`; navigating or reloading the page releases all of it.
