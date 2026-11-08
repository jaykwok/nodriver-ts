import type { Frame } from '../page/frames.ts';

export interface IndexedDBIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}
export interface IndexedDBStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexedDBIndex[];
  /** Keys and values in the tagged encoding of encodeValue(). */
  records: Array<{ key: unknown; value: unknown }>;
}
export interface IndexedDBDatabase {
  name: string;
  version: number;
  stores: IndexedDBStore[];
}
/** Remaining bytes of an export, shared by its origins. */
export interface ByteBudget {
  left: number;
}

const BLOCKED = 'nodriver-indexeddb-blocked';

/**
 * JSON form of a structured-clone value: strings, booleans, null and finite numbers as they are,
 * anything else tagged. Runs in the page as well as here, so it refers to nothing outside itself.
 * Charges `budget` roughly the size of the JSON. Cycles and platform objects throw.
 */
export async function encodeValue(value: unknown, budget: ByteBudget): Promise<unknown> {
  const charge = (bytes: number) => {
    budget.left -= bytes;
    if (budget.left < 0) throw new RangeError('Storage state exceeds maxBytes');
  };
  const base64 = (bytes: Uint8Array) => {
    charge(Math.ceil(bytes.length / 3) * 4 + 32);
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768)
      text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(text);
  };
  const open = new Set<object>();
  const encode = async (v: unknown): Promise<unknown> => {
    if (v === null || typeof v === 'boolean') return (charge(8), v);
    if (typeof v === 'string') return (charge(v.length * 3 + 2), v);
    if (typeof v === 'undefined') return (charge(32), { $t: 'undefined' });
    if (typeof v === 'bigint') return (charge(48), { $t: 'BigInt', v: v.toString() });
    if (typeof v === 'number') {
      charge(32);
      return Number.isFinite(v) && !Object.is(v, -0)
        ? v
        : { $t: 'Number', v: Object.is(v, -0) ? '-0' : String(v) };
    }
    if (typeof v !== 'object') throw new TypeError(`Cannot export a ${typeof v}`);
    if (open.has(v)) throw new TypeError('Cannot export a cyclic IndexedDB value');
    charge(32);
    const type = Object.prototype.toString.call(v).slice(8, -1);
    if (type === 'Date') return { $t: 'Date', v: String((v as Date).getTime()) };
    if (type === 'RegExp') {
      const { source, flags } = v as RegExp;
      charge(source.length * 3);
      return { $t: 'RegExp', v: [source, flags] };
    }
    if (type === 'ArrayBuffer')
      return { $t: 'ArrayBuffer', v: base64(new Uint8Array(v as ArrayBuffer)) };
    if (ArrayBuffer.isView(v))
      return { $t: type, v: base64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (type === 'Blob' || type === 'File') {
      const blob = v as File;
      return {
        $t: type,
        v: base64(new Uint8Array(await blob.arrayBuffer())),
        type: blob.type,
        ...(type === 'File' ? { name: blob.name, lastModified: blob.lastModified } : {}),
      };
    }
    if (type === 'Number' || type === 'String' || type === 'Boolean' || type === 'BigInt')
      return { $t: 'Boxed', v: await encode((v as object).valueOf()) };
    if (type !== 'Array' && type !== 'Object' && type !== 'Map' && type !== 'Set')
      throw new TypeError(`Cannot export a ${type} stored in IndexedDB`);
    open.add(v);
    try {
      const out: unknown[] = [];
      if (type === 'Array') {
        const list = v as unknown[];
        for (let i = 0; i < list.length; i++) out.push(await encode(list[i]));
        return { $t: 'Array', v: out };
      }
      if (type === 'Set') {
        for (const item of v as Set<unknown>) out.push(await encode(item));
        return { $t: 'Set', v: out };
      }
      const entries =
        type === 'Map' ? [...(v as Map<unknown, unknown>)] : Object.entries(v as object);
      for (const [key, item] of entries) out.push([await encode(key), await encode(item)]);
      return { $t: type, v: out };
    } finally {
      open.delete(v);
    }
  };
  return encode(value);
}

/** Inverse of encodeValue(). Runs in the page as well as here, so it refers to nothing outside. */
export function decodeValue(value: unknown): unknown {
  const VIEWS = [
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float16Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
    'DataView',
  ];
  const bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const decode = (encoded: any): unknown => {
    if (encoded === null || typeof encoded !== 'object') return encoded;
    const { $t: tag, v } = encoded;
    switch (tag) {
      case 'undefined':
        return undefined;
      case 'BigInt':
        return BigInt(v);
      case 'Number':
        return Number(v);
      case 'Date':
        return new Date(Number(v));
      case 'RegExp':
        return new RegExp(v[0], v[1]);
      case 'ArrayBuffer':
        return bytes(v).buffer;
      case 'Blob':
        return new Blob([bytes(v)], { type: encoded.type });
      case 'File':
        return new File([bytes(v)], encoded.name, {
          type: encoded.type,
          lastModified: encoded.lastModified,
        });
      case 'Boxed':
        return Object(decode(v));
      case 'Array':
        return v.map(decode);
      case 'Set':
        return new Set(v.map(decode));
      case 'Map':
        return new Map(v.map(([k, item]: unknown[]) => [decode(k), decode(item)]));
      case 'Object':
        return Object.fromEntries(v.map(([k, item]: unknown[]) => [decode(k), decode(item)]));
    }
    if (VIEWS.includes(tag)) return new (globalThis as any)[tag](bytes(v).buffer);
    throw new TypeError(`Unknown value tag in storage state: ${tag}`);
  };
  return decode(value);
}

