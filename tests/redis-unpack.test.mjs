// Unpacking the verified Redis build (server/redis-unpack.mjs; designs/508/design.md, “Storage: a Redis 8 server that
// Postbox bundles and runs”, decision 2). Only a build whose SHA-256 matched is unpacked, in Node, from a ustar archive
// the build workflow makes. Every entry must be a plain file or folder inside the build’s own top folder: an absolute
// path, a “..”, a link or a device is refused, and nothing of a refused archive is left behind.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { redisHome, unpackRedisBuild } from '../server/redis-unpack.mjs';
import { tarOf } from './redis-tar-fixture.mjs';

let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pb-redis-unpack-'));
});
after(() => rm(tmp, { recursive: true, force: true }));

const BUILD = [
  { name: 'redis-8.10.3-darwin-arm64/', type: '5', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/bin/', type: '5', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/bin/redis-server', body: '#!fake server', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/modules/rejson.so', body: 'json', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/modules/redisearch.so', body: 'search', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/lib/', type: '5', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/lib/libssl.3.dylib', body: 'ssl', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/LICENSE.txt', body: 'AGPLv3' },
];

/** Writes an archive and returns what unpackRedisBuild takes for it. */
async function archive(name, entries) {
  const bytes = tarOf(entries);
  const path = join(tmp, `${name}.tar.gz`);
  await writeFile(path, bytes);
  const dataDir = join(tmp, name, 'data');
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), dataDir, version: '8.10.3', target: 'darwin-arm64' };
}

test('a verified build unpacks into redis/<version>/<target> under the data folder, private to the person (SR-5)', async () => {
  const a = await archive('good', BUILD);
  const home = await unpackRedisBuild(a);
  assert.equal(home, join(a.dataDir, 'redis', '8.10.3', 'darwin-arm64'));
  assert.equal(await readFile(join(home, 'bin', 'redis-server'), 'utf8'), '#!fake server');
  const mode = async (p) => (await stat(join(home, p))).mode & 0o777;
  // Executables and modules (Redis loads no module without its execute bit) are 0700; libraries and the rest, 0600.
  assert.deepEqual(
    {
      home: await mode('.'),
      bin: await mode('bin'),
      server: await mode('bin/redis-server'),
      module: await mode('modules/rejson.so'),
      lib: await mode('lib/libssl.3.dylib'),
      license: await mode('LICENSE.txt'),
      version: (await stat(join(home, '..'))).mode & 0o777,
    },
    { home: 0o700, bin: 0o700, server: 0o700, module: 0o700, lib: 0o600, license: 0o600, version: 0o700 },
  );
  assert.deepEqual((await readdir(join(home, 'modules'))).sort(), ['redisearch.so', 'rejson.so']);
});

test('a build already unpacked from the same archive is kept, not unpacked again', async () => {
  const a = await archive('again', BUILD);
  const home = await unpackRedisBuild(a);
  await writeFile(join(home, 'marker'), 'still here');
  assert.equal(await unpackRedisBuild(a), home);
  assert.equal(await readFile(join(home, 'marker'), 'utf8'), 'still here');
});

for (const [why, entry] of [
  ['a path with ..', { name: 'redis-8.10.3-darwin-arm64/../../escape', body: 'x' }],
  ['an absolute path', { name: '/tmp/escape', body: 'x' }],
  ['a path outside the build’s top folder', { name: 'other/bin/redis-server', body: 'x' }],
  ['a symbolic link', { name: 'redis-8.10.3-darwin-arm64/bin/link', type: '2', link: '/etc/passwd' }],
  ['a hard link', { name: 'redis-8.10.3-darwin-arm64/bin/hard', type: '1', link: 'redis-8.10.3-darwin-arm64/LICENSE.txt' }],
  ['a device', { name: 'redis-8.10.3-darwin-arm64/dev', type: '3' }],
])
  test(`an archive with ${why} is refused, and nothing of it is left`, async () => {
    const a = await archive(`bad-${why.replace(/\W+/g, '-')}`, [...BUILD.slice(0, 3), entry, ...BUILD.slice(3)]);
    await assert.rejects(unpackRedisBuild(a), (e) => e.code === 'EUNPACK' && /refused/i.test(e.message));
    assert.equal(existsSync(join(a.dataDir, 'redis', '8.10.3', 'darwin-arm64')), false);
    assert.deepEqual(await readdir(join(a.dataDir, 'redis', '8.10.3')).catch(() => []), []);
    assert.equal(existsSync(join(tmp, 'escape')), false);
  });

test('an archive whose SHA-256 isn’t the verified one is refused before anything is written', async () => {
  const a = await archive('changed', BUILD);
  await assert.rejects(unpackRedisBuild({ ...a, sha256: '0'.repeat(64) }), (e) => e.code === 'ECHECKSUM');
  assert.equal(existsSync(join(a.dataDir, 'redis')), false);
});

test('a damaged archive is refused with the reason', async () => {
  const a = await archive('damaged', BUILD);
  const bytes = await readFile(a.path);
  const cut = bytes.subarray(0, bytes.length - 40);
  await writeFile(a.path, cut);
  const sha256 = createHash('sha256').update(cut).digest('hex');
  await assert.rejects(unpackRedisBuild({ ...a, sha256 }), (e) => e.code === 'EUNPACK');
});

test('the build workflow archives each build as ustar, without macOS’s ._ files, so this reader takes it', () => {
  const yml = readFileSync(new URL('../.github/workflows/redis.yml', import.meta.url), 'utf8');
  assert.match(yml, /COPYFILE_DISABLE=1 tar --format=ustar -czf "redis-\$VERSION-\$POSTBOX_TARGET\.tar\.gz"/);
});

test('POSTBOX_REDIS_HOME names a Redis to use instead of the download, and nothing is fetched', async () => {
  const fetch = () => assert.fail('nothing is fetched when POSTBOX_REDIS_HOME is set');
  assert.equal(await redisHome({ dataDir: join(tmp, 'dev'), env: { POSTBOX_REDIS_HOME: '/opt/redis-dev' }, fetch }), '/opt/redis-dev');
  assert.equal(existsSync(join(tmp, 'dev')), false);
});

test('without POSTBOX_REDIS_HOME, the pinned build is downloaded and unpacked under the data folder', async () => {
  const bytes = tarOf(BUILD);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const build = {
    version: '8.10.3',
    release: { url: 'https://example.test/r' },
    targets: { 'darwin-arm64': { asset: 'redis-8.10.3-darwin-arm64.tar.gz', sha256 } },
  };
  const fetch = async () => new Response(bytes);
  const dataDir = join(tmp, 'fetched');
  const home = await redisHome({ dataDir, env: {}, fetch, build, platform: 'darwin', arch: 'arm64' });
  assert.equal(home, join(dataDir, 'redis', '8.10.3', 'darwin-arm64'));
  assert.equal(await readFile(join(home, 'bin', 'redis-server'), 'utf8'), '#!fake server');
});
