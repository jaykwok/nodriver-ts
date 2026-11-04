# Scripted Chrome for library tests

[简体中文](zh-CN/testing.md)

Import `ScriptedChrome` from **`nodriver-ts/testing`** to test code against real `Browser`, `Tab`, `Frame` and `Session` instances without launching Chrome or casting a handwritten mock to a class with private fields. The package and examples require Node.js 24.22.0+.

The fixture listens on an ephemeral loopback WebSocket port. It answers the library's browser and page startup handshake, creates targets and contexts, and records commands with their parameters. It has no renderer, DOM or JavaScript engine, so application commands must be scripted. A missing expectation fails explicitly instead of silently returning `{}`.

```ts
import assert from 'node:assert/strict';
import { ScriptedChrome } from 'nodriver-ts/testing';

await using chrome = await ScriptedChrome.start();
await using browser = await chrome.connect();
const tab = browser.tabs[0]!;

chrome.replyOnce('Runtime.callFunctionOn', {
  result: { type: 'object', value: { completed: 3 } },
});
const result = await tab.cdp.send('Runtime.callFunctionOn', {
  functionDeclaration: 'function () { return { completed: 3 }; }',
  objectId: 'fixture-document',
  returnByValue: true,
});
assert.deepEqual(result.result.value, { completed: 3 });
assert.equal(chrome.commands.at(-1)!.sessionId, tab.cdp.id);
chrome.assertDone();
```

Close child resources before their Browser, and the Browser before the fixture: `await using` does this in reverse declaration order; with `try/finally`, call `close()` on each. `chrome.close()` also terminates any client still connected and is idempotent.

For raw clients use `chrome.connect({ attach: 'none' })` and `browser.attachSession(targetId)`. `chrome.detachSession(sessionId)` ends one modeled attachment; `attachReplyDelayMs` delays attach responses after the attachment is created. See [raw-session tests and lifetimes](raw-sessions.md).

## Replies and command records

- `replyOnce(method, resultOrHandler)` queues one result or handler per method. Queued replies are consumed in arrival order across all sessions, before persistent handlers or defaults.
- `handle(method, handler)` installs a persistent handler and returns an unsubscribe function. Both handler forms receive typed `(params, command)` arguments; inspect `command.sessionId` to distinguish pages. Async handlers may finish out of order, as real CDP commands can.
- `commands` contains all wire requests, including startup, with `id`, `method`, `params` and optional `sessionId`. Handler mutations do not change the recorded request. Records can contain sensitive values, so keep fixture data synthetic.
- A command outside the built-in handshake/lifecycle set that nothing handles receives a `ProtocolError` with code `-32601` and is recorded in `unexpectedCommands`.
- `assertDone()` throws if a queued reply is unused or an unexpected command was received. Persistent handlers need not be used. Call it before teardown if teardown itself is scripted.

```ts
import { ProtocolError } from 'nodriver-ts';
import { NO_REPLY } from 'nodriver-ts/testing';

const off = chrome.handle('Runtime.evaluate', (params, command) => {
  if (params.expression === 'stall') return NO_REPLY;
  if (params.expression === 'fail')
    throw new ProtocolError('Runtime.evaluate', -32000, 'fixture failure');
  return { result: { type: 'string', value: command.sessionId } };
});
// Exercise the application, then remove the persistent handler.
off();
```

Returning `NO_REPLY` leaves the real Connection request pending, for timeout, abort or disconnect tests. A thrown `ProtocolError` keeps its code and data on the wire; other thrown errors use code `-32000`. Handlers are not cancelled automatically: a result returned after its socket closed is discarded and never sent to a reconnected client.

`tab.evaluate()` still sends the library's context-discovery CDP commands, so script those too when testing that path; the fixture neither invents a DOM nor evaluates the expression. For an isolated-world evaluation:

```ts
chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 8 }));
chrome.replyOnce('Runtime.evaluate', { result: { type: 'number', value: 42 } });
assert.equal(await tab.evaluate('answer', undefined, { world: 'isolated' }), 42);
```

## Targets, events, and failures

`start()` defaults to one `about:blank` page. Pass `{ pages: [] }` for none, or `{ pages: [{ url: 'https://fixture.test/', title: 'Fixture' }] }` for initial metadata. `browser.newTab()` (without navigation) and `browser.newContext()` work with built-in replies; navigation, screenshots, input and other application operations require scripts. As in Chrome, a command for an unknown session is answered at browser level with `Session with given id not found.` (-32001), and an attach to an unknown target with `No target with given id found` (-32602).

```ts
const ready = browser.waitForTab();
const targetId = chrome.addPage({ url: 'https://fixture.test/' });
const page = await ready;

const load = page.cdp.waitFor('Page.loadEventFired');
chrome.emit('Page.loadEventFired', { timestamp: 1 }, page.cdp.id);
await load;

const crash = page.cdp.waitFor('Inspector.targetCrashed');
chrome.crashTarget(targetId);
await crash;
assert.equal(page.crashed, true);

const destroyed = browser.cdp.waitFor('Target.targetDestroyed');
chrome.destroyTarget(targetId);
await destroyed;
```

`emit(method, params, sessionId?)` sends a typed raw CDP event; omit `sessionId` for a browser event. Raw emission does **not** update the fixture's target/frame model; use `addPage`, `destroyTarget` and `crashTarget` for the modeled behavior. A crash invalidates the real Tab's frame handles but does not destroy the target. There is no simulated rendering, automatic worker/OOPIF creation or navigation engine.

`chrome.disconnect()` abruptly terminates the client socket, rejecting real pending requests and event waits. The fixture keeps its pages and contexts and accepts a later `connect()`. Only one controller may connect at a time; await `browser.close()` before reconnecting. `chrome.connect(options)` is `Browser.connect({ endpoint: chrome.endpoint, ...options })`.

## Tracing a real launched browser

`Browser.launch()` and `Browser.connect()` accept `trace: boolean | ((entry) => void)`. Callbacks receive `{ method, sessionId?, durationMs, error? }` for every command, including startup commands, protocol errors, timeouts and cancellations; `error` is the protocol error code or the error name. Parameters and results are never recorded. An explicit `trace` overrides `NODRIVER_TRACE`: `false` disables tracing, and `true` writes compact lines to stderr.

```ts
const entries: import('nodriver-ts').TraceEntry[] = [];
await using browser = await Browser.launch({ trace: (entry) => entries.push(entry) });
```
