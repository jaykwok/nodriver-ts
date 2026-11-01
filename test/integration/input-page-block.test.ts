import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  Browser,
  Keyboard,
  InputActionError,
  InputBlockedError,
  type Session,
} from '../../src/index.ts';
import { poll } from '../../src/utils.ts';

async function state(session: Session) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: '({events,value:document.querySelector("#editor").value})',
    returnByValue: true,
  });
  return result.value as { events: string[]; value: string };
}

for (const transport of ['websocket', 'pipe'] as const) {
  test(`${transport}: two pages keep independent live native compositions`, async (t) => {
    await using browser = await Browser.launch({ headless: true, attach: 'none', transport });
    const pages: Session[] = [];
    for (let i = 0; i < 2; i++) {
      const { targetId } = await browser.cdp.send('Target.createTarget', {
        url: 'about:blank',
        newWindow: true,
        background: true,
      });
      const session = await browser.attachSession(targetId);
      await session.send('Runtime.evaluate', {
        expression: `document.body.innerHTML='<textarea id="editor"></textarea>';window.events=[];
          for(const type of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(type,()=>events.push(type));
          document.querySelector('#editor').focus();`,
      });
      pages.push(session);
    }
    const [a, b] = pages;
    await a!.send('Page.bringToFront');
    await a!.send('Input.imeSetComposition', {
      text: '未完成',
      selectionStart: 3,
      selectionEnd: 3,
    });
    await b!.send('Page.bringToFront');
    await b!.send('Input.insertText', { text: '普通' });
    await b!.send('Input.imeSetComposition', { text: '组合', selectionStart: 2, selectionEnd: 2 });
    await b!.send('Input.insertText', { text: '组合' });
    assert.equal((await state(b!)).value, '普通组合');
    assert.deepEqual(await state(a!), {
      events: ['compositionstart', 'compositionupdate'],
      value: '未完成',
    });
    await a!.send('Page.bringToFront');
    await a!.send('Input.imeSetComposition', { text: '更新', selectionStart: 2, selectionEnd: 2 });
    await a!.send('Input.insertText', { text: '完成' });
    const final = await state(a!);
    assert.equal(final.value, '完成');
    assert.equal(final.events.filter((e) => e === 'compositionstart').length, 1);
    assert.equal(final.events.filter((e) => e === 'compositionend').length, 1);
    t.diagnostic(browser.version.product);
  });

  test(`${transport}: a composition block covers the page and its OOPIF, while another page remains usable`, async (t) => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html;charset=utf-8');
      response.end(
        request.url === '/child'
          ? '<input id=editor>'
          : `<input id=outside><iframe src="http://127.0.0.1:${port}/child"></iframe>`,
      );
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const port = (server.address() as { port: number }).port;
    await using browser = await Browser.launch({ headless: true, transport });
    const a = await browser.newTab(`http://localhost:${port}/`);
    const child = await poll(
      async () => {
        const frame = a.frames.find((frame) => frame.url.endsWith('/child'));
        return frame && (await frame.evaluate('!!document.getElementById("editor")'))
          ? frame
          : undefined;
      },
      { timeout: 5000 },
      'cross-origin editor',
    );
    assert.notEqual(child.session.id, a.session.id);
    await child.evaluate('document.getElementById("editor").focus()');
    const error = await a.keyboard
      .compose(async (ime) => {
        await ime.update('文');
        await a.evaluate('document.getElementById("outside").focus()');
        await ime.commit('不得写入');
      })
      .catch((e) => e);
    assert.ok(error instanceof InputActionError);
    assert.equal((await error.cleanup).status, 'failed');
    assert.equal(await a.evaluate('document.getElementById("outside").value'), '');
    assert.equal(await child.evaluate('document.getElementById("editor").value'), '文');
    for (const session of [
      a.session,
      child.session,
      await browser.attachSession(a.id),
      await browser.attachSession(child.id),
    ]) {
      const blocked = await new Keyboard(session).insertText('不得写入').catch((e) => e);
      assert.ok(blocked instanceof InputActionError);
      assert.ok(blocked.cause instanceof InputBlockedError);
      assert.match(String(blocked.cause), /close this page/);
      await blocked.cleanup;
    }
    const b = await browser.newTab('data:text/html,<textarea id=editor></textarea>');
    await b.evaluate('document.querySelector("#editor").focus()');
    await b.keyboard.insertText('其他页');
    await b.keyboard.compose(async (ime) => {
      await ime.update('组合');
      await ime.commit();
    });
    assert.equal(await b.evaluate('document.querySelector("#editor").value'), '其他页组合');
    const destroyed = browser.cdp.waitFor(
      'Target.targetDestroyed',
      (event) => event.targetId === a.id,
    );
    await a.close();
    await destroyed;
    await b.keyboard.insertText('继续');
    assert.equal(await b.evaluate('document.querySelector("#editor").value'), '其他页组合继续');
    assert.equal(browser.connection.unansweredCount, 0);
  });
}
