import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect } from '../fixtures/expect.ts';
import { Browser } from '../../src/browser/browser.ts';
import { Element } from '../../src/dom/element.ts';
import { TimeoutError } from '../../src/errors.ts';
import { BrowserSessionManager, type BrowserSessionManagerOptions } from '../../src/mcp/manager.ts';
import { OperationQueue } from '../../src/mcp/queue.ts';
import { createBrowserMcpServer } from '../../src/mcp/server.ts';
import { BrowserMcpSession } from '../../src/mcp/session.ts';
import { EventHub, poll } from '../../src/utils.ts';

const free = new AbortController().signal;
/** A promise settled from outside, for an action or operation that must stay in progress. */
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fakeTab(browser: any, id = 'tab') {
  const hub = new EventHub<{ method: string; event: unknown }>();
  const session: any = {
    id: `session-${id}`,
    closed: false,
    disconnected: new EventHub(),
    on: (method: string, listener: (event: any) => void) =>
      hub.on((e) => {
        if (e.method === method) listener(e.event);
      }),
    send: async () => ({}),
    sendWith: async () => ({ nodes: [] }),
  };
  const tab: any = {
    id,
    url: 'https://fixture.test/',
    closed: false,
    browser,
    session,
    context: undefined,
    framesManager: { changes: new EventHub() },
    downloads: new EventHub(),
    inputBehavior: { policy: { mode: 'instant' } },
    network: { responses: new EventHub(), enable: async () => {} },
    setInputPolicy() {},
    withInput: (task: () => Promise<unknown>) => task(),
    activate: async () => {},
    keyboard: { press: async () => {} },
    bringToFront: async () => {
      browser.frontTab = tab;
    },
    close: async () => {
      tab.closed = true;
    },
  };
  tab.mainFrame = { id: 'frame', generation: 0, detached: false, session, tab, url: tab.url };
  tab.frames = [tab.mainFrame];
  const emit = (method: string, event: unknown = {}) => hub.emit({ method, event });
  return { tab, emit, listeners: () => hub.size };
}
function fakeBrowser() {
  const browser: any = {
    closed: false,
    owned: true,
    tabs: [],
    tabCreated: new EventHub(),
    input: {},
    close: async () => {
      browser.closed = true;
    },
  };
  return browser;
}
/** A session on one fake tab, past its lazy browser start. */
async function opened(options: { operationTimeout?: number; uploadDir?: string } = {}) {
  const browser = fakeBrowser();
  const fake = fakeTab(browser);
  browser.tabs.push(fake.tab);
  const allocation = new OperationQueue();
  const session = new BrowserMcpSession({
    ...options,
    acquire: async () => ({ browser, queue: allocation, release: async () => {} }),
  });
  await session.run(free, async () => {}, true);
  return { session, browser, allocation, ...fake };
}
const dialog = { type: 'confirm', message: 'Proceed?', defaultPrompt: '' };
const types = (session: BrowserMcpSession) => session.eventLog().events.map((event) => event.type);

test('an action interrupted by a dialog returns at once and keeps both queues until it settles', async () => {
  const { session, tab, emit, allocation, listeners } = await opened();
  const action = deferred<string>();
  const reply = await session.run(free, (signal) =>
    session.act(tab, { waitFor: 'auto', timeout: 5000, signal }, () => {
      queueMicrotask(() => emit('Page.javascriptDialogOpening', dialog));
      return action.promise;
    }),
  );
  expect(reply.result).toBeUndefined();
  expect(reply.summary).toMatchObject({ tabId: 'tab', pending: true, dialog: { type: 'confirm' } });
  expect(listeners()).toBe(2);
  expect(session.status().queuedOperations).toBe(1);
  expect(allocation.size).toBe(1);

  const history: string[] = [];
  const next = session.run(free, async () => {
    history.push('next');
  });
  // A waiting operation stays cancellable.
  const controller = new AbortController();
  const cancelled = session.run(controller.signal, async () => {
    history.push('cancelled');
  });
  controller.abort(new Error('Client cancelled'));
  await expect(cancelled).rejects.toThrow('Client cancelled');
  // The interrupt path answers dialogs meanwhile.
  await session.interrupt(free, async () => {
    history.push('interrupt');
  });
  await tick();
  expect(history).toEqual(['interrupt']);

  action.resolve('done');
  await next;
  expect(history).toEqual(['interrupt', 'next']);
  expect(types(session)).toContain('action-completed');
  await tick();
  expect(session.status().queuedOperations).toBe(0);
  expect(allocation.size).toBe(0);
  await session.dispose();
});

