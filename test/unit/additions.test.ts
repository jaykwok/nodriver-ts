import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { Connection } from '../../src/protocol/connection.ts';
import type { Session } from '../../src/protocol/connection.ts';
import type { Transport } from '../../src/transport/transport.ts';
import { InputBehavior } from '../../src/input/behavior.ts';
import { Keyboard, keyDefinition, parseChord } from '../../src/input/input.ts';
import { acquireProfileLock } from '../../src/browser/launcher.ts';
import { BrowserSessionManager, LeaseError } from '../../src/mcp/manager.ts';
import { BrowserMcpSession } from '../../src/mcp/session.ts';
import { removeTree } from '../../src/utils.ts';

function fakeSession() {
  const messages: any[] = [];
  const session = {
    closed: false,
    send: async (method: string, params: any) => {
      messages.push({ method, ...params });
      return {};
    },
  } as unknown as Session;
  return { session, messages };
}
const keyEvents = (messages: any[]) =>
  messages
    .filter((m) => m.method === 'Input.dispatchKeyEvent')
    .map((m) => `${m.type}:${m.key}:${m.code}${m.text !== undefined ? `:${m.text}` : ''}`);

test('chords parse a trailing plus and keys resolve to US-QWERTY definitions', () => {
  expect(parseChord('Control+Shift+K')).toEqual(['Control', 'Shift', 'K']);
  expect(parseChord('Control++')).toEqual(['Control', '+']);
  expect(keyDefinition('Space')).toMatchObject({ key: ' ', code: 'Space' });
  expect(keyDefinition('Enter')).toMatchObject({ key: 'Enter', code: 'Enter' });
  expect(() => keyDefinition('NoSuchKey')).toThrow();
});

test('keyUp mirrors keyDown; held Shift yields shifted keys; modifiers send rawKeyDown', async () => {
  const { session, messages } = fakeSession();
  const keyboard = new Keyboard(session);
  await keyboard.press('Space');
  await keyboard.press('Shift+a');
  await keyboard.press('Control+a');
  expect(keyEvents(messages)).toEqual([
    'keyDown: :Space: ',
    'keyUp: :Space',
    'rawKeyDown:Shift:ShiftLeft',
    'keyDown:A:KeyA:A',
    'keyUp:A:KeyA',
    'keyUp:Shift:ShiftLeft',
    'rawKeyDown:Control:ControlLeft',
    'rawKeyDown:a:KeyA',
    'keyUp:a:KeyA',
    'keyUp:Control:ControlLeft',
  ]);
  expect(keyboard.pressedKeys).toEqual([]);
});

test('macOS key events carry the platform editing commands', async () => {
  const commands = async (mac: boolean, chord: string) => {
    const { session, messages } = fakeSession();
    await new Keyboard(session, undefined, mac).press(chord);
    return messages
      .filter((m) => m.method === 'Input.dispatchKeyEvent' && m.type !== 'keyUp')
      .map((m) => m.commands ?? []);
  };
  expect(await commands(true, 'Meta+A')).toEqual([[], ['selectAll']]);
  expect(await commands(true, 'Control+a')).toEqual([[], ['moveToBeginningOfParagraph']]);
  expect(await commands(true, 'Shift+Alt+ArrowLeft')).toEqual([
    [],
    [],
    ['moveWordLeftAndModifySelection'],
  ]);
  expect(await commands(true, 'Alt+ArrowUp')).toEqual([
    [],
    ['moveBackward', 'moveToBeginningOfParagraph'],
  ]);
  expect(await commands(true, 'Enter')).toEqual([[]]);
  expect(await commands(false, 'Meta+A')).toEqual([[], []]);
});

test('human typing uses key events for keyboard characters and insertText otherwise', async () => {
  const { session, messages } = fakeSession();
  const behavior = new InputBehavior(
    (task) => task(),
    () => {},
  );
  behavior.configure({ mode: 'human', seed: 3, keyDelay: [0, 0], pause: [0, 0] });
  await new Keyboard(session, behavior).type('A新');
  expect(
    messages.map((m) => (m.method === 'Input.insertText' ? `insert:${m.text}` : m.type)),
  ).toEqual(['rawKeyDown', 'keyDown', 'keyUp', 'keyUp', 'insert:新']);
  messages.length = 0;
  behavior.configure({ typing: 'insertText' });
  await new Keyboard(session, behavior).type('ab');
  expect(messages.map((m) => m.method)).toEqual(['Input.insertText', 'Input.insertText']);
});

test('profile lock reclaims a dead local owner but refuses a live or remote one', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'nodriver-lock-'));
  const lock = join(profile, '.nodriver.lock');
  try {
    await writeFile(lock, `2147483646\n${hostname()}\n`);
    const handle = await acquireProfileLock(profile);
    expect((await readFile(lock, 'utf8')).split('\n')[0]).toBe(String(process.pid));
    await expect(acquireProfileLock(profile)).rejects.toThrow(`PID ${process.pid}`);
    await handle.close();
    await writeFile(lock, `2147483646\nanother-host\n`);
    await expect(acquireProfileLock(profile)).rejects.toThrow('another-host');
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

class FakeTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason: Error) => void;
  messages: Array<{ id: number; method: string; sessionId?: string }> = [];
  send(message: string): void {
    this.messages.push(JSON.parse(message));
  }
  close(): void {}
}

