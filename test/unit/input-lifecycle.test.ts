import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ScriptedChrome, NO_REPLY } from '../../src/testing/index.ts';
import {
  Connection,
  createInputScope,
  Mouse,
  Keyboard,
  Element,
  InputActionError,
  InputBlockedError,
  TimeoutError,
  type InputReport,
  type ScopedInput,
  type Transport,
} from '../../src/index.ts';
class ManualTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason: Error) => void;
  commands: Array<{ id: number; method: string; sessionId?: string }> = [];
  send(message: string): void {
    this.commands.push(JSON.parse(message));
  }
  close(): void {}
  reply(index: number, result: unknown = {}): void {
    const { id, sessionId } = this.commands[index]!;
    this.onmessage?.(JSON.stringify({ id, sessionId, result }));
  }
}
async function checkpoint(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function interrupted(promise: Promise<unknown>): Promise<InputActionError> {
  const error = await promise.catch((error) => error);
  assert.ok(error instanceof InputActionError);
  return error;
}
for (const kind of ['move', 'insert', 'key', 'wheel'] as const) {
  test(
    kind + ': action deadline settles before a delayed ACK, queue remains owned until drain',
    async () => {
      await using chrome = await ScriptedChrome.start();
      await using browser = await chrome.connect({ attach: 'none' });
      const session = await browser.attachSession([...browser.targetInfo.values()][0]!.targetId);
      const mouse = new Mouse(session),
        keyboard = new Keyboard(session);
      const reply = gate(),
        sent = gate();
      const method =
        kind === 'insert'
          ? 'Input.insertText'
          : kind === 'key'
            ? 'Input.dispatchKeyEvent'
            : 'Input.dispatchMouseEvent';
      chrome.handle(method, async () => {});
      chrome.handle('Input.dispatchMouseEvent', () => {});
      chrome.replyOnce(method, async () => {
        sent.resolve();
        await reply.promise;
        return;
      });
      const options = { timeout: 70, cleanupTimeout: 1000 };
      const calls: Record<typeof kind, () => Promise<InputReport>> = {
        move: () => mouse.move(10, 20, options),
        insert: () => keyboard.insertText('once', options),
        key: () => keyboard.press('a', options),
        wheel: () => mouse.wheel(0, 10, options),
      };
      const failure = interrupted(calls[kind]());
      await sent.promise;
      const error = await failure;
      assert.ok(error.cause instanceof TimeoutError);
      assert.equal(error.report.cleanup, 'pending');
      assert.ok(browser.connection.unansweredCount > 0);
      let nextDone = false;
      const next = mouse.move(30, 40).then(() => {
        nextDone = true;
      });
      await sleep(20);
      assert.equal(nextDone, false);
      reply.resolve();
      assert.equal((await error.cleanup).status, 'completed');
      await next;
      const sentInput = chrome.commands.filter((c) => c.method === method);
      assert.equal(sentInput.length, kind === 'key' || kind === 'move' || kind === 'wheel' ? 2 : 1);
    },
  );
}
test('abort retains reason, cleanup timeout blocks the connection queue without clearing wire debt', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.values()][0]!.targetId);
  const mouse = new Mouse(session),
    sent = gate(),
    controller = new AbortController();
  chrome.handle('Input.dispatchMouseEvent', () => {
    sent.resolve();
    return NO_REPLY;
  });
  const failure = interrupted(mouse.move(1, 2, { signal: controller.signal, cleanupTimeout: 40 }));
  await sent.promise;
  const reason = new Error('stop input');
  controller.abort(reason);
  const error = await failure;
  assert.equal(error.cause, reason);
  assert.equal((await error.cleanup).status, 'failed');
  const blocked = await interrupted(mouse.move(3, 4));
  assert.ok(blocked.cause instanceof InputBlockedError);
  assert.equal(browser.connection.unansweredCount, 1);
  assert.equal(chrome.commands.filter((c) => c.method.startsWith('Input.')).length, 1);
});
test('pre-abort and queued abort send nothing; a guard cannot outlive its input deadline', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.values()][0]!.targetId);
  const mouse = new Mouse(session),
    controller = new AbortController(),
    reason = new Error('stop');
  controller.abort(reason);
  assert.equal((await interrupted(mouse.move(1, 1, { signal: controller.signal }))).cause, reason);
  const hold = gate(),
    entered = gate();
  const owner = browser.input.run(async () => {
    entered.resolve();
    await hold.promise;
  });
  await entered.promise;
  const queuedAbort = new AbortController();
  const queued = interrupted(mouse.move(2, 2, { signal: queuedAbort.signal }));
  queuedAbort.abort(reason);
  assert.equal((await queued).cause, reason);
  hold.resolve();
  await owner;
  const guard = gate();
  const failure = await interrupted(mouse.move(3, 3, { timeout: 20, guard: () => guard.promise }));
  assert.ok(failure.cause instanceof TimeoutError);
  guard.resolve();
  await failure.cleanup;
  await sleep(10);
  assert.equal(chrome.commands.filter((c) => c.method.startsWith('Input.')).length, 0);
});
test('scope releases held resources in reverse order; raw sessions and Tab share the same queue', async () => {
  await using chrome = await ScriptedChrome.start();
  chrome.handle('Page.bringToFront', () => {});
  chrome.handle('Input.dispatchMouseEvent', () => {});
  chrome.handle('Input.dispatchKeyEvent', () => {});
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  const session = await browser.attachSession(tab.id);
  const other = await browser.attachSession(tab.id);
  const held = gate(),
    resume = gate();
  const scope = browser.inputScope(session).run(async (input) => {
    await input.keyboard.down('Control');
    await input.mouse.down();
    held.resolve();
    await resume.promise;
  });
  await held.promise;
  const next = tab.keyboard.insertText('tab');
  const raw = browser.inputScope(other).run(async (input) => {
    await input.keyboard.insertText('raw');
  });
  chrome.handle('Input.insertText', () => {});
  await sleep(15);
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 0);
  resume.resolve();
  await Promise.all([scope, next, raw]);
  const events = chrome.commands
    .filter((c) => c.method.startsWith('Input.'))
    .map(
      (c) =>
        (c.params as { type?: string; text?: string }).type ?? (c.params as { text?: string }).text,
    );
  assert.deepEqual(events, ['rawKeyDown', 'mousePressed', 'mouseReleased', 'keyUp', 'tab', 'raw']);
  assert.deepEqual(
    chrome.commands
      .filter((c) => c.method === 'Input.dispatchMouseEvent')
      .map((c) => (c.params as { modifiers: number }).modifiers),
    [2, 2],
  );
});
test('scope cancellation releases without the aborted signal and waits for cleanup ACK before the next action', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.values()][0]!.targetId);
  const controller = new AbortController(),
    held = gate(),
    releaseReply = gate(),
    releaseSent = gate();
  chrome.handle('Input.dispatchKeyEvent', async (params) => {
    if (params.type === 'keyUp') {
      releaseSent.resolve();
      await releaseReply.promise;
    }
    return;
  });
  chrome.handle('Input.insertText', () => {});
  const failure = interrupted(
    browser.inputScope(session).run(
      async (input) => {
        await input.keyboard.down('Shift');
        held.resolve();
        await input.wait(5000);
      },
      { signal: controller.signal },
    ),
  );
  await held.promise;
  controller.abort();
  const error = await failure;
  await releaseSent.promise;
  const next = new Keyboard(session).insertText('next');
  await sleep(15);
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 0);
  releaseReply.resolve();
  assert.equal((await error.cleanup).status, 'completed');
  await next;
});
test('release failures preserve the action cause and block later input', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.values()][0]!.targetId);
  chrome.handle('Input.dispatchKeyEvent', (params) => {
    if (params.type === 'keyUp') throw new Error('release refused');
    return;
  });
  const cause = new Error('caller failure');
  const error = await interrupted(
    browser.inputScope(session).run(async (input) => {
      await input.keyboard.down('Control');
      throw cause;
    }),
  );
  assert.equal(error.cause, cause);
  const cleanup = await error.cleanup;
  assert.equal(cleanup.status, 'failed');
  assert.equal(cleanup.report.cleanupErrors.length, 1);
  assert.ok(
    (await interrupted(new Keyboard(session).insertText('no'))).cause instanceof InputBlockedError,
  );
});
test('a closed page ends the input state it held; connection loss is not successful cleanup', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{}, {}] });
  await using browser = await chrome.connect({ attach: 'none' });
  const [first, second] = [...browser.targetInfo.values()];
  const closing = await browser.attachSession(first!.targetId),
    other = await browser.attachSession(second!.targetId);
  let sent = gate();
  chrome.handle('Input.insertText', () => {
    sent.resolve();
    return NO_REPLY;
  });
  const closed = interrupted(new Keyboard(closing).insertText('once', { cleanupTimeout: 100 }));
  await sent.promise;
  chrome.destroyTarget(closing.targetId);
  const error = await closed;
  assert.match(String(error.cause), /Target session ended/);
  // The unanswered request died with its page; managed input on the connection continues.
  assert.equal((await error.cleanup).status, 'completed');
  assert.equal(browser.input.blocked, undefined);
  sent = gate();
  const lost = interrupted(new Keyboard(other).insertText('twice', { cleanupTimeout: 100 }));
  await sent.promise;
  chrome.disconnect();
  assert.equal((await (await lost).cleanup).status, 'disconnected');
});

