// CI-only preload (`node --import`) that records how each owned browser closes, to find why one
// sometimes outlives close() on Windows. Set NODRIVER_CLOSE_DIAGNOSTICS to a directory; every
// process that loads this module writes one JSON line per close to close-<pid>.jsonl there.
// When the browser outlives close(), the line also holds a snapshot of its process tree, Windows
// Error Reporting and Defender state, and how long the process took to exit after all.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type { Browser } from '../src/browser/browser.ts';
import type { BrowserProcess } from '../src/browser/launcher.ts';

const directory = process.env.NODRIVER_CLOSE_DIAGNOSTICS;
if (directory) await install(directory);

interface Timeline {
  pid?: number;
  /** The supervision helper's own exit is recorded instead of Chrome's. */
  supervised: boolean;
  executable?: string;
  test: string;
  startedAt: string;
  /** Milliseconds since `startedAt` for each step, in the order the steps happened. */
  steps: { at: number; step: string; [detail: string]: unknown }[];
  /** `direct`: closed without Browser.close() first, as some tests do. */
  outcome?: 'graceful' | 'forced' | 'direct' | 'failed';
  error?: string;
  /** For a browser that outlived close(): how long after the failure it exited, if it did. */
  exitAfterFailureMs?: number | null;
  snapshots?: unknown[];
}

async function install(directory: string): Promise<void> {
  const launcher = await import('../src/browser/launcher.ts');
  const browser = await import('../src/browser/browser.ts');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `close-${process.pid}.jsonl`);
  const timelines = new WeakMap<object, Timeline>();
  const origin = new WeakMap<Timeline, number>();
  const killers = new Map<
    string,
    { at: number; took?: number; code?: number | null; signal?: string | null }[]
  >();

  // Only a process that Chrome really runs in; unit tests also close stand-ins without one.
  const timeline = (owner: BrowserProcess): Timeline | undefined => {
    let entry = timelines.get(owner);
    if (entry || typeof owner.child?.once !== 'function') return entry;
    entry = {
      pid: owner.pid,
      supervised: owner.pid !== owner.child.pid,
      executable: process.env.CHROME_PATH,
      test: process.argv[1] ?? '',
      startedAt: new Date().toISOString(),
      steps: [],
    };
    timelines.set(owner, entry);
    origin.set(entry, performance.now());
    const record = entry;
    owner.child.once('exit', (code, signal) => step(record, 'exit', { code, signal }));
    return entry;
  };
  const step = (entry: Timeline | undefined, name: string, detail: Record<string, unknown> = {}) =>
    entry?.steps.push({
      at: Math.round(performance.now() - origin.get(entry)!),
      step: name,
      ...detail,
    });

  const browserClose = browser.Browser.prototype.close;
  browser.Browser.prototype.close = function (this: Browser) {
    if (this.process && !this.process.released) step(timeline(this.process), 'browser.close');
    return browserClose.call(this);
  };
  const waitForExit = launcher.BrowserProcess.prototype.waitForExit;
  launcher.BrowserProcess.prototype.waitForExit = async function (
    this: BrowserProcess,
    ms: number,
  ) {
    const entry = timeline(this);
    step(entry, 'waitForExit', { ms });
    const exited = await waitForExit.call(this, ms);
    step(entry, 'waited', { ms, exited });
    return exited;
  };
  const processClose = launcher.BrowserProcess.prototype.close;
  launcher.BrowserProcess.prototype.close = function (this: BrowserProcess) {
    // Closing a released browser only disconnects.
    const entry = this.released ? undefined : timeline(this);
    if (!entry) return processClose.call(this);
    step(entry, 'process.close');
    return processClose.call(this).then(
      () => {
        step(entry, 'closed');
        attachKillers(entry);
        // Graceful when Chrome left on its own within the wait that follows Browser.close.
        const waited = entry.steps.find((s) => s.step === 'waited');
        entry.outcome = !waited ? 'direct' : waited.exited ? 'graceful' : 'forced';
        write(entry);
      },
      async (error: unknown) => {
        step(entry, 'close failed');
        entry.outcome = 'failed';
        entry.error = String(error);
        attachKillers(entry);
        entry.snapshots = [await snapshot(entry)];
        // The test sees the failure now; the exit is watched in the background.
        void watchExit(this, entry);
        throw error;
      },
    );
  };
  const attachKillers = (entry: Timeline) => {
    for (const kill of killers.get(String(entry.pid)) ?? [])
      entry.steps.push({ step: 'taskkill', ...kill, at: Math.round(kill.at - origin.get(entry)!) });
    entry.steps.sort((a, b) => a.at - b.at);
  };
  const watchExit = async (owner: BrowserProcess, entry: Timeline) => {
    const failed = performance.now();
    const exited = await owner.waitForExit(120_000);
    entry.exitAfterFailureMs = exited ? Math.round(performance.now() - failed) : null;
    if (!exited) entry.snapshots!.push(await snapshot(entry));
    write(entry);
  };
  const write = (entry: Timeline) => {
    try {
      appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (error) {
      process.stderr.write(`close diagnostics: could not write ${file}: ${String(error)}\n`);
    }
    if (entry.outcome === 'failed')
      process.stderr.write(
        `close diagnostics: PID ${entry.pid} outlived close(); exited ${entry.exitAfterFailureMs ?? 'not within 120000'} ms later. See ${file}\n`,
      );
  };

  // The launcher imports spawn from node:child_process; the builtin's ESM bindings follow this.
  const childProcess = createRequire(import.meta.url)(
    'node:child_process',
  ) as typeof import('node:child_process');
  const spawn = childProcess.spawn;
  childProcess.spawn = function (this: unknown, ...args: unknown[]) {
    const child = (spawn as (...a: unknown[]) => import('node:child_process').ChildProcess).apply(
      this,
      args,
    );
    const [command, argv] = args as [string, string[]];
    if (command === 'taskkill') {
      const pid = argv[argv.indexOf('/pid') + 1]!;
      const kill: { at: number; took?: number; code?: number | null; signal?: string | null } = {
        at: performance.now(),
      };
      killers.set(pid, [...(killers.get(pid) ?? []), kill]);
      child.once('close', (code, signal) => {
        kill.took = Math.round(performance.now() - kill.at);
        kill.code = code;
        kill.signal = signal;
      });
    }
    return child;
  } as typeof spawn;
  syncBuiltinESMExports();
}