test('an action settling before a dialog opens keeps its result and the usual wait', async () => {
  const { session, tab, emit } = await opened();
  const reply = await session.run(free, (signal) =>
    session.act(tab, { waitFor: 'load', timeout: 5000, signal }, async () => {
      setTimeout(() => emit('Page.javascriptDialogOpening', dialog), 5);
      return 'clicked';
    }),
  );
  // Without the dialog event the load wait would run for the full timeout.
  expect(reply.result).toBe('clicked');
  expect(reply.summary.pending).toBeUndefined();
  expect(types(session)).not.toContain('action-completed');
  await session.dispose();
});

test('a failed background action is reported as an event, not an unhandled rejection', async (t) => {
  const { session, tab, emit } = await opened();
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  const action = deferred<void>();
  await session.run(free, (signal) =>
    session.act(tab, { waitFor: 'none', timeout: 5000, signal }, () => {
      emit('Page.javascriptDialogOpening', dialog);
      return action.promise;
    }),
  );
  let notified = 0;
  session.changes.on(() => {
    notified++;
  });
  action.reject(new Error('Input click interrupted'));
  await session.run(free, async () => {});
  await sleep(5);
  expect(unhandled).toEqual([]);
  expect(notified).toBeGreaterThan(0);
  expect(session.eventLog().events.at(-1)).toMatchObject({
    type: 'action-failed',
    tabId: 'tab',
    error: 'Input click interrupted',
  });
  await session.dispose();
});

test('an open dialog answers an action at once, and the operation deadline bounds its hold', async () => {
  const { session, tab, emit } = await opened({ operationTimeout: 40 });
  emit('Page.javascriptDialogOpening', dialog);
  const aborted = deferred<void>();
  const action = deferred<void>();
  const reply = await session.run(free, (signal) => {
    signal.addEventListener('abort', () => aborted.resolve());
    return session.act(tab, { waitFor: 'auto', timeout: 5000, signal }, () => action.promise);
  });
  expect(reply.summary).toMatchObject({ pending: true, dialog: { type: 'confirm' } });
  // A waiting tool has its own deadline, whatever the operation ahead of it does.
  const waiting = session.run(free, async () => 'never');
  await expect(waiting).rejects.toBeInstanceOf(TimeoutError);
  await expect(waiting).rejects.toThrow('Browser operation deadline exceeded');
  await aborted.promise;
  expect(session.status().queuedOperations).toBe(1);
  action.resolve();
  await expect(session.run(free, async () => 'next')).resolves.toBe('next');
  await session.dispose();
});

test('a dialog event of another tab or a closed dialog does not end an action early', async () => {
  const { session, tab, emit } = await opened();
  const other = fakeTab(tab.browser, 'other');
  tab.browser.tabs.push(other.tab);
  tab.browser.tabCreated.emit(other.tab);
  emit('Page.javascriptDialogOpening', dialog);
  emit('Page.javascriptDialogClosed');
  const reply = await session.run(free, (signal) =>
    session.act(tab, { waitFor: 'none', timeout: 5000, signal }, async () => {
      other.emit('Page.javascriptDialogOpening', dialog);
      await sleep(5);
      return 'done';
    }),
  );
  expect(reply.result).toBe('done');
  expect(reply.summary.pending).toBeUndefined();
  expect(reply.summary.dialog).toBeNull();
  await session.dispose();
});

