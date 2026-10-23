// Prints the runtime and browser a CI job actually tested; the browser comes from CHROME_PATH or
// the normal executable search.
import { Browser, findExecutable, type ConnectionObserver } from '../src/index.ts';

const path = await findExecutable();
console.log(`os: ${process.platform} ${process.arch}\nruntime: Node.js ${process.versions.node}`);
console.log(`executable: ${path}`);
const commands: Parameters<NonNullable<ConnectionObserver['onSend']>>[0][] = [];
const responses = new Set<number>();
// Version collection needs no Tab/Frame setup or startup-window wait. Full initialization is
// exercised by the browser suites; keep this metadata probe independent of page readiness.
const browser = await Browser.launch({
  executablePath: path,
  headless: true,
  attach: 'none',
  observe: {
    onSend: (event) => {
      commands.push(event);
    },
    onResponse: (event) => {
      responses.add(event.seq);
    },
  },
}).catch((error: unknown) => {
  console.error(
    'Version probe commands:',
    commands.map((command) => ({
      ...command,
      responded: responses.has(command.seq),
    })),
  );
  throw error;
});
try {
  console.log(
    [
      `browser: ${browser.version.product} (${path})`,
      `protocol: ${browser.version.protocolVersion}`,
    ].join('\n'),
  );
} finally {
  await browser.close();
}
