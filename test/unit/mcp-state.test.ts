import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { link, mkdtemp, readFile, readdir, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState } from '../../src/mcp/state.ts';

test('storage state rejects traversal and hard links, and replaces regular files atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nodriver-state-'));
  const directory = join(root, 'states');
  const state = { cookies: [], origins: [] };
  try {
    await expect(writeState(directory, '../outside', state)).rejects.toThrow('name');
    await writeState(directory, 'login', state);
    expect(await readState(directory, 'login')).toEqual(state);
    await writeFile(join(root, 'outside.json'), 'outside must be preserved');
    await link(join(root, 'outside.json'), join(directory, 'escape.json'));
    await expect(writeState(directory, 'escape', state)).rejects.toThrow('links');
    await expect(readState(directory, 'escape')).rejects.toThrow('links');
    expect(await readFile(join(root, 'outside.json'), 'utf8')).toBe('outside must be preserved');
    const updated = {
      cookies: [{ name: 'session', value: 'private', domain: 'fixture.test' }],
      origins: [],
    };
    await writeState(directory, 'login', updated);
    expect(await readState(directory, 'login')).toEqual(updated);
    expect((await readdir(directory)).sort()).toEqual(['escape.json', 'login.json']);
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'login.json'))).mode & 0o777).toBe(0o600);
      await symlink(join(root, 'outside.json'), join(directory, 'symbolic.json'));
      await expect(writeState(directory, 'symbolic', state)).rejects.toThrow('links');
      await expect(readState(directory, 'symbolic')).rejects.toThrow('links');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