test('an abort after the action reports the action as completed', async () => {
  const { session, tab } = await opened();
  const controller = new AbortController();
  let actions = 0;
  const failure = await session
    .act(tab, { waitFor: 'load', timeout: 5000, signal: controller.signal }, async () => {
      actions++;
      setTimeout(
        () => controller.abort(new TimeoutError('Browser operation deadline exceeded')),
        5,
      );
    })
    .catch((error: Error) => error);
  expect(failure).toBeInstanceOf(TimeoutError);
  expect((failure as Error).message).toMatch(/^Action completed, but .*not replayed$/);
  expect((failure as Error).message).toContain('Browser operation deadline exceeded');
  expect(((failure as Error).cause as Error).message).toBe('Browser operation deadline exceeded');
  expect(actions).toBe(1);
  // Already aborted when the action returns: the same report.
  const aborted = new AbortController();
  await expect(
    session.act(tab, { waitFor: 'auto', timeout: 5000, signal: aborted.signal }, async () => {
      aborted.abort(new Error('Client cancelled'));
    }),
  ).rejects.toThrow(/^Action completed, but .*Client cancelled/);
  // waitFor none has nothing left to wait for.
  const none = new AbortController();
  none.abort();
  const reply = await session.act(
    tab,
    { waitFor: 'none', timeout: 5000, signal: none.signal },
    async () => 'done',
  );
  expect(reply.result).toBe('done');
  await session.dispose();
});

test('queue updates notify without filling the event log', async () => {
  const { session } = await opened();
  await tick();
  const before = session.eventLog().events.length;
  let notified = 0;
  session.changes.on(() => {
    notified++;
  });
  const gate = deferred<void>();
  const running = session.run(free, () => gate.promise);
  expect(notified).toBe(1);
  gate.resolve();
  await running;
  await tick();
  expect(notified).toBe(2);
  expect(session.eventLog().events.length).toBe(before);
  await session.dispose();
});

test('tab info reports the last input without its trace or random state', async () => {
  const { session, tab } = await opened();
  expect(session.tabInfo(tab).lastInput).toBeUndefined();
  tab.inputBehavior.lastReport = {
    action: 'click',
    status: 'interrupted',
    seed: 7,
    randomState: 8,
    completedSegments: 1,
    events: 2,
    trace: [{ type: 'mouseMoved', x: 1, y: 2 }],
    cleanupErrors: ['secret detail'],
    phase: 'done',
    cleanup: 'failed',
  };
  expect(session.tabInfo(tab).lastInput).toEqual({
    action: 'click',
    status: 'interrupted',
    events: 2,
    completedSegments: 1,
    cleanup: 'failed',
  });
  await session.dispose();
});

test('snapshots mask passwords by attribute name, whatever other attribute values say', async () => {
  const { session, tab } = await opened();
  const fields: Record<number, string[] | undefined> = {
    1: ['name', 'type', 'type', 'password'],
    2: ['name', 'type', 'type', 'text'],
    3: ['name', 'type'],
    4: ['type', 'PASSWORD'],
    5: ['aria-label', 'type', 'value', 'password', 'type', 'password'],
    6: ['name', 'type', 'id', 'password'],
    7: undefined,
  };
  tab.session.sendWith = async () => ({
    nodes: Object.keys(fields).map((id) => ({
      nodeId: id,
      role: { value: 'textbox' },
      name: { value: `field ${id}` },
      value: { value: `value-${id}` },
      backendDOMNodeId: Number(id),
    })),
  });
  tab.session.send = async (_: string, { backendNodeId }: { backendNodeId: number }) => {
    const attributes = fields[backendNodeId];
    if (!attributes) throw new Error('Node is gone');
    return { node: { attributes } };
  };
  const { nodes } = await session.snapshot('tab', { limit: 10 }, {});
  expect(nodes.map((node) => node.value)).toEqual([
    '••••',
    'value-2',
    'value-3',
    '••••',
    '••••',
    'value-6',
    '••••',
  ]);
  await session.dispose();
});

