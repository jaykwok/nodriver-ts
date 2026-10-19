import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { StorageState } from '../browser/context.ts';

async function statePath(directory: string, name: string, create: boolean): Promise<string> {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name)) throw new TypeError('Invalid state name');
  if (create) await mkdir(resolve(directory), { recursive: true });
  const root = await realpath(resolve(directory));
  const path = join(root, `${name}.json`);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new TypeError('State must be a regular file without symbolic or hard links');
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path;
}

export async function readState(directory: string, name: string): Promise<StorageState> {
  const path = await statePath(directory, name, false);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new TypeError('Invalid state file');
    return JSON.parse(await file.readFile('utf8')) as StorageState;
  } finally {
    await file.close();
  }
}

export async function writeState(
  directory: string,
  name: string,
  state: StorageState,
): Promise<void> {
  const path = await statePath(directory, name, true);
  const temporary = join(dirname(path), `.state-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(state));
    } finally {
      await file.close();
    }
    // Replacing the entry avoids following links and preserves the previous state on write errors.
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