test('a JavaScript dialog pauses the cleanup budget until it closes', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.values()][0]!.targetId);
  const sent = gate(),
    reply = gate();
  // Chrome holds the reply to input a page was handling until its dialog closes.
  chrome.handle('Input.insertText', async () => {
    sent.resolve();
    await reply.promise;
  });
  const failure = interrupted(
    new Keyboard(session).insertText('confirm', { timeout: 50, cleanupTimeout: 100 }),
  );
  await sent.promise;
  chrome.emit(
    'Page.javascriptDialogOpening',
    {
      url: 'about:blank',
      frameId: session.targetId,
      message: '?',
      type: 'confirm',
      hasBrowserHandler: false,
    },
    session.id,
  );
  const error = await failure;
  let settled = false;
  void error.cleanup.then(() => {
    settled = true;
  });
  await sleep(300);
  assert.equal(settled, false);
  chrome.emit(
    'Page.javascriptDialogClosed',
    { frameId: session.targetId, result: true, userInput: '' },
    session.id,
  );
  reply.resolve();
  const { status, report } = await error.cleanup;
  assert.equal(status, 'completed');
  assert.ok(report.trace.some((entry) => entry.type === 'dialogWait'));
  assert.equal(browser.input.blocked, undefined);
});

for (const method of [
  'Page.bringToFront',
  'Page.createIsolatedWorld',
  'DOM.resolveNode',
  'DOM.scrollIntoViewIfNeeded',
] as const) {
  test('Element input shares the deadline during ' + method, async () => {
    await using chrome = await ScriptedChrome.start();
    chrome.handle('Page.bringToFront', () => {});
    chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
    chrome.handle('DOM.resolveNode', () => ({ object: { type: 'object', objectId: 'node' } }));
    chrome.handle('Runtime.callFunctionOn', () => ({ result: { type: 'boolean', value: true } }));
    chrome.handle('Runtime.releaseObjectGroup', () => {});
    chrome.handle('Input.insertText', () => {});
    await using browser = await chrome.connect();
    const tab = browser.tabs[0]!,
      sent = gate(),
      reply = gate();
    chrome.replyOnce(method, async () => {
      sent.resolve();
      await reply.promise;
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'DOM.resolveNode') return { object: { type: 'object', objectId: 'node' } };
      return;
    });
    const element = new Element(tab.mainFrame, 1, tab.mainFrame.generation, tab.session);
    const operation =
      method === 'DOM.scrollIntoViewIfNeeded'
        ? element.click({ timeout: 70 })
        : element.fill('never replay', { timeout: 70 });
    const failure = interrupted(operation);
    await sent.promise;
    const error = await failure;
    assert.ok(error.cause instanceof TimeoutError);
    let nextDone = false;
    const next = tab.keyboard.insertText('next').then(() => {
      nextDone = true;
    });
    await sleep(15);
    assert.equal(nextDone, false);
    reply.resolve();
    assert.equal((await error.cleanup).status, 'completed');
    await next;
    assert.deepEqual(
      chrome.commands.filter((c) => c.method === 'Input.insertText').map((c) => c.params),
      [{ text: 'next' }],
    );
  });
}

