import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { Browser } from '../src/index.ts';
import { BrowserSessionManager, createBrowserMcpServer } from '../src/mcp/server.ts';
import { BrowserMcpSession } from '../src/mcp/session.ts';
import { serve } from '../test/fixtures/serve.ts';

// Run explicitly; benchmarks are not correctness tests or performance promises.
const repeats = Number(process.env.BENCH_SAMPLES ?? 7);
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
const sizes = (process.env.BENCH_NODES ?? '100,1000,10000').split(',').map(Number);
const leaseCounts = (process.env.BENCH_LEASES ?? '1,5,20').split(',').map(Number);
for (const n of [repeats, rounds, ...sizes, ...leaseCounts])
  assert.ok(Number.isSafeInteger(n) && n > 0);
function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
  return {
    count: samples.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    samples,
  };
}
function result(reply: CallToolResult): Record<string, unknown> {
  assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
  return reply.structuredContent as Record<string, unknown>;
}
const fixture = await serve({
  hostname: '127.0.0.1',
  fetch(request) {
    const n = Number(new URL(request.url).searchParams.get('nodes') ?? 1);
    return new Response(
      '<!doctype html><meta charset="utf-8"><label>Name<input id="name" oninput="document.querySelector(\'#echo\').textContent=this.value"></label><p id="echo"></p><button id="click" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Click</button>' +
        Array.from({ length: n }, (_, i) => `<button>Item ${i} 中文</button>`).join(''),
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  },
});
const url = `http://127.0.0.1:${fixture.port}`;
const forbidden = new Set([
  'Runtime.enable',
  'Runtime.disable',
  'Runtime.addBinding',
  'Console.enable',
  'Debugger.enable',
  'Page.addScriptToEvaluateOnNewDocument',
]);
let forbiddenCount = 0;
function instrument(browser: Browser) {
  const wire = browser.connection.transport,
    send = wire.send.bind(wire),
    receive = wire.onmessage;
  const ax = new Set<number>();
  const messages: { bytes: number; nodes: number }[] = [];
  wire.send = (message) => {
    const parsed = JSON.parse(message) as { id: number; method: string };
    if (forbidden.has(parsed.method)) forbiddenCount++;
    if (parsed.method === 'Accessibility.getFullAXTree') ax.add(parsed.id);
    return send(message);
  };
  wire.onmessage = (message) => {
    const parsed = JSON.parse(message) as { id?: number; result?: { nodes?: unknown[] } };
    if (parsed.id !== undefined && ax.delete(parsed.id))
      messages.push({
        bytes: Buffer.byteLength(message),
        nodes: parsed.result?.nodes?.length ?? 0,
      });
    receive?.(message);
  };
  return messages;
}
async function memory(browsers: Browser[]) {
  const processes = new Map<number, number>();
  for (const browser of browsers) {
    const { processInfo } = await browser.cdp.send('SystemInfo.getProcessInfo');
    for (const p of processInfo) processes.set(p.id, p.cpuTime);
  }
  const ids = [...processes.keys()];
  let chromeRssBytes = 0;
  let sampled: number[] = [];
  if (process.platform === 'linux') {
    const rss = await Promise.all(
      ids.map(async (id) => {
        try {
          const value = /VmRSS:\s+(\d+)/.exec(await readFile(`/proc/${id}/status`, 'utf8'));
          if (value) sampled.push(id);
          return Number(value?.[1] ?? 0) * 1024;
        } catch {
          return 0;
        }
      }),
    );
    chromeRssBytes = rss.reduce((a, b) => a + b, 0);
  } else if (process.platform === 'win32' && ids.length) {
    // IDs are numeric protocol values, never user-provided shell text.
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$items=@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64); ConvertTo-Json -Compress -InputObject $items`,
      ],
      { windowsHide: true },
    );
    const rows = JSON.parse(stdout) as { Id: number; WorkingSet64: number }[];
    sampled = rows.map((p) => p.Id);
    chromeRssBytes = rows.reduce((n, p) => n + p.WorkingSet64, 0);
  }
  return {
    controller: process.memoryUsage(),
    chromeRssBytes,
    chromeReportedProcesses: ids.length,
    chromeSampledProcesses: sampled.length,
    chromeMissingProcesses: ids.filter((id) => !sampled.includes(id)),
    chromeCpuSeconds: [...processes.values()].reduce((a, b) => a + b, 0),
  };
}
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  runtime: process.versions.bun
    ? `Bun ${process.versions.bun}`
    : `Node.js ${process.versions.node}`,
  os: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemory: totalmem(),
  },
  config: { repeats, rounds, sizes, leaseCounts },
  methodology:
    'Local fixture; fresh profiles, default sandbox, explicit headless. Cold launch excludes close. RTT is Browser.getVersion. AX measures complete wire response separately from bounded snapshot output. Pool tasks use official InMemory MCP: fill, click, snapshot; pre-created refs, one warmup, browser-wide serialization retained. Memory is endpoint RSS, summed over CDP-reported Chrome processes (excludes crash handler; shared pages may be double-counted), not peak/PSS. CPU is controller plus CDP-reported Chrome process CPU during measured workload; exited process CPU may be absent. No Python comparison or multi-day soak.',
};
try {
  const transportResults: unknown[] = [];
  for (const transport of ['pipe', 'websocket'] as const) {
    console.error(`Benchmark ${transport}: cold launch, RTT and AX`);
    const cold: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const browser = await Browser.launch({ headless: true, transport });
      cold.push(performance.now() - start);
      await browser.close();
    }
    const session = new BrowserMcpSession({ launch: { headless: true, transport } });
    try {
      const browser = await session.getBrowser(new AbortController().signal);
      report.chrome = browser.version;
      const wire = instrument(browser),
        rtt: number[] = [];
      for (let i = 0; i < 10 + 100; i++) {
        const start = performance.now();
        await browser.cdp.send('Browser.getVersion');
        if (i >= 10) rtt.push(performance.now() - start);
      }
      const tab = await session.newTab(new AbortController().signal),
        snapshots: unknown[] = [];
      for (const nodes of sizes) {
        await tab.goto(`${url}?nodes=${nodes}`);
        await session.snapshot(tab.id, { limit: 200 }, {}); // warmup
        const durations: number[] = [],
          inbound: unknown[] = [],
          outputs: number[] = [];
        const before = await memory([browser]);
        for (let i = 0; i < repeats; i++) {
          const start = performance.now();
          const value = await session.snapshot(tab.id, { limit: 200 }, {});
          durations.push(performance.now() - start);
          inbound.push(wire.at(-1));
          outputs.push(Buffer.byteLength(JSON.stringify(value)));
          assert.ok(value.nodes.length <= 200);
          if (nodes >= 1000) assert.equal(value.truncated, true);
        }
        snapshots.push({
          buttons: nodes,
          limit: 200,
          elapsedMs: distribution(durations),
          axWire: inbound,
          outputBytes: distribution(outputs),
          memoryBefore: before,
          memoryAfter: await memory([browser]),
        });
      }
      transportResults.push({
        transport,
        coldLaunchMs: distribution(cold),
        warmRttMs: distribution(rtt),
        snapshots,
      });
    } finally {
      await session.dispose();
    }
  }
  report.transports = transportResults;
  const pools: unknown[] = [];
  for (const count of leaseCounts) {
    console.error(`Benchmark pool: ${count} contexts, ${rounds} measured rounds`);
    const manager = new BrowserSessionManager({
      launch: { headless: true, transport: 'pipe' },
      maxBrowsers: Math.ceil(count / 4),
      contextsPerBrowser: 4,
      maxLeases: count,
      queueLimit: 128,
      operationTimeout: 60000,
      browserIdleMs: 1,
    });
    const clients: Client[] = [];
    const leases: string[] = [];
    const browsers = new Set<Browser>();
    const records: { client: Client; tabId: unknown; input: string; button: string }[] = [];
    try {
      const setup = performance.now();
      for (let i = 0; i < count; i++) {
        const lease = manager.create('benchmark');
        leases.push(lease.id);
        const adapter = createBrowserMcpServer(
          {},
          { manager, principal: 'benchmark', leaseId: lease.id },
        );
        const client = new Client(
          { name: 'benchmark', version: '1' },
          { versionNegotiation: { mode: { pin: '2026-07-28' } } },
        );
        clients.push(client);
        const [a, b] = InMemoryTransport.createLinkedPair();
        await adapter.connect(b);
        await client.connect(a);
        const { tabId } = result(
          await client.callTool({ name: 'browser_open', arguments: { url } }),
        );
        const browser = await manager
          .session('benchmark', lease.id)
          .getBrowser(new AbortController().signal);
        if (!browsers.has(browser)) {
          browsers.add(browser);
          instrument(browser);
        }
        const find = async (selector: string) =>
          (
            result(await client.callTool({ name: 'browser_find', arguments: { tabId, selector } }))
              .elements as { ref: string }[]
          )[0]!.ref;
        records.push({ client, tabId, input: await find('#name'), button: await find('#click') });
      }
      const setupMs = performance.now() - setup;
      const latencies: number[] = [],
        errors: string[] = [];
      const task = async (round: number, measured: boolean) =>
        Promise.all(
          records.map(async (r, i) => {
            const text = `bench-${round}-${i}`,
              start = performance.now();
            try {
              result(
                await r.client.callTool({
                  name: 'browser_fill',
                  arguments: { tabId: r.tabId, ref: r.input, text },
                }),
              );
              result(
                await r.client.callTool({
                  name: 'browser_click',
                  arguments: { tabId: r.tabId, ref: r.button },
                }),
              );
              const snapshot = result(
                await r.client.callTool({
                  name: 'browser_snapshot',
                  arguments: { tabId: r.tabId },
                }),
              );
              assert.ok(JSON.stringify(snapshot).includes(text));
            } catch (error) {
              errors.push(String(error));
            } finally {
              if (measured) latencies.push(performance.now() - start);
            }
          }),
        );
      await task(-1, false);
      const before = await memory([...browsers]),
        cpu = process.cpuUsage(),
        start = performance.now();
      for (let round = 0; round < rounds; round++) await task(round, true);
      const elapsedMs = performance.now() - start,
        controllerCpu = process.cpuUsage(cpu),
        after = await memory([...browsers]);
      const stats = manager.stats();
      for (const client of clients) await client.close();
      for (const id of leases) await manager.release('benchmark', id);
      await sleep(5);
      await manager.sweep();
      pools.push({
        contexts: count,
        setupMs,
        stats,
        taskMs: distribution(latencies),
        elapsedMs,
        completed: count * rounds - errors.length,
        errors,
        tasksPerSecond: (count * rounds - errors.length) / (elapsedMs / 1000),
        controllerCpuSeconds: (controllerCpu.user + controllerCpu.system) / 1e6,
        chromeCpuSeconds: after.chromeCpuSeconds - before.chromeCpuSeconds,
        memoryBefore: before,
        memoryAfter: after,
        afterRelease: manager.stats(),
        controllerAfterRelease: process.memoryUsage(),
      });
      assert.deepEqual(errors, []);
      assert.equal(manager.stats().browsers, 0);
    } finally {
      await Promise.allSettled(clients.map((c) => c.close()));
      await manager.close();
    }
  }
  report.pools = pools;
  report.forbiddenCommands = forbiddenCount;
  assert.equal(forbiddenCount, 0);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fixture.stop();
}
