import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Protocol } from 'devtools-protocol';
import { decryptState, encryptState, NodriverError, type Tab } from '../../src/index.ts';
import type { Browser } from '../../src/index.ts';
import { decodeValue, encodeValue } from '../../src/browser/indexeddb.ts';
import { readState, writeState } from '../../src/mcp/state.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';

const one = 'http://127.0.0.1:1000';
const two = 'http://127.0.0.1:2000';
const state = {
  version: 2 as const,
  cookies: [],
  origins: [{ origin: one, localStorage: { token: '中文😀' } }],
};
const key = new Uint8Array(32).fill(7);

const roundTrip = async (value: unknown) =>
  decodeValue(JSON.parse(JSON.stringify(await encodeValue(value, { left: 1e6 }))));

test('the IndexedDB value encoding round-trips structured-clone types', async () => {
  const bytes = new Uint8Array([0, 1, 254, 255]);
  const value = {
    text: '中文',
    nothing: null,
    missing: undefined,
    nan: NaN,
    infinite: -Infinity,
    negativeZero: -0,
    big: 2n ** 70n,
    date: new Date(1234),
    pattern: /a+/gi,
    list: [1, [2, { deep: true }]],
    map: new Map<unknown, unknown>([[new Date(5), new Set(['x'])]]),
    buffer: bytes.buffer,
    view: new Float64Array([1.5, -2.5]),
    range: new DataView(bytes.buffer, 1, 2),
    ['__proto__']: 'own key',
  };
  const out = (await roundTrip(value)) as typeof value;
  assert.deepEqual(out.map, value.map);
  assert.deepEqual(new Uint8Array(out.buffer), bytes);
  assert.deepEqual(out.view, value.view);
  assert.deepEqual([...new Uint8Array(out.range.buffer)], [1, 254]);
  assert.ok(Object.is(out.negativeZero, -0));
  assert.ok(Number.isNaN(out.nan));
  assert.equal(out.big, value.big);
  assert.ok('missing' in out);
  assert.equal(Object.getOwnPropertyDescriptor(out, '__proto__')?.value, 'own key');
  assert.deepEqual(out.list, value.list);
  assert.deepEqual(out.pattern, value.pattern);
  assert.deepEqual(out.date, value.date);
  const blob = (await roundTrip(new Blob(['abc'], { type: 'text/plain' }))) as Blob;
  assert.equal(blob.type, 'text/plain');
  assert.equal(await blob.text(), 'abc');
  const file = (await roundTrip(new File(['x'], 'a.txt', { lastModified: 9 }))) as File;
  assert.equal(file.name, 'a.txt');
  assert.equal(file.lastModified, 9);
});

test('the IndexedDB value encoding refuses cycles, unknown tags and exhausted budgets', async () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  await assert.rejects(encodeValue(cycle, { left: 1e6 }), /cyclic/);
  // A value repeated without a cycle is fine.
  const shared = { a: 1 };
  await encodeValue([shared, shared], { left: 1e6 });
  assert.throws(() => decodeValue({ $t: 'Function', v: 'x' }), /Unknown value tag/);
  await assert.rejects(encodeValue('x'.repeat(100), { left: 50 }), /exceeds maxBytes/);
});

test('encrypted states round-trip with a raw key and a passphrase', async () => {
  const raw = await encryptState(state, key);
  assert.ok(!raw.toString('latin1').includes('token'));
  assert.deepEqual(await decryptState(raw, key), state);
  const sealed = await encryptState(state, 'correct horse');
  assert.deepEqual(await decryptState(sealed, 'correct horse'), state);
  await assert.rejects(decryptState(sealed, 'wrong'), /Cannot decrypt/);
  await assert.rejects(decryptState(raw, new Uint8Array(32)), /Cannot decrypt/);
  await assert.rejects(encryptState(state, new Uint8Array(16)), /32 bytes/);
});

test('changing any part of an encrypted state fails authentication', async () => {
  const sealed = await encryptState(state, key);
  const headerEnd = 12 + sealed.readUInt32BE(8);
  for (const at of [14, headerEnd + 1, sealed.length - 1]) {
    const changed = Buffer.from(sealed);
    changed[at]! ^= 1;
    await assert.rejects(decryptState(changed, key), /Cannot decrypt/);
  }
});

test('a passphrase state with excessive KDF costs or no header is refused before deriving', async () => {
  const iv = Buffer.alloc(12).toString('base64');
  for (const header of [
    JSON.stringify({ iv, scrypt: { salt: 'AA==', N: 2 ** 30, r: 8, p: 1 } }),
    JSON.stringify({ iv, scrypt: { salt: 'AA==', N: 2 ** 20, r: 32, p: 16 } }),
    JSON.stringify({ iv, scrypt: { salt: 'AA==', N: 2 ** 17, r: 8, p: 64 } }),
    'null',
  ]) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(Buffer.byteLength(header));
    const forged = Buffer.concat([
      Buffer.from('NDSTATE1', 'latin1'),
      length,
      Buffer.from(header),
      Buffer.alloc(32),
    ]);
    await assert.rejects(decryptState(forged, 'x'), /Cannot decrypt/);
  }
});