test('standalone held inputs survive success but release if the final guard rejects', async () => {
  await using chrome = await ScriptedChrome.start();
  chrome.handle('Input.dispatchKeyEvent', () => {});
  chrome.handle('Input.dispatchMouseEvent', () => {});
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const keyboard = new Keyboard(session),
    mouse = new Mouse(session);
  await keyboard.down('Shift');
  assert.deepEqual(keyboard.pressedKeys, ['Shift']);
  await keyboard.up('Shift');
  assert.deepEqual(keyboard.pressedKeys, []);
  const reason = new Error('guard after down');
  const error = await interrupted(
    keyboard.down('Control', {
      guard: () => {
        if (
          chrome.commands.some(
            (c) =>
              c.method === 'Input.dispatchKeyEvent' &&
              (c.params as { key: string }).key === 'Control',
          )
        )
          throw reason;
      },
    }),
  );
  assert.equal(error.cause, reason);
  await error.cleanup;
  assert.deepEqual(keyboard.pressedKeys, []);
  await mouse.down();
  assert.equal(mouse.position.buttons, 1);
  await mouse.up();
  const mouseError = await interrupted(
    mouse.down('right', {
      guard: () => {
        if (
          chrome.commands.some(
            (c) =>
              c.method === 'Input.dispatchMouseEvent' &&
              (c.params as { button: string }).button === 'right',
          )
        )
          throw reason;
      },
    }),
  );
  await mouseError.cleanup;
  assert.equal(mouse.position.buttons, 0);
});

