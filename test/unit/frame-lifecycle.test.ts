import { expect, test } from 'bun:test';
import { Connection } from '../../src/protocol/connection.js';
import { Frame, FrameManager } from '../../src/page/frames.js';
import type { Tab } from '../../src/page/tab.js';
import { poll } from '../../src/utils.js';

test('removed frame subtrees are retired without retaining every historical frame', async () => {
  const connection = new Connection({ send() {}, close() {} });
  const session = connection.session('page');
  const manager = new FrameManager({} as Tab, session);
  const root = new Frame(manager, 'root', session);
  manager.frames.set(root.id, root);
  try {
    for (let i = 0; i < 100; i++) {
      const child = new Frame(manager, `child-${i}`, session);
      const nested = new Frame(manager, `nested-${i}`, session);
      child.parentId = root.id;
      nested.parentId = child.id;
      manager.frames.set(child.id, child);
      manager.frames.set(nested.id, nested);
      connection.dispatch({
        method: 'Page.frameDetached',
        sessionId: session.id,
        params: { frameId: child.id, reason: 'remove' },
      });
      expect(child.detached && nested.detached).toBeTrue();
      expect(manager.frames.size).toBe(1);
    }
  } finally {
    manager.dispose();
    await connection.close();
  }
});

test('navigation retires old descendants and swapped session events preserve the new owner', async () => {
  const connection = new Connection({ send() {}, close() {} });
  const session = connection.session('page');
  const manager = new FrameManager({} as Tab, session);
  const root = new Frame(manager, 'root', session);
  const childSession = connection.session('oopif');
  manager.track(childSession);
  const child = new Frame(manager, 'child', childSession);
  child.parentId = root.id;
  manager.frames.set(root.id, root);
  manager.frames.set(child.id, child);
  try {
    connection.dispatch({
      method: 'Page.frameDetached',
      sessionId: session.id,
      params: { frameId: child.id, reason: 'swap' },
    });
    expect(child.detached).toBeFalse();
    expect(manager.frames.get(child.id)).toBe(child);
    connection.dispatch({
      method: 'Page.frameNavigated',
      sessionId: session.id,
      params: { frame: { id: 'root', url: 'http://example.test/new', loaderId: 'new' } },
    });
    expect(child.detached).toBeTrue();
    expect(manager.frames.size).toBe(1);
    manager.dispose();
    expect(manager.frames.size).toBe(0);
    expect(manager.sessions.size).toBe(0);
  } finally {
    manager.dispose();
    await connection.close();
  }
});

test('BFCache restores OOPIF ownership and nested trees omitted by the parent snapshot', async () => {
  interface Tree {
    frame: { id: string; url: string; loaderId: string };
    childFrames?: Tree[];
  }
  const make = (id: string, child?: string): Tree => ({
    frame: { id, url: `http://example.test/${id}`, loaderId: 'loader' },
    ...(child ? { childFrames: [make(child)] } : {}),
  });
  const trees = {
    page: make('root', 'cross'),
    cross: make('cross', 'nested'),
    nested: make('nested'),
  };
  const errors: unknown[] = [];
  const connection = new Connection({
    send(message) {
      const m = JSON.parse(message);
      queueMicrotask(() =>
        this.onmessage?.(
          JSON.stringify({
            id: m.id,
            sessionId: m.sessionId,
            result:
              m.method === 'Page.getFrameTree'
                ? { frameTree: trees[m.sessionId as keyof typeof trees] }
                : {},
          }),
        ),
      );
    },
    close() {},
    onmessage: undefined as ((message: string) => void) | undefined,
  });
  const session = connection.session('page');
  const manager = new FrameManager(
    {
      configureSession: async () => {},
      reportError: (error: unknown) => errors.push(error),
    } as unknown as Tab,
    session,
  );
  await manager.initialize();
  connection.transport.onmessage?.(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      sessionId: 'page',
      params: { sessionId: 'cross', targetInfo: { type: 'iframe', targetId: 'cross' } },
    }),
  );
  connection.transport.onmessage?.(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      sessionId: 'cross',
      params: { sessionId: 'nested', targetInfo: { type: 'iframe', targetId: 'nested' } },
    }),
  );
  try {
    await poll(async () => (manager.setup.size === 0 ? true : undefined));
    const old = manager.frames.get('cross')!;
    connection.dispatch({
      method: 'Page.frameNavigated',
      sessionId: 'page',
      params: { type: 'BackForwardCacheRestore', frame: trees.page.frame },
    });
    await poll(async () => (manager.setup.size === 0 ? true : undefined));
    expect(manager.frames.size).toBe(3);
    expect(manager.frames.get('cross')?.session.id).toBe('cross');
    expect(manager.frames.get('nested')?.session.id).toBe('nested');
    expect(manager.frames.get('nested')?.parentId).toBe('cross');
    expect(old.detached).toBeTrue();
    expect(errors).toEqual([]);
    connection.detach('cross');
    expect(manager.frames.size).toBe(1);
    expect(manager.sessions.size).toBe(1);
  } finally {
    manager.dispose();
    await connection.close();
  }
});
