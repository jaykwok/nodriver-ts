// CI-only: repeats the launch, screencast, tab close and browser close sequence of the handoff
// test that once left Chrome running after close(). Run it with test/ci-close-diagnostics.ts
// preloaded; every close is recorded there. Usage: node test/ci-shutdown-stress.ts [cycles]
import { Browser } from '../src/index.ts';

const cycles = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(cycles) || cycles < 1)
  throw new TypeError(`Invalid cycle count: ${process.argv[2]}`);
const durations: number[] = [];
const failures: string[] = [];
for (let cycle = 1; cycle <= cycles; cycle++) {
  const browser = await Browser.launch({ headless: true });
  try {
    const tab = await browser.newTab();
    await tab.goto('data:text/html,<title>shutdown</title><h1>Recording</h1>');
    await tab.bringToFront();
    const off = tab.cdp.on('Page.screencastFrame', (event) => {
      void tab.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    try {
      const frame = tab.cdp.waitFor('Page.screencastFrame');
      await tab.cdp.send('Page.startScreencast', { format: 'jpeg', maxWidth: 320, maxHeight: 240 });
      await frame;
      await tab.cdp.send('Page.stopScreencast');
    } finally {
      off();
    }
    await tab.close();
  } finally {
    const started = performance.now();
    try {
      await browser.close();
    } catch (error) {
      failures.push(`cycle ${cycle}: ${String(error)}`);
      console.error(`cycle ${cycle}: ${String(error)}`);
    }
    durations.push(performance.now() - started);
  }
  if (cycle % 10 === 0) console.log(`${cycle}/${cycles} cycles, ${failures.length} failed closes`);
}
const sorted = durations.toSorted((a, b) => a - b);
const percentile = (p: number) =>
  Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);
console.log(
  `close ms: p50 ${percentile(0.5)}, p90 ${percentile(0.9)}, p99 ${percentile(0.99)}, max ${percentile(1)}; failed ${failures.length}/${cycles}`,
);
if (failures.length) process.exitCode = 1;