test('scope serializes sibling calls, releases a repeated held key once, and seals escaped controllers', async () => {
  await using chrome = await ScriptedChrome.start();
  chrome.handle('Input.dispatchKeyEvent', () => {});
  chrome.handle('Input.insertText', () => {});
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  let escaped!: ScopedInput;
  const reply = gate(),
    sent = gate();
  chrome.replyOnce('Input.insertText', async () => {
    sent.resolve();
    await reply.promise;
  });
  const scope = browser.inputScope(session).run(async (input) => {
    escaped = input;
    await input.keyboard.down('Shift');
    await input.keyboard.down('Shift');
    await Promise.all([input.keyboard.insertText('first'), input.keyboard.insertText('second')]);
  });
  await sent.promise;
  await sleep(10);
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 1);
  reply.resolve();
  await scope;
  assert.equal(
    chrome.commands.filter(
      (c) =>
        c.method === 'Input.dispatchKeyEvent' && (c.params as { type: string }).type === 'keyUp',
    ).length,
    1,
  );
  await assert.rejects(escaped.keyboard.insertText('escaped'), InputBlockedError);
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 2);
});

test('scope refuses click while held and releases the original button exactly once', async () => {
  await using chrome = await ScriptedChrome.start();
  chrome.handle('Input.dispatchMouseEvent', () => {});
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const error = await interrupted(
    browser.inputScope(session).run(async (input) => {
      await input.mouse.down();
      await input.mouse.click(10, 10);
    }),
  );
  assert.equal((await error.cleanup).status, 'completed');
  assert.deepEqual(
    chrome.commands
      .filter((c) => c.method === 'Input.dispatchMouseEvent')
      .map((c) => (c.params as { type: string }).type),
    ['mousePressed', 'mouseReleased'],
  );
});

