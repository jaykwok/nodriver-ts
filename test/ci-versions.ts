// Prints the runtime and browser a CI job actually tested; the browser comes from CHROME_PATH or
// the normal executable search. This is the first Chrome start on a fresh runner, which can take
// longer than the default launch timeout while Chrome builds its caches.
import { Browser, findExecutable } from '../src/index.ts';

const path = await findExecutable();
const browser = await Browser.launch({ headless: true, timeout: 60_000 });
try {
  console.log(
    [
      `os: ${process.platform} ${process.arch}`,
      `runtime: ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`}`,
      `browser: ${browser.version.product} (${path})`,
      `protocol: ${browser.version.protocolVersion}`,
    ].join('\n'),
  );
} finally {
  await browser.close();
}
