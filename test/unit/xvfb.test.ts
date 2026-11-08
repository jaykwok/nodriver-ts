import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Browser, TimeoutError } from '../../src/index.ts';
import { checkXvfbOptions, xauthRecord, XvfbSession } from '../../src/optional/xvfb.ts';

const linux = process.platform === 'linux';

test('an Xauthority record has big-endian lengths and the magic cookie name', () => {
  const cookie = Buffer.alloc(16, 0xab);
  assert.deepEqual(
    xauthRecord('42', cookie),
    Buffer.concat([
      Buffer.from([0xff, 0xff, 0, 0, 0, 2]),
      Buffer.from('42'),
      Buffer.from([0, 18]),
      Buffer.from('MIT-MAGIC-COOKIE-1'),
      Buffer.from([0, 16]),
      cookie,
    ]),
  );
});

test('virtualDisplay is refused with headless and for invalid options', async () => {
  await assert.rejects(
    Browser.launch({ virtualDisplay: true, headless: true, executablePath: 'unused' }),
    /do not set headless/,
  );
  if (!linux) {
    assert.throws(() => checkXvfbOptions({}), /only supported on Linux/);
    await assert.rejects(XvfbSession.start(), /only supported on Linux/);
    await assert.rejects(
      Browser.launch({ virtualDisplay: true, executablePath: 'unused' }),
      /only supported on Linux/,
    );
    return;
  }
  assert.throws(() => checkXvfbOptions({ screen: 'big' }), /1920x1080x24/);
  assert.throws(() => checkXvfbOptions({ timeout: 0 }), /positive/);
});

/** Temporary directories of servers, to see what a test leaves behind. */
const leftovers = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith('nodriver-xvfb-')).length;

/** An executable that records its arguments, then runs `body`. */
async function fake(t: TestContext, body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'nodriver-fake-x-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'Xvfb');
  const record = join(directory, 'args');
  await writeFile(
    executable,
    `#!/bin/sh\necho "$@" > ${record}\necho $$ > ${record}.pid\n${body}\n`,
  );
  await chmod(executable, 0o755);
  return { executable, record };
}
const REPORT = 'echo 77 >&3\nexec sleep 60';
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  'a server is started with its display, cookies and no TCP, and stops cleanly',
  { skip: !linux },
  async (t) => {
    const before = await leftovers();
    const { executable, record } = await fake(t, REPORT);
    const session = await XvfbSession.start({ executable, screen: '800x600x16' });
    assert.equal(session.display, ':77');
    assert.equal(session.env.DISPLAY, ':77');
    const args = (await readFile(record, 'utf8')).trim().split(' ');
    assert.deepEqual(args.slice(0, 4), ['-displayfd', '3', '-nolisten', 'tcp']);
    assert.deepEqual(args.slice(-3), ['-screen', '0', '800x600x16']);
    const serverAuth = args[args.indexOf('-auth') + 1]!;
    const server = await readFile(serverAuth);
    const client = await readFile(session.env.XAUTHORITY);
    // The same random cookie, the last 16 bytes of each record.
    assert.deepEqual(server.subarray(-16), client.subarray(-16));
    assert.ok(client.includes(Buffer.from('77')));
    assert.equal((await stat(serverAuth)).mode & 0o777, 0o600);
    assert.equal((await stat(session.env.XAUTHORITY)).mode & 0o777, 0o600);
    const pid = Number(await readFile(`${record}.pid`, 'utf8'));
    assert.ok(alive(pid));
    await session.stop();
    await session.stop();
    assert.ok(!alive(pid));
    await assert.rejects(access(serverAuth));
    assert.equal(await leftovers(), before);
  },
);

test('start reports a server that exits, with its output', { skip: !linux }, async (t) => {
  const before = await leftovers();
  const { executable } = await fake(t, 'echo cannot open >&2\nexit 3');
  await assert.rejects(XvfbSession.start({ executable }), /exited \(3\).*cannot open/s);
  assert.equal(await leftovers(), before);
});

test('start reports a missing program and an invalid display', { skip: !linux }, async (t) => {
  const before = await leftovers();
  await assert.rejects(XvfbSession.start({ executable: '/nonexistent/Xvfb' }), /ENOENT/);
  const { executable } = await fake(t, 'echo nope >&3\nexec sleep 60');
  await assert.rejects(XvfbSession.start({ executable }), /invalid display/);
  assert.equal(await leftovers(), before);
});

test('a timeout or abort ends a server that does not report', { skip: !linux }, async (t) => {
  const before = await leftovers();
  const { executable, record } = await fake(t, 'exec sleep 60');
  await assert.rejects(XvfbSession.start({ executable, timeout: 100 }), TimeoutError);
  assert.ok(!alive(Number(await readFile(`${record}.pid`, 'utf8'))));
  const controller = new AbortController();
  const starting = XvfbSession.start({ executable, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Stopped by test')), 100);
  await assert.rejects(starting, /Stopped by test/);
  assert.ok(!alive(Number(await readFile(`${record}.pid`, 'utf8'))));
  assert.equal(await leftovers(), before);
});

test('a server that ignores SIGTERM is killed', { skip: !linux }, async (t) => {
  const { executable, record } = await fake(
    t,
    "trap '' TERM\necho 5 >&3\nwhile :; do sleep 0.05; done",
  );
  const session = await XvfbSession.start({ executable });
  await session.stop();
  assert.ok(!alive(Number(await readFile(`${record}.pid`, 'utf8'))));
});