test('nested input cancellation keeps an enclosing withInput lock through cleanup', async () => {
  await using chrome = await ScriptedChrome.start();
  chrome.handle('Page.bringToFront', () => {});
  chrome.handle('Input.insertText', () => {});
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!,
    reply = gate();
  chrome.replyOnce('Input.insertText', async () => {
    await reply.promise;
  });
  let captured!: InputActionError;
  const owner = tab.withInput(async () => {
    captured = await interrupted(tab.keyboard.insertText('once', { timeout: 30 }));
  });
  await sleep(70);
  let nextDone = false;
  const next = tab.keyboard.insertText('next').then(() => {
    nextDone = true;
  });
  await sleep(15);
  assert.equal(nextDone, false);
  reply.resolve();
  await owner;
  assert.equal((await captured.cleanup).status, 'completed');
  await next;
});

test('a cancelled queued scope step interrupts promptly and never runs behind its sibling', async () => {
  await using chrome = await ScriptedChrome.start();
  chrome.handle('Input.insertText', () => {});
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const sent = gate(),
    reply = gate(),
    queued = gate(),
    controller = new AbortController();
  chrome.replyOnce('Input.insertText', async () => {
    sent.resolve();
    await reply.promise;
  });
  const errorPromise = interrupted(
    browser.inputScope(session).run(async (input) => {
      const first = input.keyboard.insertText('first');
      const second = input.keyboard.insertText('cancelled', { signal: controller.signal });
      queued.resolve();
      await Promise.all([first, second]);
    }),
  );
  await Promise.all([sent.promise, queued.promise]);
  const reason = new Error('cancel queued step');
  controller.abort(reason);
  const error = await errorPromise;
  assert.equal(error.cause, reason);
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 1);
  reply.resolve();
  assert.equal((await error.cleanup).status, 'completed');
});

test('abort during final cleanup returns promptly while release still owns the queue', async () => {
  await using chrome = await ScriptedChrome.start();
  const releaseSent = gate(),
    reply = gate(),
    controller = new AbortController();
  chrome.handle('Input.dispatchKeyEvent', async (params) => {
    if (params.type === 'keyUp') {
      releaseSent.resolve();
      await reply.promise;
    }
  });
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const pending = interrupted(
    browser.inputScope(session).run(
      async (input) => {
        await input.keyboard.down('Shift');
      },
      { signal: controller.signal },
    ),
  );
  await releaseSent.promise;
  const reason = new Error('stop waiting during cleanup');
  controller.abort(reason);
  const error = await pending;
  assert.equal(error.cause, reason);
  assert.equal(error.report.cleanup, 'pending');
  reply.resolve();
  assert.equal((await error.cleanup).status, 'completed');
});

