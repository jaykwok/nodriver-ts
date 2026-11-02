import { writeFile } from 'node:fs/promises';
import { Browser } from '../../src/index.ts';

// Launches Chrome for a parent test, records what it owns, then waits for a signal or exits.
const [record, mode] = process.argv.slice(2);
const browsers = await Promise.all(
  [0, 1].map(() => Browser.launch({ headless: true, handleSignals: mode !== 'exit' })),
);
if (mode === 'hosted')
  process.once('SIGTERM', () => {
    void writeFile(record + '.hosted', 'handled');
  });
await writeFile(
  record!,
  JSON.stringify(browsers.map((b) => ({ pid: b.process!.pid, profile: b.process!.profile }))),
);
// Exit without closing: the host's exit ends Chrome it launched without `detached`.
if (mode === 'exit') process.exit(0);
setInterval(() => {}, 1000);