test('concurrent stale profile lock recovery grants ownership only once', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'nodriver-lock-race-'));
  try {
    await writeFile(join(profile, '.nodriver.lock'), `2147483646\n${hostname()}\n`);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => acquireProfileLock(profile)),
    );
    const owners = results.filter((r) => r.status === 'fulfilled');
    for (const owner of owners) await owner.value.close();
    expect(owners).toHaveLength(1);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test('session-routed listeners run before global ones and traces omit params', async () => {
  const transport = new FakeTransport();
  const traces: unknown[] = [];
  const connection = new Connection(transport, { trace: (entry) => traces.push(entry) });
  const order: string[] = [];
  connection.events.on(() => void order.push('global'));
  const off = connection.session('s1').on('Page.loadEventFired', () => void order.push('s1'));
  connection.session('s2').onAny(() => void order.push('s2'));
  const before = connection.listenerCount;
  transport.onmessage?.(
    JSON.stringify({ method: 'Page.loadEventFired', params: {}, sessionId: 's1' }),
  );
  expect(order).toEqual(['s1', 'global']);
  off();
  expect(connection.listenerCount).toBe(before - 1);
  const sent = connection.session('s1').send('Page.navigate', { url: 'https://secret.example' });
  const m = transport.messages[0]!;
  transport.onmessage?.(
    JSON.stringify({ id: m.id, sessionId: m.sessionId, error: { code: -32000, message: 'no' } }),
  );
  await expect(sent).rejects.toThrow();
  expect(traces).toHaveLength(1);
  expect(traces[0]).toMatchObject({ method: 'Page.navigate', sessionId: 's1', error: '-32000' });
  expect(JSON.stringify(traces)).not.toContain('secret');
  await connection.close();
});

test('leases resolve a per-principal default and named leases without creating on lookup', async () => {
  const manager = new BrowserSessionManager({ maxLeases: 3, sweepIntervalMs: 60000 });
  try {
    const first = manager.resolve('alice', 'default');
    expect(manager.resolve('alice', 'default').id).toBe(first.id);
    expect(manager.resolve('bob', 'default').id).not.toBe(first.id);
    expect(manager.resolve('alice', first.id).id).toBe(first.id);
    expect(() => manager.resolve('bob', first.id)).toThrow(LeaseError);
    expect(() => manager.resolve('alice', 'bad name')).toThrow(LeaseError);
    expect(() => manager.resolve('alice', 'later', false)).toThrow(LeaseError);
    const named = manager.resolve('alice', 'agent-1');
    expect(named.name).toBe('agent-1');
    try {
      manager.resolve('alice', 'agent-2');
      throw new Error('expected capacity');
    } catch (error) {
      expect((error as LeaseError).code).toBe('capacity');
    }
  } finally {
    await manager.close();
  }
});

test('snapshot text renders an indented tree with refs, states and pagination hints', () => {
  const text = BrowserMcpSession.snapshotText({
    tabId: 't1',
    frameId: 'f1',
    url: 'https://example.test/',
    frames: [
      { frameId: 'f1', url: 'https://example.test/' },
      { frameId: 'f2', url: 'https://ads.example/' },
    ],
    nodes: [
      { ref: null, role: 'main', name: '', depth: 0, states: {} },
      { ref: 'e1', role: 'button', name: 'Go "now"', depth: 1, states: { disabled: true } },
      {
        ref: 'e2',
        role: 'textbox',
        name: 'Name',
        depth: 1,
        states: { focused: false },
        value: 'Ada',
      },
    ],
    offset: 0,
    truncated: true,
    nextOffset: 3,
    totalNodes: 9,
  } as any);
  expect(text.split('\n')).toEqual([
    'Tab t1 frame f1: https://example.test/',
    '- main',
    '  - button "Go \\"now\\"" [e1] disabled',
    '  - textbox "Name" [e2] value="Ada"',
    'Other frames (snapshot with frameId): f2 https://ads.example/',
    '[3 of 9 nodes; continue with offset=3]',
  ]);
});

test('removeTree retries while another process keeps the directory busy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nodriver-rm-'));
  const busy = join(root, 'a', 'b');
  await mkdir(busy, { recursive: true });
  await writeFile(join(busy, 'f'), 'x');
  // On Windows a process whose cwd is inside the tree makes rm fail with EBUSY until it exits.
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},700)'], {
    cwd: busy,
    stdio: 'ignore',
  });
  await new Promise((resolve) => child.once('spawn', resolve));
  await removeTree(root, 10_000);
  await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
});
