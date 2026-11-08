import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { SavedStorageState } from '../browser/context.ts';
import {
  decryptState,
  encryptState,
  isEncryptedState,
  type StateKey,
} from '../browser/state-crypto.ts';

/** A principal's name when it is safe as a path segment; otherwise a digest, too long for a name. */
function principalDirectory(principal: string): string {
  if (!principal) throw new TypeError('Invalid state principal');
  return /^[a-z0-9_-]{1,64}$/.test(principal)
    ? principal
    : `p-${createHash('sha256').update(principal).digest('hex')}`;
}

async function statePath(
  directory: string,
  principal: string,
  name: string,
  create: boolean,
): Promise<string> {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name)) throw new TypeError('Invalid state name');
  const owner = principalDirectory(principal);
  if (create) await mkdir(resolve(directory), { recursive: true });
  const parent = join(await realpath(resolve(directory)), owner);
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  // A link here would hand this principal's names to another directory.
  if (!(await lstat(parent)).isDirectory())
    throw new TypeError('State directory of a principal must be a real directory');
  const path = join(parent, `${name}.json`);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new TypeError('State must be a regular file without symbolic or hard links');
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path;
}

export async function readState(
  directory: string,
  principal: string,
  name: string,
  key?: StateKey,
): Promise<SavedStorageState> {
  try {
    const path = await statePath(directory, principal, name, false);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw new TypeError('Invalid state file');
      const bytes = await file.readFile();
      if (key === undefined && isEncryptedState(bytes))
        throw new TypeError('This state is encrypted; the host must configure stateKey');
      // With a key, a plain file is refused: replacing a file must not downgrade its protection.
      if (key !== undefined && !isEncryptedState(bytes))
        throw new TypeError('This state is not encrypted, and stateKey requires encrypted states');
      if (key !== undefined) return await decryptState(bytes, key);
      return JSON.parse(bytes.toString('utf8')) as SavedStorageState;
    } finally {
      await file.close();
    }
  } catch (cause) {
    // A missing name looks the same whoever else saved it; the file system message names host paths.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`No saved state named ${name}`, { cause });
    throw cause;
  }
}

export async function writeState(
  directory: string,
  principal: string,
  name: string,
  state: SavedStorageState,
  key?: StateKey,
): Promise<void> {
  const path = await statePath(directory, principal, name, true);
  const content = key === undefined ? JSON.stringify(state) : await encryptState(state, key);
  const temporary = join(dirname(path), `.state-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    // Replacing the entry avoids following links and preserves the previous state on write errors.
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
