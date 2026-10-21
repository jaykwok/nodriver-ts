import { Browser } from '../src/index.ts';
// CHROME_PATH can select a browser on Windows or Linux. Chrome sandbox stays enabled.
await using browser = await Browser.launch();
await using context = await browser.newContext();
const tab = await context.newTab();
await tab.goto(
  'data:text/html,<meta charset="utf-8"><input id="name"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">提交</button><output></output>',
);
await (await tab.waitForSelector('#name')).fill('你好，Node.js 😀');
await (await tab.waitForSelector('button')).click();
console.log(await (await tab.waitForSelector('output')).text());
console.log(browser.version.product);
