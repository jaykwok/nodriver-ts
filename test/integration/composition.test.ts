import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { Browser, InputActionError, InputBlockedError, Keyboard } from '../../src/index.ts';
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
  for (const forceCancel of [false, true]) {
    test(`${transport}: focus stolen during compositionstart; forceCancel=${forceCancel}`, async () => {
      await using browser = await Browser.launch({ headless: true, transport });
      const tab = await editor(browser);
      await tab.evaluate(() => {
        document
          .querySelector('#editor')!
          .addEventListener(
            'compositionstart',
            () => document.querySelector<HTMLInputElement>('#other')!.focus(),
            { once: true },
          );
      });
      const session = await browser.attachSession(tab.id);
      const scope = browser.inputScope(session, { pageEvents: false });
      const error = await new Keyboard(session)
        .compose(
          async (ime) => {
            await ime.update('中');
            await ime.commit('不得写入');
          },
          { pageEvents: false, forceCancel },
        )
        .catch((e) => e);
      assert.ok(error instanceof InputActionError);
      assert.match(String(error.cause), /lost focus/);
      assert.equal((await error.cleanup).status, forceCancel ? 'completed' : 'failed');
      assert.equal(await tab.evaluate('document.querySelector("#editor").value'), '');
      assert.equal(
        await tab.evaluate('document.querySelector("#other").value'),
        forceCancel ? '' : '中',
      );
      if (!forceCancel) {
        const blocked = await tab.keyboard.insertText('不得写入').catch((e) => e);
        assert.ok(blocked instanceof InputActionError);
        assert.ok(blocked.cause instanceof InputBlockedError);
        await blocked.cleanup;
        // The caller restores and verifies the browser state before acknowledging recovery.
        await session.send('Input.imeSetComposition', {
          text: '',
          selectionStart: 0,
          selectionEnd: 0,
        });
        assert.equal(await tab.evaluate('document.querySelector("#other").value'), '');
        assert.equal(await scope.recoverComposition(), true);
        assert.equal((await error.cleanup).status, 'failed');
      }
      const events = await tab.evaluate<Array<{ type: string; id: string }>>('window.inputEvents');
      assert.ok(events.some((event) => event.type === 'compositionend' && event.id === 'other'));
      assert.equal(await scope.recoverComposition(), false);
      await tab.evaluate('document.querySelector("#editor").focus()');
      await scope.run(async (input) => {
        await input.composition.update('继续中文');
        await input.composition.commit();
      });
      assert.equal(await tab.evaluate('document.querySelector("#editor").value'), '继续中文');
      await tab.keyboard.insertText('!');
      assert.equal(await tab.evaluate('document.querySelector("#editor").value'), '继续中文!');
    });
  }
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

for (const forceCancel of [false, true])
  test(`a composition that ended by itself is not cancelled over a range selection (forceCancel: ${forceCancel})`, async () => {
    await using browser = await Browser.launch({ headless: true });
    const tab = await editor(browser);
    await tab.evaluate(() => {
      const editor = document.querySelector<HTMLTextAreaElement>('#editor')!;
      editor.value = 'keep ';
      editor.setSelectionRange(5, 5);
    });
    const error = await tab.keyboard
      .compose(
        async (ime) => {
          await ime.update('this');
          // Chrome finishes the composition on blur; focus comes back with the text selected.
          await tab.evaluate(() => {
            const editor = document.querySelector<HTMLTextAreaElement>('#editor')!;
            editor.blur();
            editor.focus();
            editor.select();
          });
          throw new Error('stop without committing');
        },
        { forceCancel },
      )
      .catch((e: unknown) => e);
    assert.ok(error instanceof InputActionError);
    const cleanup = await error.cleanup;
    assert.equal(cleanup.status, 'failed');
    assert.match(cleanup.report.cleanupErrors.join(), /Composition cancel refused/);
    assert.equal(
      await tab.evaluate(() => document.querySelector<HTMLTextAreaElement>('#editor')!.value),
      'keep this',
    );
  });