test('a snapshot beyond the node limit says so, on every page and in its text', async () => {
  const { session, tab } = await opened();
  const tree = (count: number) => [
    { nodeId: 'root', role: { value: 'generic' }, childIds: [...Array(count).keys()].map(String) },
    ...[...Array(count).keys()].map((i) => ({
      nodeId: String(i),
      parentId: 'root',
      role: { value: 'button' },
      name: { value: `b${i}` },
    })),
  ];
  tab.session.sendWith = async () => ({ nodes: tree(20_050) });
  const first = await session.snapshot('tab', { limit: 100 }, {});
  expect(first).toMatchObject({
    totalNodes: 20_000,
    capped: true,
    truncated: true,
    nextOffset: 100,
  });
  expect(BrowserMcpSession.snapshotText(first)).toContain('[100 of 20000+ nodes; continue with');
  const last = await session.snapshot('tab', { limit: 100, offset: 19_900 }, {});
  expect(last).toMatchObject({ capped: true, truncated: true, nextOffset: null });
  expect(last.nodes).toHaveLength(100);
  expect(BrowserMcpSession.snapshotText(last)).toContain('Stopped at the limit of 20000 nodes');
  // Exactly at the limit nothing was left out.
  tab.session.sendWith = async () => ({ nodes: tree(20_000) });
  const whole = await session.snapshot('tab', { limit: 100, offset: 19_900 }, {});
  expect(whole).toMatchObject({
    totalNodes: 20_000,
    capped: false,
    truncated: false,
    nextOffset: null,
  });
  expect(BrowserMcpSession.snapshotText(whole)).not.toContain('nodes');
  await session.dispose();
});

test('ref eviction drops the least recently used ref', async () => {
  const { session, tab } = await opened();
  const add = (id: number) => session.addRef(new Element(tab.mainFrame, id, 0, tab.session));
  const refs = [...Array(2000).keys()].map((i) => add(i + 1));
  // Used through element() and observed again through addRef().
  session.element('tab', refs[0]!);
  expect(add(2)).toBe(refs[1]);
  expect(session.status().retainedRefs).toBe(2000);
  add(2001);
  expect(session.status().retainedRefs).toBe(2000);
  expect(() => session.element('tab', refs[2]!)).toThrow('Unknown or expired ref');
  expect(session.element('tab', refs[0]!).backendNodeId).toBe(1);
  expect(session.element('tab', refs[1]!).backendNodeId).toBe(2);
  // A live node evicted earlier gets a new ref.
  expect(add(3)).not.toBe(refs[2]);
  await session.dispose();
});

