import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, access } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { Browser, StaleElementError, type Tab } from '../src/index.js';
import { BrowserSessionManager } from '../src/mcp/manager.js';
import { startBrowserMcpHttpServer, type BrowserMcpHttpServer } from '../src/mcp/http.js';
import {
  startBrowserMcpSocketServer,
  BrowserMcpSocketClientTransport,
  type BrowserMcpSocketServer,
} from '../src/mcp/socket.js';
import { PipeTransport } from '../src/transport/pipe.js';
import { WebSocketTransport } from '../src/transport/websocket.js';
import { fixtureServer } from '../test/fixtures/server.js';
import { poll } from '../src/utils.js';

const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? '');
}
const hours = Number(option('--hours', '24')),
  interval = Number(option('--interval-ms', '15000'));
const cyclesLimit = Number(option('--cycles', '0'));
assert.ok(Number.isFinite(hours) && hours > 0 && hours <= 168);
assert.ok(Number.isSafeInteger(interval) && interval >= 10);
assert.ok(Number.isSafeInteger(cyclesLimit) && cyclesLimit >= 0);
const output = resolve(option('--output', `dev/soak-${process.platform}-${Date.now()}`));
await mkdir(output, { recursive: true });
assert.equal(
  await Bun.file(join(output, 'status.json')).exists(),
  false,
  'Use a fresh output directory; never overwrite a previous run',
);
const started = Date.now(),
  until = started + hours * 3600000;
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});
const token = randomBytes(32).toString('hex'); // Never written to a report or command line.
const fixture = fixtureServer({ hostname: '127.0.0.1' });
const counts = { pipe: 0, websocket: 0 },
  violations: string[] = [];
const originals = [PipeTransport.prototype.send, WebSocketTransport.prototype.send];
for (const [i, prototype] of [PipeTransport.prototype, WebSocketTransport.prototype].entries()) {
  prototype.send = function (message: string) {
    const method = JSON.parse(message).method;
    counts[i === 0 ? 'pipe' : 'websocket']++;
    if (
      [
        'Runtime.enable',
        'Runtime.disable',
        'Runtime.addBinding',
        'Console.enable',
        'Debugger.enable',
        'Page.addScriptToEvaluateOnNewDocument',
      ].includes(method)
    ) {
      violations.push(method);
      throw new Error(`Forbidden default command ${method}`);
    }
    return originals[i]!.call(this, message);
  };
}
interface Runtime {
  mode: 'http-pipe' | 'socket-websocket';
  service: BrowserMcpHttpServer | BrowserMcpSocketServer;
  manager: BrowserSessionManager;
  client: Client;
  leaseId: string;
  browser: Browser;
  tab: Tab;
  clicks: number;
  baseline: ReturnType<typeof resources>;
}
const runtimes: Runtime[] = [];
let status = 'starting',
  cycle = 0,
  failure: string | undefined,
  lastCycle = Date.now(),
  largestGapMs = 0;
const hashes: Record<string, string> = {};
for (const file of [
  'src/mcp/http.ts',
  'src/mcp/socket.ts',
  'src/mcp/session.ts',
  'src/browser/browser.ts',
  'src/page/frames.ts',
  'benchmarks/soak.ts',
  'test/fixtures/server.ts',
])
  hashes[file] = createHash('sha256')
    .update(new Uint8Array(await Bun.file(resolve(file)).arrayBuffer()))
    .digest('hex');