test('a state directory with a key stores ciphertext and refuses plain files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nodriver-state-key-'));
  try {
    await writeState(directory, 'alice', 'login', state, key);
    const path = join(directory, 'alice', 'login.json');
    assert.ok(!(await readFile(path, 'latin1')).includes('token'));
    assert.deepEqual(await readState(directory, 'alice', 'login', key), state);
    await assert.rejects(readState(directory, 'alice', 'login'), /must configure stateKey/);
    await writeFile(path, JSON.stringify(state));
    await assert.rejects(readState(directory, 'alice', 'login', key), /not encrypted/);
    assert.deepEqual(await readState(directory, 'alice', 'login'), state);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const frameOf = (id: string, loaderId: string, url: string): Protocol.Page.Frame => ({
  id,
  loaderId,
  url,
  domainAndRegistry: '',
  securityOrigin: '://',
  mimeType: 'text/html',
  secureContextType: 'InsecureScheme',
  crossOriginIsolatedContextType: 'NotIsolated',
  gatedAPIFeatures: [],
});

/** A page, storage reads answered per kind, and navigations that complete at once. */
async function scripted(values: Record<string, Record<string, string>>) {
  const chrome = await ScriptedChrome.start();
  const log = {
    writes: [] as Array<{ kind: string; origin: string; values: unknown }>,
    navigated: [] as string[],
  };
  let browser!: Browser;
  let loader = 0;
  chrome.handle('Page.getNavigationHistory', () => ({ currentIndex: 0, entries: [] }));
  chrome.handle('Page.navigate', ({ url }, command) => {
    log.navigated.push(url);
    const frameId = browser.tabs[0]!.mainFrame.id;
    const loaderId = `load-${++loader}`;
    setImmediate(() => {
      chrome.emit(
        'Page.frameNavigated',
        { type: 'Navigation', frame: frameOf(frameId, loaderId, url) },
        command.sessionId,
      );
      chrome.emit(
        'Page.lifecycleEvent',
        { frameId, loaderId, name: 'load', timestamp: 0 },
        command.sessionId,
      );
    });
    return { frameId, loaderId };
  });
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  chrome.handle('Runtime.callFunctionOn', ({ arguments: args }) => {
    const arg = args![0]!.value as {
      kind: string;
      origin: string;
      values?: Record<string, string>;
    };
    if (arg.values) log.writes.push({ kind: arg.kind, origin: arg.origin, values: arg.values });
    return { result: { type: 'object', value: values[arg.kind] ?? {} } };
  });
  chrome.handle('Storage.getCookies', () => ({ cookies: [] }));
  chrome.handle('Storage.setCookies', () => {});
  chrome.handle('Network.setBypassServiceWorker', () => {});
  chrome.handle('Fetch.enable', () => {});
  chrome.handle('Fetch.disable', () => {});
  browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  const received = tab.session.waitFor('Page.frameNavigated');
  chrome.emit(
    'Page.frameNavigated',
    { type: 'Navigation', frame: frameOf(tab.mainFrame.id, 'first', `${one}/page`) },
    tab.session.id,
  );
  await received;
  return {
    chrome,
    browser,
    tab: tab as Tab,
    context: browser.defaultContext,
    log,
    async [Symbol.asyncDispose]() {
      await browser.close();
      await chrome.close();
    },
  };
}

test('storageState reports version 2 and adds sessionStorage of open tabs on request', async () => {
  await using f = await scripted({ local: { a: '1' }, session: { s: '2' } });
  assert.deepEqual(await f.context.storageState(), {
    version: 2,
    cookies: [],
    origins: [{ origin: one, localStorage: { a: '1' } }],
  });
  const full = await f.context.storageState({ include: ['sessionStorage'] });
  assert.deepEqual(full.sessionStorage, [{ origin: one, values: { s: '2' } }]);
  await assert.rejects(f.context.storageState({ maxBytes: 10 }), /exceeds maxBytes/);
  await assert.rejects(f.context.storageState('state.json' as never), /takes options/);
  await assert.rejects(f.context.storageState({ maxBytes: 0 }), /positive integer/);
});

test('sessionStorage is restored into the given tab, through empty pages of its origin', async () => {
  await using f = await scripted({});
  await f.context.restoreStorage(
    {
      version: 2,
      cookies: [],
      origins: [],
      sessionStorage: [{ origin: two, values: { s: 'v' } }],
    },
    { sessionStorageTab: f.tab },
  );
  assert.deepEqual(f.log.writes, [{ kind: 'session', origin: two, values: { s: 'v' } }]);
  assert.deepEqual(f.log.navigated, [`${two}/`, 'about:blank']);
});

test('restoreStorage refuses what it cannot apply, before changing anything', async () => {
  await using f = await scripted({});
  const { context, tab, chrome } = f;
  await assert.rejects(
    context.restoreStorage({
      cookies: [],
      origins: [],
      sessionStorage: [{ origin: two, values: {} }],
    }),
    /pass sessionStorageTab/,
  );
  await assert.rejects(
    context.restoreStorage({ version: 3, cookies: [], origins: [] } as never),
    /Unsupported storage state version: 3/,
  );
  const refused = await context
    .restoreStorage({
      cookies: [],
      origins: [
        { origin: one, localStorage: {}, indexedDB: [{ name: 'db', version: 1, stores: [] }] },
      ],
    })
    .catch((error: unknown) => error);
  assert.ok(refused instanceof NodriverError, String(refused));
  assert.ok(refused.message.includes(tab.url));
  assert.equal(chrome.commands.filter((c) => c.method === 'Storage.setCookies').length, 0);
  // A legacy state without a version still restores.
  await context.restoreStorage({ cookies: [], origins: [] });
});