test('upload names cannot probe outside the directory, and errors hide host paths', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nodriver-upload-')));
  const root = join(base, 'uploads');
  await mkdir(root);
  await writeFile(join(root, 'a.txt'), 'a');
  await writeFile(join(root, '..dots.txt'), 'dots');
  await writeFile(join(base, 'outside.txt'), 'outside');
  const { session } = await opened({ uploadDir: root });
  try {
    expect(await session.uploadPaths(['a.txt', '..dots.txt'])).toEqual([
      join(root, 'a.txt'),
      join(root, '..dots.txt'),
    ]);
    // An existing and a missing file outside are refused alike, before the file system is asked.
    for (const name of [`..${sep}outside.txt`, '../outside.txt', '../missing.txt', 'x/../../y'])
      await expect(session.uploadPaths([name])).rejects.toThrow(
        `File is outside the upload directory: ${name}`,
      );
    await expect(session.uploadPaths([join(base, 'outside.txt')])).rejects.toThrow('relative');
    await expect(session.uploadPaths(['.'])).rejects.toThrow('outside');
    const missing = await session.uploadPaths(['missing.txt']).catch((error: Error) => error);
    expect((missing as Error).message).toBe('Cannot read upload file: missing.txt');
    expect((missing as Error).message).not.toContain(base);
    expect(((missing as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT');
    // Junctions need no privilege on Windows; a link that leaves the directory is still refused.
    await symlink(base, join(root, 'link'), 'junction');
    await expect(session.uploadPaths([join('link', 'outside.txt')])).rejects.toThrow('outside');
    const gone = new BrowserMcpSession({ uploadDir: join(base, 'absent') });
    const noDirectory = await gone.uploadPaths(['a.txt']).catch((error: Error) => error);
    expect((noDirectory as Error).message).toBe('The upload directory is not available');
    await gone.dispose();
  } finally {
    await session.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('response capture reports whether it records', async () => {
  const { session } = await opened();
  expect(await session.capture('tab', 'clear')).toBe(false);
  expect(await session.capture('tab', 'start')).toBe(true);
  expect(await session.capture('tab', 'start')).toBe(true);
  expect(await session.capture('tab', 'clear')).toBe(true);
  expect(await session.capture('tab', 'stop')).toBe(false);
  expect(await session.capture('tab', 'stop')).toBe(false);
  await session.dispose();
});

test('a session connects only through a browser pool', () => {
  expect(() => new BrowserMcpSession({ connect: { endpoint: 'ws://127.0.0.1:1' } })).toThrow(
    'browser pool',
  );
});

/** A manager whose Browser.launch yields a fake browser, one lease and an in-memory modern client. */
async function connected(t: TestContext, options: BrowserSessionManagerOptions = {}) {
  const browser = fakeBrowser();
  const fake = fakeTab(browser);
  const context = {
    id: 'context',
    close: async () => {},
    newTab: async () => {
      browser.tabs.push(fake.tab);
      browser.tabCreated.emit(fake.tab);
      return fake.tab;
    },
  };
  fake.tab.context = context;
  browser.newContext = async () => context;
  t.mock.method(Browser, 'launch', async () => browser);
  const manager = new BrowserSessionManager(options);
  const { id } = manager.create('alice');
  const server = createBrowserMcpServer({}, { manager, principal: 'alice', leaseId: id });
  const client = new Client(
    { name: 'tools', version: '1' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => {
    await client.close();
    await manager.close();
  });
  const tool = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  const session = manager.session('alice', id);
  return { browser, ...fake, client, server, manager, session, tool };
}
const reported = (reply: CallToolResult) => reply.structuredContent as Record<string, any>;

test('tools refuse arguments they would ignore', async (t) => {
  const { tool } = await connected(t);
  const tabId = 'tab';
  for (const [name, args] of [
    ['browser_environment', { tabId, environment: { timezone: 'UTC' } }],
    ['browser_environment', { tabId, mode: 'inspect', geoip: { address: 'x', fields: [] } }],
    ['browser_drag', { tabId, from: 'e1', to: 'e2', toX: 1, toY: 2 }],
    ['browser_drag', { tabId, from: 'e1', to: 'e2', toX: 1 }],
    ['browser_drag', { tabId, from: 'e1', toY: 1 }],
    ['browser_drag', { tabId, from: 'e1' }],
    ['browser_scroll', { tabId, ref: 'e1', deltaY: 10 }],
    ['browser_scroll', { tabId, ref: 'e1', deltaX: -1 }],
    ['browser_scroll', { tabId, ref: 'e1', x: 0 }],
    ['browser_scroll', { tabId, ref: 'e1', y: 1 }],
    ['browser_screenshot', { tabId, ref: 'e1', fullPage: true }],
  ] as const) {
    const reply = await tool(name, args);
    expect(reply.isError).toBe(true);
    expect(reported(reply).error).toBe('TypeError');
  }
  // The valid forms get as far as the unknown tab.
  for (const [name, args] of [
    ['browser_environment', { tabId, mode: 'align', environment: { timezone: 'UTC' } }],
    ['browser_drag', { tabId, from: 'e1', to: 'e2' }],
    ['browser_drag', { tabId, from: 'e1', toX: 1, toY: 2 }],
    ['browser_scroll', { tabId, ref: 'e1', deltaX: 0, deltaY: 0 }],
    ['browser_scroll', { tabId, deltaY: 10, x: 1 }],
    ['browser_screenshot', { tabId, fullPage: true }],
    ['browser_screenshot', { tabId, ref: 'e1' }],
  ] as const) {
    const reply = await tool(name, args);
    expect(reply.isError).toBe(true);
    expect(reported(reply).error).toBe('DisconnectedError');
  }
});

test('a failed follow-up snapshot does not turn a completed action into an error', async (t) => {
  const { tool, tab } = await connected(t);
  await tool('browser_open');
  tab.session.sendWith = async () => {
    throw new Error('Tree is gone');
  };
  const reply = await tool('browser_press_key', {
    tabId: 'tab',
    key: 'Enter',
    waitFor: 'none',
    snapshot: true,
  });
  expect(reply.isError).toBeFalsy();
  expect(reported(reply)).toMatchObject({
    pressed: 'Enter',
    tabId: 'tab',
    snapshotError: 'Tree is gone',
  });
  expect(reported(reply).snapshot).toBeUndefined();
});

test('tool steps without a timeout of their own stop at the operation deadline', async (t) => {
  const uploads = await mkdtemp(join(tmpdir(), 'nodriver-upload-'));
  const states = await mkdtemp(join(tmpdir(), 'nodriver-state-'));
  t.after(async () => {
    await rm(uploads, { recursive: true, force: true });
    await rm(states, { recursive: true, force: true });
  });
  await writeFile(join(uploads, 'a.txt'), 'a');
  const { tool, tab, session } = await connected(t, {
    operationTimeout: 60,
    uploadDir: uploads,
    stateDir: states,
  });
  await tool('browser_open');
  const stuck = () => new Promise(() => {});
  const ref = session.addRef(new Element(tab.mainFrame, 1, 0, tab.session));
  tab.screenshot = stuck;
  tab.close = stuck;
  tab.session.sendWith = stuck;
  tab.context.storageState = stuck;
  tab.context.restoreStorage = stuck;
  for (const [name, args] of [
    ['browser_screenshot', { tabId: 'tab' }],
    ['browser_screenshot', { tabId: 'tab', ref }],
    ['browser_upload', { tabId: 'tab', ref, files: ['a.txt'] }],
    ['browser_storage_state', { action: 'save', name: 'login', tabId: 'tab' }],
    ['browser_close_tab', { tabId: 'tab' }],
  ] as const) {
    const reply = await tool(name, args);
    expect(reported(reply)).toMatchObject({
      error: 'TimeoutError',
      message: 'Browser operation deadline exceeded',
    });
  }
  // A load reads the file first, then waits on the browser.
  tab.context.storageState = async () => ({ cookies: [], origins: [] });
  expect(
    (await tool('browser_storage_state', { action: 'save', name: 'login', tabId: 'tab' })).isError,
  ).toBeFalsy();
  expect(
    reported(await tool('browser_storage_state', { action: 'load', name: 'login', tabId: 'tab' })),
  ).toMatchObject({ error: 'TimeoutError' });
});

test('browser_select stops at its own timeout', async (t) => {
  const { tool, tab, session } = await connected(t);
  await tool('browser_open');
  const ref = session.addRef(new Element(tab.mainFrame, 1, 0, tab.session));
  tab.withInput = () => new Promise(() => {});
  const reply = await tool('browser_select', { tabId: 'tab', ref, values: ['a'], timeout: 20 });
  expect(reported(reply)).toMatchObject({
    error: 'TimeoutError',
    message: 'Selecting options timed out',
  });
});

test('browser_network reports the real recording state after clear', async (t) => {
  const { tool } = await connected(t);
  await tool('browser_open');
  const network = async (action: string) =>
    reported(await tool('browser_network', { tabId: 'tab', action })).capturing;
  expect(await network('clear')).toBe(false);
  expect(await network('start')).toBe(true);
  expect(await network('clear')).toBe(true);
  expect(await network('stop')).toBe(false);
  expect(await network('clear')).toBe(false);
});

test('a handoff waits its turn to move focus, answers past the queue and forgets the front tab', async (t) => {
  const { tool, client, session, browser, tab } = await connected(t, { humanInteraction: true });
  await tool('browser_open');
  let prompts = 0,
    action: 'accept' | 'decline' = 'accept',
    atPrompt: unknown;
  let holdQueue: Promise<unknown> | undefined;
  const queue = deferred<void>();
  client.setRequestHandler('elicitation/create', async () => {
    prompts++;
    atPrompt = browser.frontTab;
    // The user switches tabs, and another operation takes the queue meanwhile.
    browser.frontTab = tab;
    holdQueue = session.run(free, () => queue.promise);
    return action === 'accept' ? { action, content: { finished: true } } : { action };
  });
  const gate = deferred<void>();
  const running = session.run(free, () => gate.promise);
  let settled = false;
  const first = tool('browser_handoff', { tabId: 'tab' }).then((reply) => {
    settled = true;
    return reply;
  });
  await sleep(20);
  expect(prompts).toBe(0);
  expect(settled).toBe(false);
  gate.resolve();
  await running;
  const reply = await first;
  expect(prompts).toBe(1);
  expect(atPrompt).toBeUndefined();
  expect(reported(reply).completed).toBe(true);
  expect(browser.frontTab).toBeUndefined();
  queue.resolve();
  await holdQueue;
  // A declined second round forgets it as well.
  action = 'decline';
  expect(reported(await tool('browser_handoff', { tabId: 'tab' })).completed).toBe(false);
  expect(prompts).toBe(2);
  expect(browser.frontTab).toBeUndefined();
  await holdQueue;
});

test('resource updates are coalesced', async (t) => {
  const { client, session } = await connected(t);
  const updates: string[] = [];
  client.setNotificationHandler('notifications/resources/updated', ({ params }) => {
    updates.push(params.uri);
  });
  const subscription = await client.listen({
    resourceSubscriptions: ['browser://state', 'browser://events'],
  });
  await sleep(60);
  updates.length = 0;
  for (let i = 0; i < 100; i++) session.changed('burst');
  await poll(async () => (updates.length >= 2 ? true : undefined), { timeout: 2000 });
  await sleep(60);
  expect(updates.sort()).toEqual(['browser://events', 'browser://state']);
  for (let i = 0; i < 10; i++) session.changed('later');
  await poll(async () => (updates.length >= 4 ? true : undefined), { timeout: 2000 });
  await sleep(60);
  expect(updates).toHaveLength(4);
  await subscription?.close();
});

test('server cleanup runs once, on the transport closing or on close()', async (t) => {
  const closes = t.mock.method(BrowserSessionManager.prototype, 'close');
  const manager = new BrowserSessionManager();
  t.after(() => manager.close());
  closes.mock.resetCalls();
  const { id } = manager.create('alice');
  const session = manager.session('alice', id);

  // A bound instance stops listening when its transport closes, connected or not.
  const bound = createBrowserMcpServer({}, { manager, principal: 'alice', leaseId: id });
  expect(session.changes.size).toBe(1);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bound.connect(b);
  await a.close();
  await poll(async () => (session.changes.size === 0 ? true : undefined), { timeout: 2000 });
  await bound.close();
  await bound.close();
  expect(closes.mock.callCount()).toBe(0);

  // An owning instance closes its manager once, even without a first message.
  const owning = createBrowserMcpServer();
  const [c, d] = InMemoryTransport.createLinkedPair();
  await owning.connect(d);
  await c.close();
  await poll(async () => (closes.mock.callCount() ? true : undefined), { timeout: 2000 });
  await owning.close();
  expect(closes.mock.callCount()).toBe(1);

  // close() first: the transport closing afterwards changes nothing.
  closes.mock.resetCalls();
  const closing = createBrowserMcpServer();
  const [e, f] = InMemoryTransport.createLinkedPair();
  await closing.connect(f);
  await closing.close();
  await e.close();
  await tick();
  expect(closes.mock.callCount()).toBe(1);

  // Never connected: close() alone cleans up.
  const unused = createBrowserMcpServer({}, { manager, principal: 'alice', leaseId: id });
  expect(session.changes.size).toBe(1);
  await unused.close();
  expect(session.changes.size).toBe(0);
});

test('a manager failure during transport close reaches the server error callback', async (t) => {
  const failure = new Error('Browser did not close');
  t.mock.method(BrowserSessionManager.prototype, 'close', async () => {
    throw failure;
  });
  const server = createBrowserMcpServer();
  const errors: Error[] = [];
  server.server.onerror = (error) => errors.push(error);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await a.close();
  await poll(async () => (errors.length ? true : undefined), { timeout: 2000 });
  expect(errors).toEqual([failure]);
  await expect(server.close()).rejects.toBe(failure);
});
