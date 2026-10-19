import assert from 'node:assert/strict';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { Browser, findExecutable } from '../src/index.js';

// Same-machine comparison with Python nodriver: same Chrome, headless, WebSocket, fresh temporary
// profiles, local fixture. Run explicitly; results describe this workload on this machine only.
const samples = Number(process.env.BENCH_SAMPLES ?? 200);
assert.ok(Number.isSafeInteger(samples) && samples >= 10);
const NODRIVER = 'nodriver==0.50.6';
const PSUTIL = 'psutil==7.2.2';
const PYTHON = '3.12';

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
  return { count: values.length, p50: percentile(0.5), p95: percentile(0.95), samples: values };
}
async function timed(count: number, fn: () => Promise<unknown>): Promise<number[]> {
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await fn();
    values.push(performance.now() - start);
  }
  return values;
}
const fixture = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const n = url.pathname === '/buttons' ? Number(url.searchParams.get('n') ?? 0) : 0;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>bench</title>' +
        Array.from({ length: n }, (_, i) => `<button id="b${i}">Item ${i} 中文</button>`).join(''),
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  },
});
const base = `http://127.0.0.1:${fixture.port}`;
const chrome = await findExecutable();

async function typescript() {
  const launch = (maskHeadless?: boolean) =>
    Browser.launch({ headless: true, transport: 'websocket', maskHeadless });
  // Headless launches mask the UA by default with a probe page; Python nodriver does not, so the
  // unmasked series is the like-for-like comparison.
  const coldStart: number[] = [],
    coldStartUnmasked: number[] = [];
  for (const [series, mask] of [
    [coldStart, undefined],
    [coldStartUnmasked, false],
  ] as const)
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const browser = await launch(mask);
      await browser.newTab(base + '/empty');
      series.push(performance.now() - start);
      await browser.close();
      await Bun.sleep(1000);
    }
  const browser = await launch();
  try {
    const tab = await browser.newTab(base + '/buttons?n=1000');
    const root = browser.connection.root;
    for (let i = 0; i < 20; i++) await root.send('Browser.getVersion');
    const rtt = await timed(samples, () => root.send('Browser.getVersion'));
    for (let i = 0; i < 20; i++) await tab.evaluate('1+1');
    const evaluate = await timed(samples, () => tab.evaluate('1+1'));
    for (let i = 0; i < 5; i++) await tab.query('#b500');
    const query = await timed(samples / 2, () => tab.query('#b500'));
    let index = 0;
    await tab.goto(`${base}/empty?n=${++index}`);
    const navigation = await timed(20, () => tab.goto(`${base}/empty?n=${++index}`));
    await tab.goto(base + '/buttons?n=10000');
    await tab.cdp.send('Accessibility.getFullAXTree');
    let axNodes = 0;
    const axTree = await timed(5, async () => {
      axNodes = (await tab.cdp.send('Accessibility.getFullAXTree')).nodes.length;
    });
    return {
      runtime: `Bun ${Bun.version}`,
      library: 'nodriver-ts (this commit)',
      coldStart,
      coldStartUnmasked,
      rtt,
      evaluate,
      query,
      navigation,
      axTree,
      axNodes,
      rss: process.memoryUsage().rss,
    };
  } finally {
    await browser.close();
  }
}

// Async spawn: the fixture server runs on this process's event loop.
async function python() {
  const run = Bun.spawn(
    [
      'uv',
      'run',
      '--no-project',
      '--python',
      PYTHON,
      '--with',
      NODRIVER,
      '--with',
      PSUTIL,
      'python',
      '-I',
      join(import.meta.dir, 'compare', 'nodriver_bench.py'),
      base,
      chrome,
      String(samples),
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );
  const [output, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  if (code !== 0) throw new Error(`Python benchmark failed (${code})`);
  return JSON.parse(output.trim().split('\n').at(-1)!);
}

try {
  // Alternate the order so neither side always runs on a warmer machine.
  const order =
    process.env.BENCH_PYTHON_FIRST === '1' ? ['python', 'typescript'] : ['typescript', 'python'];
  const results: Record<string, Record<string, unknown>> = {};
  for (const side of order) {
    console.error(`running ${side}`);
    results[side] = side === 'python' ? await python() : await typescript();
  }
  const metrics = [
    'coldStart',
    'coldStartUnmasked',
    'rtt',
    'evaluate',
    'query',
    'navigation',
    'axTree',
  ];
  const summary = Object.fromEntries(
    Object.entries(results).map(([side, r]) => [
      side,
      {
        ...Object.fromEntries(Object.entries(r).filter(([k]) => !metrics.includes(k))),
        ...Object.fromEntries(
          metrics.filter((m) => r[m]).map((m) => [m, distribution(r[m] as number[])]),
        ),
      },
    ]),
  );
  console.log(
    JSON.stringify(
      {
        machine: {
          os: `${platform()} ${release()} ${arch()}`,
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          memory: totalmem(),
        },
        chrome,
        order,
        samples,
        results: summary,
      },
      null,
      1,
    ),
  );
} finally {
  fixture.stop(true);
}
