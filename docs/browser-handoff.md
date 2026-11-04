# Browser handoff and CDP events

[简体中文](zh-CN/browser-handoff.md)

The package and examples require Node.js 24.22.0+. Use `await using` or `try/finally` with `close()`, closing child resources before their Browser.

`nodriver-ts` can be used directly as an in-process library. Browser handoff does not go through MCP and does not change the MCP protocol version.

## Launch, hand off and reconnect

```ts
import { writeFile, readFile } from 'node:fs/promises';
import { Browser } from 'nodriver-ts';

// First run: keep the browser on success; on failure, await using still cleans up.
{
  await using browser = await Browser.launch({
    detached: true,
    transport: 'websocket',
    userDataDir: './exam-profile',
  });
  const tab = browser.tabs[0]!;
  // Do the application's own work.
  // Save the endpoint first, so a failed write after a successful release cannot lose it.
  await writeFile('./browser-endpoint.json', JSON.stringify(browser.endpoint));
  const endpoint = await browser.release();
  console.log(endpoint);
}

// Next run: connect does not take ownership of the Chrome process; close only disconnects.
{
  const endpoint = JSON.parse(await readFile('./browser-endpoint.json', 'utf8')) as string;
  await using browser = await Browser.connect({ endpoint });
  console.log(browser.tabs.map((tab) => ({ id: tab.id, url: tab.url })));
}
```

`detached` is `false` by default: Chrome ends when the host exits, whether normally, through `process.exit()` or after an uncaught exception. SIGINT and SIGTERM terminate a host without that exit path, so they close Chrome only with `handleSignals: true`. If the host is killed outright, a pipe Chrome exits when its pipe closes and Windows ends Chrome together with the host, but a WebSocket Chrome on macOS or Linux keeps running.

With `detached: true` and without `supervised`, Chrome is spawned detached on every platform, with stdin/stdout/stderr not tied to host pipes, so its stderr does not reach launch diagnostics. Supervised mode instead captures bounded stderr through an independent helper. CDP uses WebSocket, and the debugging port must stay available for as long as the browser lives.

`release()` is idempotent and returns the browser's WebSocket endpoint. It does not send `Browser.close`, kill the process, close tabs or delete the profile; it removes signal cleanup, unrefs the child process from Node's event loop and disconnects CDP. Afterwards `browser.owned === false` and `browser.closed === true` (for this connection), and neither `close()`, `Symbol.asyncDispose` nor the original `browser.process.close()` terminates Chrome. Old Tab/Session objects can no longer be used; reconnect to get new ones.

Once `close()` has been called, even if it failed, `release()` rejects. It also rejects when Chrome has already exited, since there is nothing to hand off; `close()` still confirms the exit. A `close()` called while `release()` is in progress waits for the handoff and then only disconnects.

An owned browser can be handed off only if it was launched with `detached: true` explicitly. A browser from `Browser.connect()` can also call `release()`, which just disconnects and returns the endpoint. A plain `disconnect()` keeps ownership of an owned process, so a later `close()` still cleans it up; a detached launch can still call `release()` after disconnecting.

Pipe mode cannot be handed off, because Chrome exits when its CDP pipe closes: `release()` rejects a pipe instance before disconnecting, and `detached: true` with `transport: 'pipe'` is rejected before launch. A context created with `newContext({ proxy })` depends on this process's `ProxyForwarder` and ends with the connection that created it, so it also makes handoff reject. Close that context first, or use an external `proxyServer` that can outlive the process.

## Profile and process responsibilities

- `.nodriver.lock` records the nodriver controller's ownership of a persistent profile and contains the host PID and host name. Handoff closes the lock handle and deletes the file rather than passing it off as Chrome's lock.
- `DevToolsActivePort` is kept. A new `launch({ userDataDir })` probes it; if the same browser is still serving, launch is refused with a hint to use `connect()`. Chrome's own profile lock is still managed by Chrome.
- A temporary profile is also kept; save its path from `browser.process!.profile` before handoff. Cleaning it up becomes the caller's job, and only after confirming that Chrome has fully exited. Persistent profiles are never deleted automatically.
- `Browser.connect().close()` does not terminate Chrome. To end Chrome, the user closes the browser or the caller sends `browser.cdp.send('Browser.close')` explicitly; a connection-closed error may arrive as it disconnects.
- An endpoint is valid only for that one Chrome lifetime. After the browser exits, launch again and save the new endpoint.

Plain detached mode provides no process supervision: if the host dies before release, Chrome may be left behind. Add `supervised: true` for a Windows Job Object or macOS/Linux process-group helper and bounded startup stderr. Readiness alone does not hand off ownership; only an explicit release does. See [supervised ownership](lifecycle-ownership-design.md) for platform limits and release error handling.

A detached launch does not resist termination of an external process tree either. On Windows, for example, a higher layer can still kill a handed-off Chrome with `taskkill /T /F`, so handoff cannot work around an MCP host that force-kills process trees.

## Screencasts and target events

`tab.cdp` and `browser.cdp` are typed `Session`s that support `send`, `sendWith`, `on`, `onAny` and `waitFor`. `on` returns an unsubscribe function. Register event waits before sending the command that triggers them.

```ts
const stopFrames = tab.cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
  try {
    // data is a base64-encoded image frame; hand it to the application's own recording queue.
    console.log('frame bytes (base64):', data.length);
  } finally {
    await tab.cdp.send('Page.screencastFrameAck', { sessionId });
  }
});
await tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80 });
// Keep the subscription while recording; every frame must be acked.
await tab.cdp.send('Page.stopScreencast');
stopFrames();
```

Browser initialization already enables target discovery, so you can subscribe directly:

```ts
const offCreated = browser.cdp.on('Target.targetCreated', ({ targetInfo }) => {
  console.log('created', targetInfo);
});
const offChanged = browser.cdp.on('Target.targetInfoChanged', ({ targetInfo }) => {
  console.log('changed', targetInfo);
});
const offDestroyed = browser.cdp.on('Target.targetDestroyed', ({ targetId }) => {
  console.log('destroyed', targetId);
});
// When done, call offCreated(), offChanged() and offDestroyed().
```

`browser.tabCreated.on(...)` fires once a Tab has been attached and initialized; the raw `Target.targetCreated` fires earlier, possibly before a usable Tab exists. `pageTargets` includes pages that the attach policy did not attach automatically; attach them with `attachTarget(id)`.

## Focus limits

The library has no high-level event for "the user switched the active tab", and target info changes are not focus changes. `browser.frontTab` only caches the Tab this client most recently brought to the front; it is not an authoritative focus state from the OS or Chrome's UI.

`tab.bringToFront()` brings a tab to the front; `tab.activate()` does so only when that cache names another tab. To check the current state after the user switches tabs, use `tab.evaluate('document.hasFocus()')` and read `document.visibilityState` as needed. For a continuous record, have the application listen for `focus`, `blur` and `visibilitychange` in the document, push them to a queue and read the queue, reinstalling the listeners after each navigation. This is limited by sampling, navigation and page event semantics and does not replace an OS-level focus watcher.

None of the target and screencast subscriptions above require `Runtime.enable`. The main world is obtained through the Document and `DOM.resolveNode`, and no Runtime events are enabled by default to wait for.
