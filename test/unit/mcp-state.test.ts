import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState } from '../../src/mcp/state.ts';

test('storage state rejects traversal and hard links, and replaces regular files atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nodriver-state-'));
  const directory = join(root, 'states');
  const owned = join(directory, 'alice');
  const state = { cookies: [], origins: [] };
  try {
    await expect(writeState(directory, 'alice', '../outside', state)).rejects.toThrow('name');
    await writeState(directory, 'alice', 'login', state);
    expect(await readState(directory, 'alice', 'login')).toEqual(state);
    await writeFile(join(root, 'outside.json'), 'outside must be preserved');
    await link(join(root, 'outside.json'), join(owned, 'escape.json'));
    await expect(writeState(directory, 'alice', 'escape', state)).rejects.toThrow('links');
    await expect(readState(directory, 'alice', 'escape')).rejects.toThrow('links');
    expect(await readFile(join(root, 'outside.json'), 'utf8')).toBe('outside must be preserved');
    const updated = {
      cookies: [{ name: 'session', value: 'private', domain: 'fixture.test' }],
      origins: [],
    };
    await writeState(directory, 'alice', 'login', updated);
    expect(await readState(directory, 'alice', 'login')).toEqual(updated);
    expect((await readdir(owned)).sort()).toEqual(['escape.json', 'login.json']);
    if (process.platform !== 'win32') {
      expect((await stat(join(owned, 'login.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(owned)).mode & 0o777).toBe(0o700);
      await symlink(join(root, 'outside.json'), join(owned, 'symbolic.json'));
      await expect(writeState(directory, 'alice', 'symbolic', state)).rejects.toThrow('links');
      await expect(readState(directory, 'alice', 'symbolic')).rejects.toThrow('links');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('storage state names belong to one principal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nodriver-state-'));
  const state = (value: string) => ({
    cookies: [{ name: 'session', value, domain: 'fixture.test' }],
    origins: [],
  });
  try {
    await writeState(directory, 'alice', 'login', state('alice'));
    await writeState(directory, 'bob', 'login', state('bob'));
    expect(await readState(directory, 'alice', 'login')).toEqual(state('alice'));
    expect(await readState(directory, 'bob', 'login')).toEqual(state('bob'));
    const missing = await readState(directory, 'carol', 'login').catch((error: Error) => error);
    expect(missing).toBeInstanceOf(Error);
    // The same answer as any unknown name, without the host path a file system error names.
    expect((missing as Error).message).toBe('No saved state named login');
    await expect(readState(directory, 'alice', 'other')).rejects.toThrow(
      'No saved state named other',
    );
    await expect(readState(join(directory, 'absent'), 'alice', 'login')).rejects.toThrow(
      'No saved state named login',
    );
    expect((await readdir(directory)).sort()).toEqual(['alice', 'bob']);
    await expect(writeState(directory, '', 'login', state('nobody'))).rejects.toThrow('principal');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a principal unsafe as a path segment gets a digest directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nodriver-state-'));
  const state = { cookies: [], origins: [] };
  const digest = (principal: string) => `p-${createHash('sha256').update(principal).digest('hex')}`;
  try {
    const unsafe = ['../escape', 'Alice', 'a/b', 'a\\b', 'x'.repeat(65), 'user@example.test'];
    for (const principal of unsafe) await writeState(directory, principal, 'login', state);
    // A principal named like a digest directory cannot reach that directory by name.
    const lookalike = digest('../escape');
    await writeState(directory, lookalike, 'login', state);
    expect((await readdir(directory)).sort()).toEqual([...unsafe, lookalike].map(digest).sort());
    await writeState(directory, 'x'.repeat(64), 'login', state);
    await writeState(directory, 'local-operator_1', 'login', state);
    const names = await readdir(directory);
    expect(names).toContain('x'.repeat(64));
    expect(names).toContain('local-operator_1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a link in place of a principal directory is refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nodriver-state-'));
  const state = { cookies: [], origins: [] };
  try {
    await writeState(directory, 'alice', 'login', state);
    const outside = await mkdtemp(join(tmpdir(), 'nodriver-state-outside-'));
    try {
      // Junctions need no privilege on Windows; Node.js reports them as symbolic links.
      await symlink(join(directory, 'alice'), join(directory, 'bob'), 'junction');
      await expect(readState(directory, 'bob', 'login')).rejects.toThrow('real directory');
      await expect(writeState(directory, 'bob', 'other', state)).rejects.toThrow('real directory');
      await symlink(outside, join(directory, 'carol'), 'junction');
      await expect(writeState(directory, 'carol', 'login', state)).rejects.toThrow(
        'real directory',
      );
      expect(await readdir(outside)).toEqual([]);
      expect(await readdir(join(directory, 'alice'))).toEqual(['login.json']);
      await writeFile(join(directory, 'dave'), 'a file');
      await expect(readState(directory, 'dave', 'login')).rejects.toThrow('real directory');
      await mkdir(join(directory, 'erin'));
      await expect(readState(directory, 'erin', 'login')).rejects.toThrow('No saved state');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
