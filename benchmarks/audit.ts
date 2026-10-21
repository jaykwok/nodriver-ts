import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir, platform, release, arch } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Browser, findExecutable } from '../src/index.ts';
import { removeTree, poll } from '../src/utils.ts';
import { WebSocketTransport } from '../src/transport/websocket.ts';
import { recordWire, forbiddenAutomaticCommands } from '../test/fixtures/wire.ts';
import { auditFixture } from './audit-fixture.ts';
import { summarizeAudit } from './audit-report.ts';
import { checkAudit } from './audit-checks.ts';

const repeats = Number(process.env.AUDIT_REPEATS ?? 2);
assert.ok(Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 20);
const headless = process.env.AUDIT_HEADFUL !== '1';
const transports = (process.env.AUDIT_TRANSPORTS ?? 'websocket,pipe').split(',');
assert.ok(transports.every((t) => t === 'pipe' || t === 'websocket'));
const executable = await findExecutable();
const fixture = await auditFixture();
const runs: Array<Record<string, any>> = [];
const common = ['--disable-extensions', '--window-size=1000,800'];
const variants = [
  { name: 'default-native', maskHeadless: undefined, args: [] as string[] },
  { name: 'default-masked', maskHeadless: true, args: [] as string[] },
  {
    name: 'explicit-environment',
    maskHeadless: false,
    args: [] as string[],
    environment: { userAgent: 'Local-Audit-UA/1.0', locale: 'en-US', timezone: 'UTC' },
  },
  { name: 'agent', maskHeadless: false, preset: 'agent' as const, args: [] as string[] },
  {
    name: 'occluded-flag',
    maskHeadless: false,
    args: ['--disable-backgrounding-occluded-windows'],
  },
  { name: 'renderer-flag', maskHeadless: false, args: ['--disable-renderer-backgrounding'] },
];
const selectedVariants = process.env.AUDIT_VARIANTS?.split(',');
if (selectedVariants)
  assert.ok(selectedVariants.every((name) => variants.some((v) => v.name === name)));
