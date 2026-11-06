import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  Browser,
  ProfileInUseError,
  findExecutable,
  updateProfileSettings,
} from '../../src/index.ts';
import { poll, removeTree } from '../../src/utils.ts';

test(
  'Windows native profile lock without a debug port is typed; an unlocked leftover is allowed',
  {
    skip: process.platform !== 'win32',
  },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'nodriver-native-lock-'));
    const marker = join(profile, 'owner-marker');
    await writeFile(marker, 'preserve');
    const child = spawn(
      await findExecutable(),
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
    try {
      await poll(
        async () => {
          if (child.exitCode !== null) throw new Error(`Owner Chrome exited: ${child.exitCode}`);
          try {
            const handle = await open(join(profile, 'lockfile'), 'r+');
            await handle.close();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EBUSY') return true;
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          return undefined;
        },
        { timeout: 15_000 },
        'native profile lock',
      );
      await assert.rejects(
        Browser.launch({ headless: true, maskHeadless: false, userDataDir: profile }),
        (error: unknown) => error instanceof ProfileInUseError && error.profile === profile,
      );
      assert.equal(child.exitCode, null);
      assert.equal(await readFile(marker, 'utf8'), 'preserve');
      await assert.rejects(access(join(profile, '.nodriver.lock')), { code: 'ENOENT' });
    } finally {
      if (child.pid && child.exitCode === null) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        await new Promise<void>((resolve, reject) => {
          killer.once('close', () => resolve());
          killer.once('error', reject);
        });
      }
      await exited;
      // An existence-only check would reject this harmless leftover.
      try {
        await writeFile(join(profile, 'lockfile'), '');
        await using browser = await Browser.launch({
          headless: true,
          maskHeadless: false,
          userDataDir: profile,
        });
        assert.equal(await browser.tabs[0]!.evaluate('1 + 1'), 2);
      } finally {
        await removeTree(profile);
      }
    }
  },
);

test('prepareProfile prepares temporary and persistent profiles before Chrome starts', async () => {
  let directory = '';
  {
    await using browser = await Browser.launch({
      headless: true,
      prepareProfile: async (dir, options) => {
        directory = dir;
        assert.ok(options.timeout! > 0);
        await mkdir(join(dir, 'Default'), { recursive: true });
        await writeFile(
          join(dir, 'Default', 'Preferences'),
          JSON.stringify({ intl: { accept_languages: 'fr-FR,fr' } }),
        );
      },
    });
    const tab = await browser.newTab();
    assert.deepEqual(await tab.evaluate('navigator.languages'), ['fr-FR', 'fr']);
  }
  await assert.rejects(access(directory));
  // A failing hook ends the launch before Chrome starts and removes the directory.
  const failed = await Browser.launch({
    headless: true,
    prepareProfile: (dir) => {
      directory = dir;
      throw new Error('refused');
    },
  }).catch((error: unknown) => error);
  assert.match(String(failed), /refused/);
  await assert.rejects(access(directory));
  // A persistent profile is prepared while this process holds its lock, and kept.
  const persistent = await mkdtemp(join(tmpdir(), 'nodriver-prepared-'));
  try {
    {
      await using browser = await Browser.launch({
        headless: true,
        userDataDir: persistent,
        prepareProfile: async (dir) => {
          assert.equal(dir, persistent);
          await access(join(dir, '.nodriver.lock'));
          await updateProfileSettings(dir, {
            preferences: { intl: { accept_languages: 'de-DE,de' } },
          });
        },
      });
      const tab = await browser.newTab();
      assert.deepEqual(await tab.evaluate('navigator.languages'), ['de-DE', 'de']);
    }
    await access(persistent);
  } finally {
    await removeTree(persistent);
  }
});
