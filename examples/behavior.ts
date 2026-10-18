import { Browser } from '../src/index.js';
await using browser = await Browser.launch(); // Default headed; set headless:true on a server.
const tab = await browser.newTab();
await tab.setContent('<input><button>Continue</button>');
tab.setInputPolicy({ mode: 'human', seed: 42, keyDelay: [25, 80] });
const input = await tab.waitForSelector('input');
await input.fill('');
console.log(await input.type('中文👨‍👩‍👧‍👦'));
console.log(await tab.diagnoseEnvironment({ worker: true, webgl: true, fontSelectors: ['input'] }));
console.log(await tab.alignEnvironment({ environment: { timezone: 'Asia/Singapore' } }));
