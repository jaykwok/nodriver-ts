import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import type { SavedStorageState } from './context.ts';

/** 32 raw key bytes, or a passphrase that scrypt turns into a key. */
export type StateKey = Uint8Array | string;

const MAGIC = Buffer.from('NDSTATE1', 'latin1');
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 };
/** Bounds a header's work factors, which are read before anything is authenticated. */
const MAX_COST = 2 ** 20;
const FAILED = 'Cannot decrypt the state: wrong key, or the file was changed';
interface Header {
  iv: string;
  scrypt?: { salt: string; N: number; r: number; p: number };
}

function derive(passphrase: string, salt: Buffer, { N, r, p }: typeof SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N, r, p, maxmem: 256 * N * r }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}
function rawKey(key: Uint8Array): Buffer {
  if (key.length !== 32) throw new RangeError('A state key must be 32 bytes');
  return Buffer.from(key);
}
function prefix(header: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, length, header]);
}

/** Whether these bytes are the output of encryptState(). */
export function isEncryptedState(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC);
}

/** AES-256-GCM over the JSON of a state; the header, with the KDF parameters, is authenticated. */
export async function encryptState(state: SavedStorageState, key: StateKey): Promise<Buffer> {
  const iv = randomBytes(12);
  const header: Header = { iv: iv.toString('base64') };
  let secret: Buffer;
  if (typeof key === 'string') {
    if (!key) throw new RangeError('A state passphrase must not be empty');
    const salt = randomBytes(16);
    header.scrypt = { salt: salt.toString('base64'), ...SCRYPT };
    secret = await derive(key, salt, SCRYPT);
  } else secret = rawKey(key);
  const aad = prefix(Buffer.from(JSON.stringify(header)));
  const cipher = createCipheriv('aes-256-gcm', secret, iv).setAAD(aad);
  const body = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return Buffer.concat([aad, body, cipher.getAuthTag()]);
}

export async function decryptState(bytes: Uint8Array, key: StateKey): Promise<SavedStorageState> {
  const data = Buffer.from(bytes);
  if (!isEncryptedState(data)) throw new TypeError('Not an encrypted state');
  const start = MAGIC.length + 4;
  if (data.length < start + 16) throw new Error(FAILED);
  const end = start + data.readUInt32BE(MAGIC.length);
  if (end + 16 > data.length) throw new Error(FAILED);
  let header: Header;
  try {
    header = JSON.parse(data.toString('utf8', start, end)) as Header;
  } catch (cause) {
    throw new Error(FAILED, { cause });
  }
  const iv = Buffer.from(String(header.iv), 'base64');
  if (iv.length !== 12) throw new Error(FAILED);
  let secret: Buffer;
  if (typeof key === 'string') {
    const kdf = header.scrypt;
    if (
      !kdf ||
      !Number.isInteger(kdf.N) ||
      kdf.N < 2 ||
      kdf.N > MAX_COST ||
      (kdf.N & (kdf.N - 1)) !== 0 ||
      !Number.isInteger(kdf.r) ||
      kdf.r < 1 ||
      kdf.r > 32 ||
      !Number.isInteger(kdf.p) ||
      kdf.p < 1 ||
      kdf.p > 16
    )
      throw new Error(FAILED);
    secret = await derive(key, Buffer.from(String(kdf.salt), 'base64'), kdf).catch(
      (cause: unknown) => {
        throw new Error(FAILED, { cause });
      },
    );
  } else {
    secret = rawKey(key);
    if (header.scrypt) throw new Error(FAILED);
  }
  const decipher = createDecipheriv('aes-256-gcm', secret, iv).setAAD(data.subarray(0, end));
  decipher.setAuthTag(data.subarray(data.length - 16));
  try {
    const plain = Buffer.concat([
      decipher.update(data.subarray(end, data.length - 16)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as SavedStorageState;
  } catch (cause) {
    throw new Error(FAILED, { cause });
  }
}