function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (p: number) => (sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null);
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), samples: values };
}
function consistency(report: Record<string, any>) {
  const differences: unknown[] = [];
  for (const [kind, worker] of Object.entries(report.workers ?? {}) as Array<[string, any]>) {
    if (worker.status !== 'observed') continue;
    for (const [field, observed] of Object.entries(worker.environment) as Array<[string, any]>) {
      const page = report.environment[field];
      if (page?.status !== 'observed' || observed.status !== 'observed') continue;
      if (JSON.stringify(page) !== JSON.stringify(observed))
        differences.push({ context: kind, field, document: page, worker: observed });
    }
  }
  return differences;
}
async function raw(stage: string, repeat: number) {
  const run = `${stage}-${repeat}`;
  const profile = await mkdtemp(join(tmpdir(), 'nodriver-audit-'));
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    ...(headless ? ['--headless=new'] : []),
    ...common,
  ];
  if (stage !== 'A-native') args.push('--disable-blink-features=AutomationControlled');
  if (['B-endpoint', 'C-raw', 'D-attached'].includes(stage))
    args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0');
  args.push(`${fixture.origin}/r/${run}/page?run=${run}`);
  const child = spawn(executable, args, {
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (value: Buffer) => {
    stderr = (stderr + value.toString()).slice(-4000);
  });
  let wire: WebSocketTransport | undefined;
  let browser: Browser | undefined;
  const audit = stage === 'D-attached' ? recordWire('websocket') : undefined;
  let version;
  let initialized = 0;
  try {
    await fixture.wait(run, 'ready');
    if (stage === 'C-raw' || stage === 'D-attached') {
      const active = await poll(
        async () => {
          try {
            return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
          } catch {
            return undefined;
          }
        },
        { timeout: 10000 },
      );
      const endpoint = `ws://127.0.0.1:${active[0]}${active[1]}`;
      if (stage === 'C-raw') wire = await WebSocketTransport.connect(endpoint);
      else {
        browser = await Browser.connect({ endpoint });
        version = browser.version;
        initialized = audit!.messages.length;
      }
    }
    await sleep(500);
    await fixture.sample(run, 'after-connect-control');
    if (browser) {
      await browser.close();
      await sleep(500);
      await fixture.sample(run, 'after-disconnect');
    }
    const start = fixture.reports.length;
    fixture.commands.set(run, 'reload');
    await fixture.wait(run, 'ready', start);
    await fixture.sample(run, 'cleanup');
    runs.push({
      run,
      stage,
      repeat,
      headless,
      transport: stage === 'A-native' || stage === 'A-matched' ? 'none' : 'websocket',
      args,
      commands: audit?.messages ?? [],
      initialization: audit ? audit.messages.slice(0, initialized) : 'none',
      browser: version,
      domains: audit?.messages.filter(
        (m) => /\.(enable|disable)$/.test(m.method) || m.method === 'DOM.getDocument',
      ),
      comparison:
        stage === 'D-attached'
          ? 'same loaded document before initialization, after initialization, after disconnect'
          : 'independent raw control',
      physicalInput: 'not-performed',
      stderr,
    });
    assert.equal(
      audit?.messages.some((m) => forbiddenAutomaticCommands.includes(m.method)) ?? false,
      false,
    );
  } finally {
    await browser?.close();
    audit?.restore();
    await wire?.close();
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32')
        await new Promise<void>((resolve, reject) => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('error', reject);
          killer.once('close', () => resolve());
        });
      else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
      }
    }
    await poll(
      async () => (child.exitCode !== null || child.signalCode !== null ? true : undefined),
      { timeout: 10000 },
    );
    await removeTree(profile);
  }
}
try {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const stage of ['A-native', 'A-matched', 'B-endpoint', 'C-raw', 'D-attached']) {
      console.error(`Audit ${stage} ${repeat}`);
      await raw(stage, repeat);
    }
    for (const transport of transports as Array<'pipe' | 'websocket'>)
      for (const variant of variants.filter(
        (v) => !selectedVariants || selectedVariants.includes(v.name),
      )) {
        const run = `D-E-${transport}-${variant.name}-${repeat}`;
        console.error(`Audit ${run}`);
        const audit = recordWire(transport);
        const browser = await Browser.launch({
          executablePath: executable,
          headless,
          transport,
          maskHeadless: variant.maskHeadless,
          preset: 'preset' in variant ? variant.preset : 'default',
          args: ['--disable-extensions', ...variant.args],
          windowSize: { width: 1000, height: 800 },
        });
        try {
          const initialized = audit.messages.length;
          const initialTabs = [...browser.tabs];
          const tab = await browser.newTab();
          for (const initial of initialTabs) await initial.close();
          if (variant.environment) await tab.setEnvironment(variant.environment);
          await tab.goto(`${fixture.origin}/r/${run}/page?run=${run}`);
          await fixture.wait(run, 'ready');
          const operations: unknown[] = [];
          const operation = async (name: string, task: () => Promise<unknown>) => {
            const start = performance.now(),
              commandStart = audit.messages.length;
            await task();
            const elapsedMs = performance.now() - start;
            await fixture.sample(run, name);
            const observed = fixture.reports.at(-1)!;
            if (name === 'input')
              assert.deepEqual(
                { input: observed.expectedDom.input, clicks: observed.expectedDom.clicks },
                { input: 'audit-input', clicks: 1 },
              );
            if (name === 'scroll') assert.ok(observed.expectedDom.scrollY > 0);
            operations.push({ name, elapsedMs, commands: audit.messages.slice(commandStart) });
          };
          await operation('dom', async () => (await tab.query('#name'))!.text());
          await operation('ax', () =>
            tab.cdp.send('Accessibility.getFullAXTree', { frameId: tab.mainFrame.id }),
          );
          await operation('fonts', () => tab.diagnoseEnvironment({ fontSelectors: ['#click'] }));
          await operation('input', async () => {
            await (await tab.query('#name'))!.fill('audit-input');
            await (await tab.query('#click'))!.click();
          });
          await operation('scroll', async () => {
            await tab.mouse.wheel(0, 240);
            await tab.waitForFunction('scrollY > 0');
          });
          const cover = await browser.newTab('about:blank');
          await cover.bringToFront();
          await fixture.sample(run, 'background-start');
          await sleep(1200);
          await fixture.sample(run, 'background-tab');
          await tab.bringToFront();
          await cover.close();
          const start = fixture.reports.length;
          await tab.goto(`${fixture.origin}/r/${run}/page?run=${run}&life=controlled`);
          await fixture.wait(run, 'ready', start);
          await fixture.sample(run, 'after-navigation');
          await fixture.sample(run, 'cleanup');
          assert.equal(
            audit.messages.some((m) => forbiddenAutomaticCommands.includes(m.method)),
            false,
          );
          runs.push({
            run,
            stage: 'D-initialized/E-operations',
            repeat,
            transport,
            headless,
            variant,
            browser: browser.version,
            args: browser.process?.child.spawnargs,
            initialization: audit.messages.slice(0, initialized),
            operations,
            commands: audit.messages,
            domains: audit.messages.filter(
              (m) => /\.(enable|disable)$/.test(m.method) || m.method === 'DOM.getDocument',
            ),
            environmentOverride: browser.baseEnvironment,
            occlusion: 'uncontrolled; background tab is not OS occlusion',
            physicalInput: 'not-performed',
          });
        } finally {
          await browser.close();
          audit.restore();
        }
      }
  }
  for (const report of fixture.reports)
    if (report.environment) {
      report.observedDifferences = consistency(report);
      report.timing.intervalMs = distribution(report.timing.intervalMs);
      report.timing.animationFrameMs = distribution(report.timing.animationFrameMs);
    }
  const validation = checkAudit({ runs, reports: fixture.reports, requests: fixture.headers });
  console.log(
    JSON.stringify(
      {
        date: new Date().toISOString(),
        runtime: process.version,
        os: { platform: platform(), release: release(), arch: arch() },
        executable,
        repeats,
        schemaVersion: 2,
        validation,
        ...summarizeAudit(runs, fixture.reports, fixture.headers),
        methodology:
          'Independent empty disposable profiles; same self-reporting page/worker probes and localhost request receiver in every group. A-native has no debugging or automation-feature flag; A-matched adds only the library automation-feature flag. B adds an endpoint without connecting; C opens a browser WebSocket without sending CDP commands. D-attached initializes Browser.connect on an already sampled page, samples that same document again, disconnects, and samples again. Raw/attached controls are WebSocket only; Pipe has no unconnected endpoint equivalent. D/E records full launch initialization including chrome://version masking probes. No physical input or controlled OS occlusion. Probes create workers, register/claim/unregister a scoped service worker, issue local requests, observe DOM, and run timers/rAF in every group; their cost is part of the measurement. Fresh profiles have no extensions, permissions, warm cache or prior registrations; controlled reload intentionally reuses only its own registration. Focus, OS scheduling, GPU and display conditions are observed rather than assumed.',
        limitations: {
          physicalInput: 'not-verified',
          osOcclusion: 'not-controlled',
          otherPlatforms: 'not-tested',
          headful: headless
            ? 'not-run; opt in with AUDIT_HEADFUL=1 on an idle desktop'
            : 'observed without physical human input',
          headlessVsHeadful: 'independent runs required; never treated as equivalent',
          rawBrowserVersion:
            'same executable as D; raw page low/high entropy UA observations, no CDP version query',
        },
        runs,
        reports: fixture.reports,
        requests: fixture.headers,
      },
      null,
      2,
    ),
  );
  if (!validation.passed) {
    console.error(JSON.stringify({ auditFailures: validation.failures }));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      failure: String(error),
      runs,
      reports: fixture.reports,
      requests: fixture.headers,
    }),
  );
  throw error;
} finally {
  await fixture.close();
}
