import { Browser } from '../src/index.js';

await using browser = await Browser.launch({ transport: 'pipe' });
const tab = await browser.newTab('http://localhost:8000');
// Worker/WebGL diagnostics are explicit; normal browser operations do not sample them.
console.log(JSON.stringify(await tab.inspectEnvironment({ worker: true, webgl: true }), null, 2));
