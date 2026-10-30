import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Browser, InputActionError } from '../../src/index.ts';
async function editor(browser: Browser) {
  const tab = await browser.newTab(
    'data:text/html,<textarea id=editor></textarea><input id=other>',
  );
  await tab.evaluate(() => {
    const log: unknown[] = [];
    (window as any).inputEvents = log;
    for (const type of [
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'beforeinput',
      'input',
    ])
      document.addEventListener(type, (event) =>
        log.push({
          type,
          data: (event as InputEvent).data,
          composing: (event as InputEvent).isComposing,
          id: (event.target as HTMLElement).id,
        }),
      );
    document.querySelector<HTMLTextAreaElement>('#editor')!.focus();
  });
  return tab;
}
for (const transport of ['websocket', 'pipe'] as const) {
  test(transport + ': raw scope shares held modifiers with pointer events', async () => {
    await using browser = await Browser.launch({ headless: true, transport });
    const tab = await editor(browser);
    const point = await tab.evaluate(() => {
      (window as any).pointerModifiers = [];
      for (const type of ['mousedown', 'mouseup'])
        document.addEventListener(type, (event) => {
          (window as any).pointerModifiers.push((event as MouseEvent).shiftKey);
        });
      const rect = document.querySelector('textarea')!.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    const session = await browser.attachSession(tab.id);
    await browser.inputScope(session).run(async (input) => {
      await input.keyboard.down('Shift');
      await input.mouse.click(point.x, point.y);
    });
    assert.deepEqual(await tab.evaluate('window.pointerModifiers'), [true, true]);
  });
  test(
    transport +
      ': explicit composition emits browser lifecycle events and commits Chinese/combining/ZWJ text once',
    async () => {
      await using browser = await Browser.launch({ headless: true, transport });
      const tab = await editor(browser);
      const report = await tab.keyboard.compose(async (ime) => {
        await ime.update('中文');
        await ime.update('中文é👨‍👩‍👧‍👦', { selectionStart: 2, selectionEnd: 15 });
        await ime.commit();
      });
      assert.equal(report.completedSegments, 1);
      assert.equal(await tab.evaluate('document.querySelector("#editor").value'), '中文é👨‍👩‍👧‍👦');
      const events =
        await tab.evaluate<Array<{ type: string; composing?: boolean }>>('(window).inputEvents');
      const lifecycle = events.filter((e) => e.type.startsWith('composition')).map((e) => e.type);
      assert.equal(lifecycle[0], 'compositionstart');
      assert.equal(lifecycle.at(-1), 'compositionend');
      assert.ok(lifecycle.length >= 4);
      assert.ok(lifecycle.slice(1, -1).every((type) => type === 'compositionupdate'));
      assert.ok(events.some((e) => e.type === 'input' && e.composing));
      const raw = await browser.attachSession(tab.id);
      await browser.inputScope(raw).run(async (input) => {
        await input.composition.update('取消');
        await input.composition.cancel();
        await input.keyboard.insertText('!');
      });
      assert.equal(await tab.evaluate('document.querySelector("#editor").value'), '中文é👨‍👩‍👧‍👦!');
    },
  );
  test(
    transport + ': abort cancels uncommitted composition before another scoped input',
    async () => {
      await using browser = await Browser.launch({ headless: true, transport });
      const tab = await editor(browser),
        controller = new AbortController();
      const cause = new Error('cancel composing');
      const error = await tab.keyboard
        .compose(
          async (ime) => {
            await ime.update('取消');
            controller.abort(cause);
          },
          { signal: controller.signal },
        )
        .catch((e) => e);
      assert.ok(error instanceof InputActionError);
      assert.equal(error.cause, cause);
      assert.equal((await error.cleanup).status, 'completed');
      await tab.keyboard.insertText('后续');
      assert.equal(await tab.evaluate('document.querySelector("#editor").value'), '后续');
    },
  );
  test(transport + ': focus changes stop composition commit', async () => {
    await using browser = await Browser.launch({ headless: true, transport });
    const tab = await editor(browser);
    const error = await tab.keyboard
      .compose(async (ime) => {
        await ime.update('旧焦点');
        await tab.evaluate('document.querySelector("#other").focus()');
        await ime.commit('不得写入');
      })
      .catch((e) => e);
    assert.ok(error instanceof InputActionError);
    await error.cleanup;
    assert.equal(await tab.evaluate('document.querySelector("#other").value'), '');
  });
  test(
    transport + ': navigation interrupts a raw scope and never commits into the new document',
    async () => {
      await using browser = await Browser.launch({ headless: true, transport });
      const tab = await editor(browser),
        session = await browser.attachSession(tab.id);
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const pending = browser
        .inputScope(session)
        .run(async (input) => {
          await input.composition.update('旧文档');
          ready();
          await input.wait(5000);
          await input.composition.commit('不得写入');
        })
        .catch((e) => e);
      await started;
      await tab.goto('data:text/html,<textarea id=new></textarea>');
      const error = await pending;
      assert.ok(error instanceof InputActionError);
      assert.match(String(error.cause), /Document changed/);
      await error.cleanup;
      assert.equal(await tab.evaluate('document.querySelector("#new").value'), '');
    },
  );
  test(
    transport + ': composition verifies focus through same-origin iframe ancestors',
    async () => {
      await using browser = await Browser.launch({ headless: true, transport });
      const tab = await editor(browser);
      await tab.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const iframe = document.createElement('iframe');
            iframe.onload = () => {
              iframe.contentDocument!.querySelector('textarea')!.focus();
              resolve();
            };
            iframe.srcdoc = '<textarea></textarea>';
            document.body.append(iframe);
          }),
      );
      const error = await tab.keyboard
        .compose(async (ime) => {
          await ime.update('子框架');
          await tab.evaluate('document.querySelector("#other").focus()');
          await ime.commit('不得写入');
        })
        .catch((e) => e);
      assert.ok(error instanceof InputActionError);
      await error.cleanup;
      assert.equal(await tab.evaluate('document.querySelector("#other").value'), '');
    },
  );
}
