// Prints the runtime and browser a CI job actually tested; the browser comes from CHROME_PATH or
// the normal executable search.
import { Browser, findExecutable } from '../src/index.js';

const path = await findExecutable();
const browser = await Browser.launch({ headless: true });
try {
  console.log(
    [
      `os: ${process.platform} ${process.arch}`,
      `bun: ${Bun.version}`,
      `browser: ${browser.version.product} (${path})`,
      `protocol: ${browser.version.protocolVersion}`,
    ].join('\n'),
  );
} finally {
  await browser.close();
}