test('a cancelled scope callback cannot resume input after its cleanup and next action', async () => {
  await using chrome = await ScriptedChrome.start();
  chrome.handle('Input.insertText', () => {});
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const entered = gate(),
    resume = gate(),
    resumed = gate(),
    controller = new AbortController();
  const pending = interrupted(
    browser.inputScope(session).run(
      async (input) => {
        entered.resolve();
        await resume.promise;
        await assert.rejects(input.keyboard.insertText('escaped'), InputBlockedError);
        resumed.resolve();
      },
      { signal: controller.signal },
    ),
  );
  await entered.promise;
  controller.abort();
  const error = await pending;
  assert.equal((await error.cleanup).status, 'completed');
  await new Keyboard(session).insertText('next');
  resume.resolve();
  await resumed.promise;
  assert.deepEqual(
    chrome.commands.filter((c) => c.method === 'Input.insertText').map((c) => c.params),
    [{ text: 'next' }],
  );
});
test('input cleanup waits for its own late replies, not unrelated pending raw commands', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.values()][0]!.targetId);
  const keyboard = new Keyboard(session);
  chrome.handle('Input.insertText', () => {});
  // A long raw command, such as an awaited evaluation, stays outstanding throughout.
  const evaluated = gate();
  chrome.handle('Runtime.evaluate', async () => {
    await evaluated.promise;
    return { result: { type: 'undefined' } };
  });
  const raw = session.send('Runtime.evaluate', { expression: 'long work', awaitPromise: true });
  const report = await keyboard.insertText('unrelated', { cleanupTimeout: 100 });
  assert.equal(report.cleanup, 'completed');
  assert.equal(browser.connection.pendingCount, 1);
  // The action's own unanswered command still holds cleanup until its reply.
  const reply = gate(),
    sent = gate();
  chrome.replyOnce('Input.insertText', async () => {
    sent.resolve();
    await reply.promise;
  });
  const error = await interrupted(
    keyboard.insertText('late', { timeout: 50, cleanupTimeout: 1000 }),
  );
  await sent.promise;
  let cleaned = false;
  const cleanup = error.cleanup.then((result) => {
    cleaned = true;
    return result;
  });
  await sleep(20);
  assert.equal(cleaned, false);
  reply.resolve();
  assert.equal((await cleanup).status, 'completed');
  await keyboard.insertText('after');
  evaluated.resolve();
  await raw;
});
test('input cleanup waits for the detach that a late attach reply causes', async () => {
  const transport = new ManualTransport(),
    connection = new Connection(transport);
  try {
    let report: InputReport | undefined;
    const running = createInputScope(connection.session('page'), { pageEvents: false })
      .run(
        async () => {
          await connection.attachSession('target', { timeout: 15 }).catch(() => {});
        },
        { cleanupTimeout: 1000 },
      )
      .then((value) => {
        report = value;
      });
    while (!transport.commands.length) await checkpoint();
    await sleep(30);
    assert.equal(report, undefined);
    // The attachment arrives after its caller stopped waiting; the library detaches it.
    transport.reply(0, { sessionId: 'late-attachment' });
    await checkpoint();
    const detach = transport.commands.findIndex((c) => c.method === 'Target.detachFromTarget');
    assert.ok(detach > 0);
    await sleep(20);
    assert.equal(report, undefined);
    transport.reply(detach);
    await running;
    assert.equal(report!.cleanup, 'completed');
    assert.equal(connection.unansweredCount, 0);
  } finally {
    await connection.close();
  }
});
test('input cleanup covers raw commands the action sends on another connection', async () => {
  const input = new ManualTransport(),
    other = new ManualTransport();
  const inputConnection = new Connection(input),
    otherConnection = new Connection(other);
  try {
    const scope = createInputScope(inputConnection.session('page'), { pageEvents: false });
    const work = async () => {
      await otherConnection.root
        .sendWith('Runtime.evaluate', { timeout: 15 }, { expression: 'action-owned work' })
        .catch(() => {});
    };
    let report: InputReport | undefined;
    const running = scope.run(work, { cleanupTimeout: 1000 }).then((value) => {
      report = value;
    });
    while (!other.commands.length) await checkpoint();
    await sleep(30);
    assert.equal(report, undefined);
    assert.equal(otherConnection.unansweredCount, 1);
    other.reply(0);
    await running;
    assert.equal(report!.cleanup, 'completed');
    // Without a reply, cleanup fails instead of reporting completion.
    const error = await interrupted(scope.run(work, { cleanupTimeout: 40 }));
    assert.equal((await error.cleanup).status, 'failed');
    assert.equal(otherConnection.unansweredCount, 1);
    assert.equal(input.commands.length, 0);
  } finally {
    await inputConnection.close();
    await otherConnection.close();
  }
});

test('another connection that closes with every reply in is not a cleanup failure', async () => {
  const input = new ManualTransport(),
    other = new ManualTransport();
  const inputConnection = new Connection(input),
    otherConnection = new Connection(other);
  try {
    const scope = createInputScope(inputConnection.session('page'), { pageEvents: false });
    const report = await scope.run(async () => {
      const answered = otherConnection.root.send('Runtime.evaluate', { expression: 'read' });
      while (!other.commands.length) await checkpoint();
      other.reply(0);
      await answered;
      await otherConnection.close();
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.cleanup, 'completed');
    // Input on the action's own connection is not blocked.
    await scope.run(async () => {});
  } finally {
    await inputConnection.close();
    await otherConnection.close();
  }
});
