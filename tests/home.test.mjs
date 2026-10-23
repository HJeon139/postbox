// #90: the person’s data lives in ~/.postbox (POSTBOX_HOME moves it, --data wins), a clone’s data/ with conversations
// keeps working until the person moves it, and /media/ serves what agents add to the data folder beside the bundled
// media. Everything runs in temp folders, so nothing touches the real home folder or the clone’s data/.

import assert from 'node:assert/strict';
import { existsSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { dataFolder, holdsStore, lockData, moveData, postboxHome } from '../server/home.mjs';
import { fakeRequest } from './fake-http.mjs';

let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pb-home-'));
});
after(() => rm(tmp, { recursive: true, force: true }));

/** A clone (or an installed package) and a home folder, fresh for each test. */
async function setup(name) {
  const root = join(tmp, name, 'postbox');
  const home = join(tmp, name, 'home');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  return { root, home };
}

test('the data folder is ~/.postbox, or POSTBOX_HOME, and --data wins over both', async () => {
  const { root, home } = await setup('order');
  assert.equal(postboxHome({}, home), join(home, '.postbox'));
  assert.deepEqual(dataFolder({ root, env: {}, home }), { dataDir: join(home, '.postbox'), from: 'home', home: join(home, '.postbox') });
  const moved = join(tmp, 'order', 'elsewhere');
  assert.equal(dataFolder({ root, env: { POSTBOX_HOME: moved }, home }).dataDir, moved);
  const flag = join(tmp, 'order', 'flag');
  assert.deepEqual(dataFolder({ data: flag, root, env: { POSTBOX_HOME: moved }, home }), { dataDir: flag, from: 'flag', home: moved });
});

test('a clone whose data/ holds conversations keeps using it; an empty or unrelated data/ doesn’t count', async () => {
  const { root, home } = await setup('clone');
  await mkdir(join(root, 'data', 'demo'), { recursive: true });
  assert.equal(holdsStore(join(root, 'data')), false);
  assert.equal(dataFolder({ root, env: {}, home }).from, 'home');
  await writeFile(join(root, 'data', 'events-1.jsonl'), '');
  assert.equal(holdsStore(join(root, 'data')), true);
  assert.deepEqual(dataFolder({ root, env: {}, home }), { dataDir: join(root, 'data'), from: 'clone', home: join(home, '.postbox') });
  // --data still wins over the clone’s folder, and so does a POSTBOX_HOME the person set.
  assert.equal(dataFolder({ data: join(tmp, 'x'), root, env: {}, home }).from, 'flag');
  assert.deepEqual(dataFolder({ root, env: { POSTBOX_HOME: join(home, 'pb') }, home }).from, 'home');
});

test('a clone’s data/ that links to another disk is still the clone’s data, and --move-data leaves it alone', async () => {
  const { root, home } = await setup('linked');
  const external = join(tmp, 'linked', 'external');
  await mkdir(external);
  await writeFile(join(external, 'snapshot.json'), '{}');
  await symlink(external, join(root, 'data'));
  assert.deepEqual(dataFolder({ root, env: {}, home }), { dataDir: join(root, 'data'), from: 'clone', home: join(home, '.postbox') });
  await assert.rejects(moveData({ root, env: {}, home }), /is a link to .*won’t move it/);
  assert.ok(existsSync(join(external, 'snapshot.json')));
});

test('--move-data refuses a POSTBOX_HOME inside data/, or data/ itself, before touching anything', async () => {
  const { root, home } = await setup('inside');
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'events-1.jsonl'), '');
  await assert.rejects(moveData({ root, env: { POSTBOX_HOME: join(root, 'data', 'sub') }, home }), /inside one another/);
  assert.equal(existsSync(join(root, 'data', 'sub')), false);
  await assert.rejects(moveData({ root, env: { POSTBOX_HOME: join(root, 'data') }, home }), /already leads to/);
  assert.ok(holdsStore(join(root, 'data')));
});

test('one Postbox per data folder: a running one’s lock refuses a second, and a dead one’s is taken over', async () => {
  const dir = join(tmp, 'lock');
  const release = lockData(dir);
  assert.equal(await readFile(join(dir, 'postbox.lock'), 'utf8'), String(process.pid));
  release();
  assert.equal(existsSync(join(dir, 'postbox.lock')), false);
  // The parent process (the test runner) is alive: its lock holds.
  writeFileSync(join(dir, 'postbox.lock'), String(process.ppid));
  assert.throws(() => lockData(dir), new RegExp(`Another Postbox \\(process ${process.ppid}\\) is using`));
  // A lock no running process holds is stale.
  writeFileSync(join(dir, 'postbox.lock'), '2147483646');
  lockData(dir)();
  // --move-data won’t move a folder a Postbox is running on.
  const { root, home } = await setup('busy');
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'events-1.jsonl'), '');
  writeFileSync(join(root, 'data', 'postbox.lock'), String(process.ppid));
  await assert.rejects(moveData({ root, env: {}, home }), /Another Postbox/);
  assert.ok(holdsStore(join(root, 'data')));
  assert.equal(existsSync(join(home, '.postbox')), false);
});