/** Runs in the isolated world of an empty page of the origin. */
async function readDatabases(
  encode: typeof encodeValue,
  { origin, left }: { origin: string; left: number },
): Promise<{ databases: IndexedDBDatabase[]; left: number }> {
  if (location.origin !== origin)
    throw new Error(`Storage belongs to ${location.origin}, expected ${origin}`);
  const done = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const budget = { left };
  const databases: IndexedDBDatabase[] = [];
  for (const { name } of await indexedDB.databases()) {
    if (name === undefined) continue;
    const opening = indexedDB.open(name);
    // Only a database deleted since it was listed gets here; opening must not create it.
    opening.onupgradeneeded = () => opening.transaction!.abort();
    const db = await done(opening).catch((error: DOMException) => {
      if (error.name === 'AbortError') return undefined;
      throw error;
    });
    if (!db) continue;
    try {
      const stores: IndexedDBStore[] = [];
      for (const storeName of Array.from(db.objectStoreNames)) {
        const shape = db.transaction(storeName, 'readonly').objectStore(storeName);
        const records: IndexedDBStore['records'] = [];
        const store: IndexedDBStore = {
          name: storeName,
          keyPath: shape.keyPath,
          autoIncrement: shape.autoIncrement,
          indexes: Array.from(shape.indexNames, (indexName) => {
            const { keyPath, unique, multiEntry } = shape.index(indexName);
            return { name: indexName, keyPath, unique, multiEntry };
          }),
          records,
        };
        // Batches, as a transaction ends across the awaits of encoding Blobs.
        let range: IDBKeyRange | undefined;
        for (;;) {
          const batch = db.transaction(storeName, 'readonly').objectStore(storeName);
          const [keys, values] = await Promise.all([
            done(batch.getAllKeys(range, 500)),
            done(batch.getAll(range, 500)),
          ]);
          for (let i = 0; i < keys.length; i++)
            records.push({
              key: await encode(keys[i], budget),
              value: await encode(values[i], budget),
            });
          if (keys.length < 500) break;
          range = IDBKeyRange.lowerBound(keys[keys.length - 1], true);
        }
        stores.push(store);
      }
      databases.push({ name, version: db.version, stores });
    } finally {
      db.close();
    }
  }
  return { databases, left: budget.left };
}

/** Runs in the isolated world of an empty page of the origin. */
async function writeDatabases(
  decode: typeof decodeValue,
  {
    origin,
    databases,
    blocked,
  }: { origin: string; databases: IndexedDBDatabase[]; blocked: string },
): Promise<void> {
  if (location.origin !== origin)
    throw new Error(`Storage belongs to ${location.origin}, expected ${origin}`);
  for (const { name, version, stores } of databases) {
    await new Promise<void>((resolve, reject) => {
      const deleting = indexedDB.deleteDatabase(name);
      deleting.onsuccess = () => resolve();
      deleting.onerror = () => reject(deleting.error);
      deleting.onblocked = () => reject(new Error(`${blocked}:${name}`));
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name, version);
      opening.onupgradeneeded = () => {
        for (const { name: storeName, keyPath, autoIncrement, indexes } of stores) {
          const store = opening.result.createObjectStore(storeName, { keyPath, autoIncrement });
          for (const index of indexes)
            store.createIndex(index.name, index.keyPath, {
              unique: index.unique,
              multiEntry: index.multiEntry,
            });
        }
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      if (!stores.length) continue;
      const transaction = db.transaction(
        stores.map((store) => store.name),
        'readwrite',
      );
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        for (const { name: storeName, keyPath, records } of stores) {
          const store = transaction.objectStore(storeName);
          for (const { key, value } of records)
            if (keyPath === null) store.put(decode(value), decode(key) as IDBValidKey);
            else store.put(decode(value));
        }
      });
    } finally {
      db.close();
    }
  }
}

/** Every database of the frame's origin, charged to `budget`. */
export async function exportIndexedDB(
  frame: Frame,
  origin: string,
  budget: ByteBudget,
): Promise<IndexedDBDatabase[]> {
  const argument = JSON.stringify({ origin, left: budget.left });
  const { databases, left } = await frame.evaluate<{
    databases: IndexedDBDatabase[];
    left: number;
  }>(`(${readDatabases})(${encodeValue}, ${argument})`, undefined, { world: 'isolated' });
  budget.left = left;
  return databases;
}

/** Replaces the listed databases of the frame's origin; see blockedDatabase() for a refusal. */
export async function importIndexedDB(
  frame: Frame,
  origin: string,
  databases: IndexedDBDatabase[],
): Promise<void> {
  const argument = JSON.stringify({ origin, databases, blocked: BLOCKED });
  await frame.evaluate(`(${writeDatabases})(${decodeValue}, ${argument})`, undefined, {
    world: 'isolated',
  });
}
/** The database named by a failure of importIndexedDB() that another connection blocked. */
export function blockedDatabase(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : String(error);
  return new RegExp(`${BLOCKED}:(.*)`).exec(text)?.[1];
}