test('a composition that ended by itself is cancelled harmlessly over a collapsed selection', async () => {
  await using browser = await Browser.launch({ headless: true });
  const tab = await editor(browser);
  const report = await tab.keyboard.compose(async (ime) => {
    await ime.update('text');
    await tab.evaluate(() => {
      const editor = document.querySelector<HTMLTextAreaElement>('#editor')!;
      editor.blur();
      editor.focus();
    });
    await ime.cancel();
  });
  assert.equal(report.status, 'completed');
  assert.equal(
    await tab.evaluate(() => document.querySelector<HTMLTextAreaElement>('#editor')!.value),
    'text',
  );
});
test('watching for the end of a composition is invisible to main-world scripts', async () => {
  await using browser = await Browser.launch({ headless: true });
  const tab = await editor(browser);
  const session = await browser.attachSession(tab.id);
  await tab.evaluate(() => {
    (window as any).added = [];
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (this: EventTarget, ...args: any[]) {
      (window as any).added.push(args[0]);
      return (add as any).apply(this, args);
    };
  });
  await browser.inputScope(session).run(async (input) => {
    await input.composition.update('中');
    await input.composition.cancel();
  });
  assert.deepEqual(await tab.evaluate('window.added'), []);
  // A later, independent composition starts over.
  const report = await tab.keyboard.compose(async (ime) => {
    await ime.update('文');
    await ime.commit();
  });
  assert.equal(report.status, 'completed');
  assert.equal(
    await tab.evaluate(() => document.querySelector<HTMLTextAreaElement>('#editor')!.value),
    '文',
  );
});
test('raw composition with pageEvents false sends no enable and never probes in the main world', async () => {
  const sent: string[] = [];
  await using browser = await Browser.launch({
    headless: true,
    attach: 'none',
    observe: { onSend: ({ method }) => void sent.push(method) },
  });
  const { targetId } = await browser.cdp.send('Target.createTarget', {
    url: 'data:text/html,<textarea id=editor></textarea>',
  });
  const session = await browser.attachSession(targetId);
  // Raw scopes never activate a target; a background page drops IME input.
  await session.send('Page.bringToFront');
  for (let i = 0; ; i++) {
    const ready = await session.send('Runtime.evaluate', {
      expression: '!!document.querySelector("#editor")',
      returnByValue: true,
    });
    if (ready.result.value === true) break;
    assert.ok(i < 100, 'editor page did not load');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // A page that counts every main-world access to the getters the focus probes rely on.
  await session.send('Runtime.evaluate', {
    expression: `window.hits = 0;
      for (const [proto, name] of [[Document.prototype, 'activeElement'], [ShadowRoot.prototype, 'activeElement'], [Node.prototype, 'isConnected'], [Window.prototype, 'frameElement']]) {
        const own = Object.getOwnPropertyDescriptor(proto, name) ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proto), name);
        if (!own) continue;
        Object.defineProperty(proto, name, { configurable: true, get() { window.hits++; return own.get.call(this); } });
      }
      const getRootNode = Node.prototype.getRootNode;
      Node.prototype.getRootNode = function (...args) { window.hits++; return getRootNode.apply(this, args); };
      document.querySelector('#editor').focus();
      window.hits = 0;`,
  });
  const installed = await session.send('Runtime.evaluate', {
    expression: '[document.activeElement.id, window.hits]',
    returnByValue: true,
  });
  // The hooks are live: one main-world read of activeElement was counted.
  assert.deepEqual(installed.result.value, ['editor', 1]);
  await session.send('Runtime.evaluate', { expression: 'window.hits = 0' });
  sent.length = 0;
  const scope = browser.inputScope(session, { pageEvents: false });
  await scope.run(async (input) => {
    await input.composition.update('中文');
    await input.composition.commit();
  });
  await scope.run(async (input) => {
    await input.composition.update('一');
    await input.composition.commit();
  });
  assert.deepEqual(
    sent.filter((method) => method.endsWith('.enable') || method === 'DOM.getDocument'),
    [],
  );
  assert.equal(sent.filter((method) => method === 'Page.createIsolatedWorld').length, 1);
  const state = await session.send('Runtime.evaluate', {
    expression: '({ hits: window.hits, value: document.querySelector("#editor").value })',
    returnByValue: true,
  });
  assert.deepEqual(state.result.value, { hits: 0, value: '中文一' });
  // A navigation replaces the probe world; the next composition creates a fresh one.
  await session.send('Page.navigate', { url: 'data:text/html,<input autofocus>' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await scope.run(async (input) => {
    await input.composition.update('再');
    await input.composition.commit();
  });
  assert.equal(sent.filter((method) => method === 'Page.createIsolatedWorld').length, 2);
});

const EDITORS = `<input id=text><input id=readonly readonly><input id=date type=date><textarea id=area></textarea>
<div id=rich contenteditable><span id=nested tabindex=0>x</span><b id=locked contenteditable=false tabindex=0>y</b></div>
<div id=plain tabindex=0></div><select id=choice><option>a</option></select>
<x-open id=open></x-open><x-closed id=closed></x-closed><x-closed id=bare tabindex=0 data-empty></x-closed>
<iframe id=design srcdoc="<body></body>"></iframe>
<script>
customElements.define('x-open', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<input id=inner>'; } });
const closedRoots = new Map();
customElements.define('x-closed', class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: 'closed' }); if (!this.hasAttribute('data-empty')) root.innerHTML = '<input id=a><input id=b>'; closedRoots.set(this.id, root); } });
window.focusClosed = (host, id) => closedRoots.get(host).getElementById(id).focus();
window.closedValue = (host, id) => closedRoots.get(host).getElementById(id).value;
</script>`;

test('composition requires an editable focus and follows closed shadow roots and frames', async () => {
  const sent: string[] = [];
  await using browser = await Browser.launch({
    headless: true,
    observe: { onSend: ({ method }) => void sent.push(method) },
  });
  const tab = await browser.newTab('data:text/html,' + encodeURIComponent(EDITORS));
  await tab.waitForFunction('document.readyState === "complete" && !!window.focusClosed');
  await tab.evaluate(() => {
    document.querySelector<HTMLIFrameElement>('#design')!.contentDocument!.designMode = 'on';
  });
  const focus: Record<string, string> = {
    text: "document.getElementById('text').focus()",
    area: "document.getElementById('area').focus()",
    rich: "document.getElementById('rich').focus()",
    nested: "document.getElementById('nested').focus()",
    open: "document.getElementById('open').shadowRoot.getElementById('inner').focus()",
    closed: "focusClosed('closed', 'a')",
    design: "document.getElementById('design').focus()",
    nothing: 'document.activeElement.blur()',
    readonly: "document.getElementById('readonly').focus()",
    date: "document.getElementById('date').focus()",
    plain: "document.getElementById('plain').focus()",
    locked: "document.getElementById('locked').focus()",
    choice: "document.getElementById('choice').focus()",
    bare: "document.getElementById('bare').focus()",
  };
  const read: Record<string, string> = {
    text: "document.getElementById('text').value",
    area: "document.getElementById('area').value",
    rich: "document.getElementById('rich').textContent",
    nested: "document.getElementById('rich').textContent",
    open: "document.getElementById('open').shadowRoot.getElementById('inner').value",
    closed: "closedValue('closed', 'a')",
    design: "document.getElementById('design').contentDocument.body.textContent",
  };
  for (const [name, text] of [
    ['text', '甲'],
    ['area', '乙'],
    ['rich', '丙'],
    ['nested', '丁'],
    ['open', '戊'],
    ['closed', '己'],
    ['design', '庚'],
  ] as const) {
    await tab.evaluate(focus[name]!);
    await tab.keyboard.compose(async (ime) => {
      await ime.update(text);
      await ime.commit();
    });
    assert.match(String(await tab.evaluate(read[name]!)), new RegExp(text), name);
  }
  for (const name of ['nothing', 'readonly', 'date', 'plain', 'locked', 'choice', 'bare']) {
    await tab.evaluate(focus[name]!);
    const before = sent.filter((method) => method === 'Input.imeSetComposition').length;
    const error = await tab.keyboard
      .compose(async (ime) => {
        await ime.update('错');
      })
      .catch((e) => e);
    assert.ok(error instanceof InputActionError, name);
    assert.match(String(error.cause), /editable focused element/, name);
    await error.cleanup;
    assert.equal(
      sent.filter((method) => method === 'Input.imeSetComposition').length,
      before,
      name,
    );
  }
});

test('raw composition inside a closed shadow root detects a focus move without page-visible probes or the DOM domain', async () => {
  const sent: string[] = [];
  await using browser = await Browser.launch({
    headless: true,
    attach: 'none',
    observe: { onSend: ({ method }) => void sent.push(method) },
  });
  const { targetId } = await browser.cdp.send('Target.createTarget', {
    url: 'data:text/html,' + encodeURIComponent(EDITORS),
  });
  const session = await browser.attachSession(targetId);
  const events: string[] = [];
  session.onAny(({ method }) => void events.push(method));
  await session.send('Page.bringToFront');
  for (let i = 0; ; i++) {
    const ready = await session.send('Runtime.evaluate', {
      expression: '!!window.focusClosed',
      returnByValue: true,
    });
    if (ready.result.value === true) break;
    assert.ok(i < 100, 'editor page did not load');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Count every main-world use of the DOM API the probes rely on.
  await session.send('Runtime.evaluate', {
    expression: `window.hits = 0;
      const count = (proto, name) => {
        const own = Object.getOwnPropertyDescriptor(proto, name);
        if (!own) throw new Error('missing ' + name);
        Object.defineProperty(proto, name, own.get
          ? { configurable: true, get() { window.hits++; return own.get.call(this); } }
          : { configurable: true, writable: true, value: function (...args) { window.hits++; return own.value.apply(this, args); } });
      };
      for (const [proto, name] of [[Document.prototype, 'activeElement'], [ShadowRoot.prototype, 'activeElement'], [ShadowRoot.prototype, 'host'], [Node.prototype, 'isConnected'], [Node.prototype, 'getRootNode'], [Element.prototype, 'matches'], [Element.prototype, 'localName'], [Element.prototype, 'shadowRoot'], [HTMLElement.prototype, 'isContentEditable'], [HTMLInputElement.prototype, 'type'], [HTMLIFrameElement.prototype, 'contentDocument']]) count(proto, name);
      focusClosed('closed', 'a');
      window.hits = 0;`,
  });
  const scope = browser.inputScope(session, { pageEvents: false });
  await scope.run(async (input) => {
    await input.composition.update('中');
    await input.composition.commit();
  });
  const value = (id: string) =>
    session
      .send('Runtime.evaluate', {
        expression: `closedValue('closed', '${id}')`,
        returnByValue: true,
      })
      .then((r) => r.result.value);
  const hits = await session.send('Runtime.evaluate', {
    expression: 'window.hits',
    returnByValue: true,
  });
  assert.equal(hits.result.value, 0);
  assert.equal(await value('a'), '中');
  // A focus move from a to b inside the same closed root stops the commit.
  const error = await scope
    .run(async (input) => {
      await input.composition.update('文');
      await session.send('Runtime.evaluate', { expression: "focusClosed('closed', 'b')" });
      await input.composition.commit();
    })
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.match(String(error.cause), /lost focus/);
  await error.cleanup;
  assert.equal(await value('b'), '');
  assert.equal(sent.filter((method) => method === 'Input.insertText').length, 1);
  assert.deepEqual(
    sent.filter((method) => method.endsWith('.enable') || method === 'DOM.getDocument'),
    [],
  );
  // The DOM domain is really off: no DOM events after a navigation, and DOM.disable refuses.
  await session.send('Page.navigate', { url: 'data:text/html,<p>next' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(
    events.filter((method) => method.startsWith('DOM.')),
    [],
  );
  await assert.rejects(session.send('DOM.disable'), /hasn't been enabled/);
});

test('focus in a cross-origin frame has unknown editability, is composed and is noted', async (t) => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html;charset=utf-8');
    response.end(
      request.url === '/child'
        ? '<input id=child>'
        : `<iframe src="http://127.0.0.1:${port}/child"></iframe>`,
    );
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  await using browser = await Browser.launch({ headless: true });
  const tab = await browser.newTab(`http://localhost:${port}/`);
  const child = await (async () => {
    for (let i = 0; ; i++) {
      const frame = tab.frames.find((f) => f.url.endsWith('/child'));
      if (frame && (await frame.evaluate('!!document.getElementById("child")'))) return frame;
      assert.ok(i < 100, 'cross-origin frame did not load');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  await child.evaluate('document.getElementById("child").focus()');
  const report = await tab.keyboard.compose(async (ime) => {
    await ime.update('跨');
    await ime.commit();
  });
  assert.equal(await child.evaluate('document.getElementById("child").value'), '跨');
  assert.ok(report.trace.some((entry) => entry.type === 'compositionFocusUnknown'));
  // Through the frame's own target session, focus is checked inside the frame.
  await browser.inputScope(child.session).run(async (input) => {
    await input.composition.update('域');
    await input.composition.commit();
  });
  assert.equal(await child.evaluate('document.getElementById("child").value'), '跨域');
});

for (const selection of ['range', 'caret'] as const) {
  test(`forceCancel after a later focus move to an editor with a ${selection} keeps its text`, async () => {
    await using browser = await Browser.launch({ headless: true });
    const tab = await browser.newTab('data:text/html,<input id=a><input id=b value=abc>');
    await tab.evaluate("document.getElementById('a').focus()");
    const session = await browser.attachSession(tab.id);
    const scope = browser.inputScope(session, { pageEvents: false });
    const error = await scope
      .run(
        async (input) => {
          await input.composition.update('文');
          // Moving focus after the composition exists makes Chrome finish it into a.
          await session.send('Runtime.evaluate', {
            expression: `const b = document.getElementById('b'); b.focus(); ${
              selection === 'range' ? 'b.select()' : 'b.setSelectionRange(3, 3)'
            }`,
          });
          await input.composition.commit();
        },
        { forceCancel: true },
      )
      .catch((e) => e);
    assert.ok(error instanceof InputActionError);
    const cleanup = await error.cleanup;
    const values = () =>
      tab.evaluate("[document.getElementById('a').value, document.getElementById('b').value]");
    // Without a composition an empty cancel deletes a selection, so it is sent only at a caret.
    assert.deepEqual(await values(), ['文', 'abc']);
    assert.equal(cleanup.status, selection === 'range' ? 'failed' : 'completed');
    if (selection === 'range') {
      const blocked = await tab.keyboard.insertText('x').catch((e) => e);
      assert.ok(blocked.cause instanceof InputBlockedError);
      await blocked.cleanup;
      assert.equal(await scope.recoverComposition(), true);
    }
    await tab.keyboard.insertText('!');
    assert.deepEqual(await values(), ['文', selection === 'range' ? '!' : 'abc!']);
  });
}