test('--move-data moves a clone’s data/ to the home folder and leaves a link, so recorded paths still work', async () => {
  const { root, home } = await setup('move');
  await mkdir(join(root, 'data', 'research'), { recursive: true });
  await writeFile(join(root, 'data', 'snapshot.json'), '{"seq":3}');
  await writeFile(join(root, 'data', 'research', 'notes.md'), 'kept');
  const { from, to } = await moveData({ root, env: {}, home });
  assert.equal(to, join(home, '.postbox'));
  assert.equal(await readFile(join(to, 'snapshot.json'), 'utf8'), '{"seq":3}');
  assert.ok(lstatSync(from).isSymbolicLink());
  assert.equal(readlinkSync(from), to);
  // A folder the store recorded by its old full path still leads to the same file.
  assert.equal(await readFile(join(root, 'data', 'research', 'notes.md'), 'utf8'), 'kept');
  assert.equal(existsSync(join(to, 'postbox.lock')), false, 'the move’s own lock doesn’t stay behind');
  // The next start uses the home folder: a data/ that leads there is that folder.
  assert.deepEqual(dataFolder({ root, env: {}, home }), { dataDir: to, from: 'home', home: to });
  await assert.rejects(moveData({ root, env: {}, home }), /already leads to/);
});

test('--move-data won’t mix two stores, and moves into an empty home folder', async () => {
  const { root, home } = await setup('refuse');
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'events-1.jsonl'), '');
  await mkdir(join(home, '.postbox'));
  await writeFile(join(home, '.postbox', 'events-1.jsonl'), '');
  await assert.rejects(moveData({ root, env: {}, home }), /already has files in it/);
  // Nothing moved.
  assert.ok(holdsStore(join(root, 'data')));
  await rm(join(home, '.postbox', 'events-1.jsonl'));
  await moveData({ root, env: {}, home });
  assert.ok(existsSync(join(home, '.postbox', 'events-1.jsonl')));
});

test('/media/ serves the bundled media, then what agents added to the data folder, and nothing outside it', async () => {
  process.env.POSTBOX_BACKENDS = 'mock';
  const { start } = await import('../server/index.mjs');
  const dataDir = join(tmp, 'media-data');
  const PORT = 4751;
  const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true, claudeHome: tmp, listen: false });
  try {
    const call = (path) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, path });
    assert.equal(process.env.POSTBOX_MEDIA, join(dataDir, 'media'));
    assert.ok(existsSync(join(dataDir, 'media')), 'the media folder is made at start, so agents can copy into it');
    const bundled = await call('/media/favicon.svg');
    assert.equal(bundled.status, 200);
    assert.equal(bundled.headers['access-control-allow-origin'], '*');
    await mkdir(join(dataDir, 'media', 'frames'), { recursive: true });
    await writeFile(join(dataDir, 'media', 'frames', 'f01.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const added = await call('/media/frames/f01.svg');
    assert.equal(added.status, 200);
    assert.equal(added.headers['content-type'], 'image/svg+xml');
    assert.equal(added.headers['access-control-allow-origin'], undefined, 'another site’s script can’t read the person’s media');
    assert.match(added.headers['content-security-policy'], /^sandbox; default-src 'none'/, 'a scripted SVG opened on its own runs nothing');
    await writeFile(join(dataDir, 'media', 'F02.PNG'), 'png');
    assert.equal((await call('/media/F02.PNG')).headers['content-type'], 'image/png');
    assert.equal((await call('/media/frames/missing.svg')).status, 404);
    // Images only: a page put here would run on Postbox’s origin, with its cookie.
    await writeFile(join(dataDir, 'media', 'report.html'), '<script>fetch("/api/state")</script>');
    assert.equal((await call('/media/report.html')).status, 404);
    await writeFile(join(dataDir, 'secret.txt'), 'no');
    assert.equal((await call('/media/..%2fsecret.txt')).status, 403);
    // A link can’t lead out of the folder, nor rename a page as an image.
    await writeFile(join(dataDir, 'secret.png'), 'no');
    await symlink(join(dataDir, 'secret.png'), join(dataDir, 'media', 'out.png'));
    assert.equal((await call('/media/out.png')).status, 403);
    await symlink(join(dataDir, 'media', 'report.html'), join(dataDir, 'media', 'page.png'));
    assert.equal((await call('/media/page.png')).status, 404);
  } finally {
    await app.close();
  }
});
