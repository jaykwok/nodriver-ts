import { Browser } from '../src/index.ts';
const endpoint = process.argv[2];
if (!endpoint) throw new Error('Usage: bun examples/connect.ts http://127.0.0.1:9222');
await using browser = await Browser.connect({ endpoint });
console.log(
  browser.version.product,
  browser.tabs.map((tab) => tab.url),
);
// Disposing this external connection disconnects; its Chrome process and profile remain owned by their creator.