/** The browser's process tree and the system state that can hold a terminated process. */
function snapshot(entry: Timeline): Promise<unknown> {
  const at = new Date().toISOString();
  if (process.platform !== 'win32')
    return run('ps', ['-A', '-o', 'pid,ppid,pgid,stat,etime,wchan,comm']).then((ps) => ({
      at,
      ps: ps
        .split('\n')
        .filter((line, i) => i === 0 || line.includes(String(entry.pid)))
        .join('\n'),
    }));
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$p = ${Number(entry.pid)}; $since = [DateTime]::Parse('${entry.startedAt}').AddMinutes(-1)
$all = @(Get-CimInstance Win32_Process)
$tree = @($p)
do { $n = $tree.Count; $tree += @($all | Where-Object { $tree -contains $_.ParentProcessId -and $tree -notcontains $_.ProcessId } | ForEach-Object ProcessId) } while ($tree.Count -ne $n)
$processes = @($all | Where-Object { $tree -contains $_.ProcessId -or $_.Name -match '^(WerFault|WerFaultSecure|taskkill|MsMpEng)\\.exe$' } | ForEach-Object {
  $threads = (Get-Process -Id $_.ProcessId).Threads
  [pscustomobject]@{
    pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; created = $_.CreationDate
    handles = $_.HandleCount; threads = $_.ThreadCount; workingSet = $_.WorkingSetSize
    waits = (@($threads | Group-Object { "$($_.ThreadState)/$($_.WaitReason)" } | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' ')
    command = if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(240, $_.CommandLine.Length)) }
  }
})
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -MaxEvents 200 | Where-Object { $_.ProviderName -match 'Error|Hang|Windows Error Reporting' } | Select-Object -First 20 | ForEach-Object {
  [pscustomobject]@{ time = $_.TimeCreated; provider = $_.ProviderName; id = $_.Id; message = $_.Message.Substring(0, [Math]::Min(600, $_.Message.Length)) }
})
$reports = @(Get-ChildItem 'C:\\ProgramData\\Microsoft\\Windows\\WER' -Recurse -Filter Report.wer | Where-Object { $_.LastWriteTime -gt $since } | ForEach-Object FullName)
$defender = Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled, BehaviorMonitorEnabled, IoavProtectionEnabled, OnAccessProtectionEnabled
$detections = @(Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -gt $since } | Select-Object InitialDetectionTime, ThreatID, Resources)
[pscustomobject]@{ alive = [bool]($all | Where-Object ProcessId -eq $p); processes = $processes; events = $events; reports = $reports; defender = $defender; detections = $detections } | ConvertTo-Json -Depth 4 -Compress
`;
  return run('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]).then((output) => {
    try {
      return { at, ...(JSON.parse(output) as object) };
    } catch {
      return { at, output: output.slice(0, 4000) };
    }
  });
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => resolve(stdout || `${String(error ?? '')} ${stderr}`.trim()),
    );
  });
}