async function writeStatus(extra: Record<string, unknown> = {}) {
  const state = {
    status,
    pid: process.pid,
    platform: process.platform,
    runtime: `Bun ${Bun.version}`,
    startedAt: new Date(started).toISOString(),
    plannedEnd: new Date(until).toISOString(),
    updatedAt: new Date().toISOString(),
    elapsedSeconds: (Date.now() - started) / 1000,
    cycle,
    cyclesLimit,
    hours,
    intervalMs: interval,
    largestGapMs,
    counts,
    forbidden: violations,
    failure,
    sourceHashes: hashes,
    stopFile: join(output, 'STOP'),
    modes: runtimes.map((r) => ({
      mode: r.mode,
      browser: r.browser.version.product,
      pid: r.browser.process?.pid,
      profile: r.browser.process?.profile,
      stats: r.manager.stats(),
    })),
    ...extra,
  };
  const temporary = join(output, 'status-next.json');
  await Bun.write(temporary, JSON.stringify(state, null, 2) + '\n');
  // Readers may inspect status during a write; retaining the previous sample in
  // JSONL makes an interrupted write diagnosable without pretending completion.
  await Bun.write(join(output, 'status.json'), JSON.stringify(state, null, 2) + '\n');
}
function resources(browser: Browser) {
  return {
    tabs: browser.tabs.length,
    contexts: browser.contextMap.size,
    sessions: (Reflect.get(browser.connection, 'sessions') as Map<string, unknown>).size,
    listeners: browser.connection.listenerCount,
    pending: browser.connection.pendingCount,
  };
}
function data(reply: CallToolResult) {
  assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
  return reply.structuredContent as Record<string, unknown>;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return data(await client.callTool({ name, arguments: args }));
}
async function find(client: Client, tabId: string, selector: string) {
  return (
    (await call(client, 'browser_find', { tabId, selector })).elements as { ref: string }[]
  )[0]!.ref;
}
async function setup(mode: Runtime['mode']) {
  const manager = new BrowserSessionManager({
    launch: {
      headless: true,
      transport: mode === 'http-pipe' ? 'pipe' : 'websocket',
      args: ['--site-per-process'],
      handleSignals: false,
    },
    maxBrowsers: 1,
    contextsPerBrowser: 2,
    maxLeases: 4,
    browserIdleMs: 3600000,
  });
  const service =
    mode === 'http-pipe'
      ? await startBrowserMcpHttpServer({ manager, tokens: { [token]: 'soak' }, port: 0 })
      : await startBrowserMcpSocketServer({ manager, tokens: { [token]: 'soak' } });
  const client = new Client(
    { name: 'local-soak', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    let leaseId: string;
    if ('url' in service) {
      const response = await fetch(service.url + '/leases', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 201);
      leaseId = ((await response.json()) as { id: string }).id;
      await client.connect(
        new StreamableHTTPClientTransport(new URL(service.url + '/mcp'), {
          requestInit: {
            headers: { authorization: `Bearer ${token}`, 'Browser-Lease-Id': leaseId },
          },
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 100,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
          },
        }),
      );
    } else {
      const transport = new BrowserMcpSocketClientTransport({ path: service.path, token });
      await client.connect(transport);
      leaseId = transport.leaseId!;
    }
    const { tabId } = await call(client, 'browser_open', { url: fixture.base + '/page?frames=1' });
    const session = manager.session('soak', leaseId),
      browser = await session.getBrowser(new AbortController().signal),
      tab = session.tab(String(tabId));
    assert.equal(tab.frames.length, 4);
    await tab.context.setCookies([{ name: 'soak-main', value: mode, url: fixture.base }]);
    // The first piercing query on a session subscribes once to DOM structure events (closed
    // shadow-root cache); make it before the baseline so only growth across rounds counts.
    await find(client, String(tabId), '#input');
    await poll(async () =>
      browser.connection.pendingCount === 0 && tab.framesManager.setup.size === 0
        ? true
        : undefined,
    );
    runtimes.push({
      mode,
      service,
      manager,
      client,
      leaseId,
      browser,
      tab,
      clicks: 0,
      baseline: resources(browser),
    });
  } catch (error) {
    await client.close();
    await service.close();
    throw error;
  }
}
async function round(r: Runtime) {
  assert.equal(r.browser.closed, false, 'Owned browser disconnected; no automatic replay/restart');
  const text = `cycle-${cycle}-${r.mode}`;
  await call(r.client, 'browser_fill', {
    tabId: r.tab.id,
    ref: await find(r.client, r.tab.id, '#input'),
    text,
  });
  await call(r.client, 'browser_click', {
    tabId: r.tab.id,
    ref: await find(r.client, r.tab.id, '#button'),
  });
  r.clicks++;
  // The owned fixture exposes a counter; observing it is read-only and verifies
  // exactly one click, instead of treating a successful dispatch as evidence.
  const observed = await r.tab.evaluate<{ value: string; clicks: number }>(
    '({value:document.querySelector("#input").value,clicks:globalThis.clicks})',
  );
  assert.equal(observed.value, text);
  assert.equal(observed.clicks, r.clicks);
  await call(r.client, 'browser_snapshot', { tabId: r.tab.id, limit: 100 });
  const mainSession = r.manager.session('soak', r.leaseId);
  assert.ok(mainSession.status().retainedRefs <= 2000);
  assert.ok(mainSession.eventLog().events.length <= 64);
  const aux = r.manager.create('soak'),
    session = r.manager.session('soak', aux.id);
  try {
    await r.manager.run('soak', aux.id, () =>
      session.run(
        new AbortController().signal,
        async (signal) => {
          const tab = await session.newTab(signal);
          await tab.goto(fixture.base + '/page?frames=1', { signal });
          assert.equal(tab.frames.length, 4);
          assert.equal(
            (await tab.context.cookies()).some((c) => c.name === 'soak-main'),
            false,
          );
          await tab.context.setCookies([
            { name: 'soak-aux', value: String(cycle), url: fixture.base },
          ]);
          const handle = await tab.mainFrame.evaluateHandle('document.body');
          await tab.goto(fixture.base + '/empty', { signal });
          await assert.rejects(() => handle.jsonValue(), StaleElementError);
          await handle.dispose();
        },
        true,
      ),
    );
  } finally {
    await r.manager.release('soak', aux.id);
  }
  assert.equal(
    (await r.tab.context.cookies()).some((c) => c.name === 'soak-aux'),
    false,
  );
  await poll(
    async () =>
      JSON.stringify(resources(r.browser)) === JSON.stringify(r.baseline) &&
      r.tab.framesManager.setup.size === 0
        ? true
        : undefined,
    { timeout: 5000 },
    'long-run resource baseline',
  ).catch((error: Error) => {
    error.message += ` (baseline ${JSON.stringify(r.baseline)}, now ${JSON.stringify({
      ...resources(r.browser),
      frameSetup: r.tab.framesManager.setup.size,
    })})`;
    throw error;
  });
  assert.deepEqual(r.manager.stats(), { leases: 1, browsers: 1, allocations: 1, exclusive: false });
}
async function sample() {
  const processes = new Map<number, { type: string; cpuTime: number }>(),
    targets = [];
  for (const r of runtimes) {
    for (const p of (await r.browser.cdp.send('SystemInfo.getProcessInfo')).processInfo)
      processes.set(p.id, { type: p.type, cpuTime: p.cpuTime });
    const heap = await r.tab.session.send('Runtime.getHeapUsage'),
      dom = await r.tab.session.send('Memory.getDOMCounters');
    targets.push({
      mode: r.mode,
      resources: resources(r.browser),
      heap,
      dom,
      refs: r.manager.session('soak', r.leaseId).status().retainedRefs,
    });
  }
  const ids = [process.pid, ...processes.keys()];
  let osProcesses: unknown = undefined;
  if (process.platform === 'linux')
    osProcesses = await Promise.all(
      ids.map(async (pid) => {
        try {
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          return {
            pid,
            rssBytes: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024,
            fdCount: await readdir(`/proc/${pid}/fd`)
              .then((f) => f.length)
              .catch(() => null),
          };
        } catch {
          return { pid, unavailable: true };
        }
      }),
    );
  if (process.platform === 'win32') {
    const p = Bun.spawn(
      [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$items=@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,Handles); ConvertTo-Json -Compress -InputObject $items`,
      ],
      { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
    );
    const text = await new Response(p.stdout).text();
    assert.equal(await p.exited, 0);
    osProcesses = JSON.parse(text);
  }
  await appendFile(
    join(output, 'samples.jsonl'),
    JSON.stringify({
      time: new Date().toISOString(),
      cycle,
      elapsedSeconds: (Date.now() - started) / 1000,
      controller: process.memoryUsage(),
      controllerCpu: process.cpuUsage(),
      targets,
      chromeProcesses: [...processes].map(([pid, p]) => ({ pid, ...p })),
      osProcesses,
      largestGapMs,
      counts,
    }) + '\n',
  );
}
await writeStatus();
try {
  await setup('http-pipe');
  await setup('socket-websocket');
  status = 'running';
  lastCycle = Date.now();
  await writeStatus();
  let lastSample = 0;
  while (
    Date.now() < until &&
    (!cyclesLimit || cycle < cyclesLimit) &&
    !stopping &&
    !(await Bun.file(join(output, 'STOP')).exists())
  ) {
    const gap = Date.now() - lastCycle;
    largestGapMs = Math.max(largestGapMs, gap);
    assert.ok(
      gap <= Math.max(120000, interval * 3),
      'Heartbeat gap exceeded allowance: possible host suspension or runner stall; not continuous soak evidence',
    );
    lastCycle = Date.now();
    cycle++;
    for (const r of runtimes) await round(r);
    if (Date.now() - lastSample >= 60000 || cycle === 1 || (cyclesLimit && cycle >= cyclesLimit)) {
      await sample();
      lastSample = Date.now();
    }
    await writeStatus();
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        cycle,
        elapsedSeconds: (Date.now() - started) / 1000,
        forbidden: violations.length,
      }),
    );
    if (cyclesLimit && cycle >= cyclesLimit) break;
    const next = Date.now() + interval;
    while (Date.now() < next && !stopping && !(await Bun.file(join(output, 'STOP')).exists()))
      await Bun.sleep(Math.max(1, Math.min(1000, next - Date.now())));
  }
  status =
    stopping || (await Bun.file(join(output, 'STOP')).exists())
      ? 'stopped'
      : cyclesLimit
        ? 'completed-cycles'
        : 'completed';
  // Check the tail too: a host suspension can jump past `until` and skip the
  // next loop iteration entirely. Elapsed wall time alone is not soak evidence.
  if (status === 'completed') {
    largestGapMs = Math.max(largestGapMs, Date.now() - lastCycle);
    assert.ok(cycle > 0, 'No completed rounds before the duration elapsed');
    assert.ok(
      largestGapMs <= Math.max(120000, interval * 3),
      'Final heartbeat gap exceeded allowance; not continuous soak evidence',
    );
  }
} catch (error) {
  status = 'failed';
  failure = error instanceof Error ? (error.stack ?? String(error)) : String(error);
  process.exitCode = 1;
} finally {
  const outcomes = await Promise.allSettled(
    runtimes.map(async (r) => {
      try {
        await r.client.close();
      } finally {
        await r.service.close();
      }
    }),
  );
  if (outcomes.some((o) => o.status === 'rejected')) {
    status = 'failed';
    failure = String(outcomes.filter((o) => o.status === 'rejected').map((o) => o.reason));
    process.exitCode = 1;
  }
  fixture.server.stop(true);
  PipeTransport.prototype.send = originals[0]!;
  WebSocketTransport.prototype.send = originals[1]!;
  const cleaned = await Promise.all(
    runtimes.map(async (r) => ({
      mode: r.mode,
      closed: r.browser.closed,
      stats: r.manager.stats(),
      profileStillExists: r.browser.process
        ? await access(r.browser.process.profile).then(
            () => true,
            (error) => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
              throw error;
            },
          )
        : null,
    })),
  );
  if (
    cleaned.some(
      (c) =>
        !c.closed ||
        c.profileStillExists ||
        c.stats.leases ||
        c.stats.browsers ||
        c.stats.allocations,
    )
  ) {
    status = 'failed';
    failure = `Incomplete shutdown: ${JSON.stringify(cleaned)}`;
    process.exitCode = 1;
  }
  await writeStatus({ cleaned });
  console.log(JSON.stringify({ status, cycle, failure, output }));
}
