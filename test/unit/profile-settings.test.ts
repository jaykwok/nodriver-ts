import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Browser, NodriverError, updateProfileSettings } from '../../src/index.ts';

test('updateProfileSettings merges into Local State and Preferences and keeps other keys', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nodriver-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'Local State'),
    JSON.stringify({ browser: { enabled_labs_experiments: ['a'] }, signin: { other: 1 } }),
  );
  await updateProfileSettings(directory, {
    localState: { signin: { allowed_on_device: false }, list: [1, 2] },
    preferences: { profile: { password_manager_enabled: false } },
  });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'Local State'), 'utf8')), {
    browser: { enabled_labs_experiments: ['a'] },
    signin: { other: 1, allowed_on_device: false },
    list: [1, 2],
  });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'Default', 'Preferences'), 'utf8')), {
    profile: { password_manager_enabled: false },
  });
  // Arrays and scalars replace; a second update keeps the first.
  await updateProfileSettings(directory, { localState: { list: [3] } });
  const state = JSON.parse(await readFile(join(directory, 'Local State'), 'utf8'));
  assert.deepEqual(state.list, [3]);
  assert.equal(state.signin.allowed_on_device, false);
});

test('updateProfileSettings refuses to rewrite a damaged file or leave the profile directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nodriver-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'Work'));
  await writeFile(join(directory, 'Work', 'Preferences'), '{"profile": ');
  await assert.rejects(
    updateProfileSettings(directory, { profile: 'Work', preferences: { a: 1 } }),
    (error: unknown) => error instanceof NodriverError && /not valid JSON/.test(error.message),
  );
  assert.equal(await readFile(join(directory, 'Work', 'Preferences'), 'utf8'), '{"profile": ');
  await assert.rejects(
    updateProfileSettings(directory, { profile: '..', preferences: {} }),
    TypeError,
  );
  await assert.rejects(
    updateProfileSettings(directory, { profile: 'a/b', preferences: {} }),
    TypeError,
  );
});

test('prepareProfile is told whether the profile is temporary and holds earlier data', async () => {
  const seen: Array<{ temporary: boolean; empty: boolean; files: string[] }> = [];
  const launch = (userDataDir?: string) =>
    Browser.launch({
      // Never started: preparation ends the launch first.
      executablePath: process.execPath,
      userDataDir,
      prepareProfile: async (dir, { temporary, empty }) => {
        seen.push({ temporary, empty, files: await readdir(dir) });
        throw new Error('stop before Chrome starts');
      },
    }).catch((error: unknown) => assert.match(String(error), /stop before Chrome starts/));
  const root = await mkdtemp(join(tmpdir(), 'nodriver-preparation-'));
  try {
    await launch();
    const persistent = join(root, 'missing');
    await launch(persistent);
    await launch(persistent); // after a failed launch
    await writeFile(join(persistent, 'Local State'), '{}');
    await launch(persistent);
    // Only the library's lock files are ignored, not other names that start the same way.
    const prefixed = join(root, 'prefixed');
    await mkdir(join(prefixed, '.nodriver.lock.data'), { recursive: true });
    await launch(prefixed);
    assert.deepEqual(
      seen.map(({ temporary, empty }) => ({ temporary, empty })),
      [
        { temporary: true, empty: true },
        { temporary: false, empty: true },
        { temporary: false, empty: true },
        { temporary: false, empty: false },
        { temporary: false, empty: false },
      ],
    );
    // The lock is held while preparing, and its file does not count as data.
    assert.ok(seen[1]!.files.includes('.nodriver.lock'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
