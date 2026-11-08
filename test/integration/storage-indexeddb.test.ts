import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Browser } from '../../src/browser/browser.ts';
import { fixtureServer } from '../fixtures/server.ts';

const seed = `new Promise((resolve, reject) => {
  const open = indexedDB.open('app', 3);
  open.onupgradeneeded = () => {
    const items = open.result.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
    items.createIndex('by_tag', 'tags', { multiEntry: true });
    items.createIndex('by_code', 'code', { unique: true });
    open.result.createObjectStore('loose');
  };
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction(['items', 'loose'], 'readwrite');
    tx.objectStore('items').put({ id: 7, tags: ['a', 'b'], code: 'x', when: new Date(5), bytes: new Uint8Array([1, 2]), blob: new Blob(['hi'], { type: 'text/plain' }), map: new Map([['k', 1n]]) });
    tx.objectStore('loose').put('value', [1, 'compound']);
    tx.oncomplete = () => { open.result.close(); resolve(true); };
    tx.onabort = () => reject(tx.error);
  };
})`;
const inspect = `new Promise((resolve, reject) => {
  const open = indexedDB.open('app');
  open.onerror = () => reject(open.error);
  open.onsuccess = async () => {
    const db = open.result;
    const tx = db.transaction(['items', 'loose'], 'readwrite');
    const items = tx.objectStore('items');
    const done = (r) => new Promise((ok) => { r.onsuccess = () => ok(r.result); });
    const row = await done(items.get(7));
    const next = await done(items.add({ code: 'y', tags: [] }));
    const tagged = await done(items.index('by_tag').count('b'));
    const loose = await done(tx.objectStore('loose').get([1, 'compound']));
    const unique = items.index('by_code').unique;
    db.close();
    resolve({
      version: db.version,
      when: row.when.getTime(),
      bytes: [...row.bytes],
      blob: await row.blob.text(),
      blobType: row.blob.type,
      big: String(row.map.get('k')),
      next, tagged, loose, unique,
    });
  };
})`;

test('storage state carries IndexedDB and sessionStorage between contexts', async () => {
  const fixture = await fixtureServer();
  const browser = await Browser.launch({ headless: process.env.NODRIVER_HEADFUL !== '1' });
  try {
    const a = await browser.newContext();
    const b = await browser.newContext();
    const page = await a.newTab(fixture.base + '/empty');
    await page.evaluate(seed);
    await page.mainFrame.setStorage({ tabbed: 'yes' }, 'session');
    const state = await a.storageState({ include: ['indexedDB', 'sessionStorage'] });
    expect(state.sessionStorage).toEqual([{ origin: fixture.base, values: { tabbed: 'yes' } }]);
    expect(state.origins[0]!.indexedDB![0]).toMatchObject({ name: 'app', version: 3 });
    await expect(a.storageState({ include: ['indexedDB'], maxBytes: 64 })).rejects.toThrow(
      'maxBytes',
    );

    // Survives the JSON a file would hold.
    const saved = JSON.parse(JSON.stringify(state)) as typeof state;
    const receiving = await b.newTab('about:blank');
    await b.restoreStorage(saved, { sessionStorageTab: receiving });
    await receiving.goto(fixture.base + '/empty');
    expect(await receiving.mainFrame.storage('session')).toEqual({ tabbed: 'yes' });
    expect(await receiving.evaluate(inspect)).toEqual({
      version: 3,
      when: 5,
      bytes: [1, 2],
      blob: 'hi',
      blobType: 'text/plain',
      big: '1',
      next: 8,
      tagged: 1,
      loose: 'value',
      unique: true,
    });
    await expect(b.restoreStorage(saved, { sessionStorageTab: receiving })).rejects.toThrow(
      fixture.base,
    );
    await a.close();
    await b.close();
  } finally {
    await browser.close();
    await fixture.server.stop();
  }
});
