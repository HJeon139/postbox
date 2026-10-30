// The CI tool that gets the store’s Redis for a runner (tools/redis-ci.mjs; .github/workflows/check.yml): it goes
// through Postbox’s own downloader and unpacker, so an archive is unpacked and named in POSTBOX_REDIS_HOME only once its
// SHA-256 matches the pin, a mismatch leaves nothing behind, and the tool itself spawns nothing. The archive is a
// local file standing in for the download, as the tool takes it; nothing touches the network.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { REDIS } from '../server/redis-build.mjs';
import { pinFor, prepareRedis } from '../tools/redis-ci.mjs';
import { tarOf } from './redis-tar-fixture.mjs';

let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pb-redis-ci-'));
});
after(() => rm(tmp, { recursive: true, force: true }));

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const GOOD = tarOf([
  { name: 'redis-8.10.3-darwin-arm64/', type: '5', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/bin/', type: '5', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/bin/redis-server', body: '#!fake server', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/modules/rejson.so', body: 'json', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/modules/redisearch.so', body: 'search', mode: 0o755 },
  { name: 'redis-8.10.3-darwin-arm64/LICENSE.txt', body: 'AGPLv3' },
]);
const mac = { platform: 'darwin', arch: 'arm64' };
/** A manifest shaped like server/redis-build.mjs’s, pinning GOOD for macOS and nothing for Linux x64. */
const build = (sha = sha256(GOOD)) => ({
  version: '8.10.3',
  release: { url: 'http://127.0.0.1:9/releases/download/redis-v8.10.3' },
  targets: {
    'darwin-arm64': { asset: 'redis-8.10.3-darwin-arm64.tar.gz', sha256: sha },
    'linux-x64': { asset: 'redis-8.10.3-linux-x64.tar.gz', sha256: null },
  },
});
const refuse = async () => {
  throw new Error('the tool reached for the network');
};
const mode = async (p) => (await stat(p)).mode & 0o777;

test('a local archive whose SHA-256 matches the pin is kept, unpacked with its execute bits, and named in GITHUB_ENV', async () => {
  const dir = join(tmp, 'good', 'redis-home');
  const archive = join(tmp, 'good', 'redis-8.10.3-darwin-arm64.tar.gz');
  const githubEnv = join(tmp, 'good', 'github.env');
  await mkdir(join(tmp, 'good'), { recursive: true });
  await writeFile(archive, GOOD);
  const got = await prepareRedis({ dir, archive, githubEnv, ...mac, build: build(), fetch: refuse });
  const home = join(dir, 'redis', '8.10.3', 'darwin-arm64');
  assert.deepEqual(got, { home, path: join(dir, 'redis', '8.10.3', 'redis-8.10.3-darwin-arm64.tar.gz'), sha256: sha256(GOOD), downloaded: true });
  assert.equal(await readFile(join(home, 'bin', 'redis-server'), 'utf8'), '#!fake server');
  // Redis loads no module without its execute bit, and the server must run: 0700, as the unpacker gives them.
  assert.equal(await mode(join(home, 'bin', 'redis-server')), 0o700);
  assert.equal(await mode(join(home, 'modules', 'rejson.so')), 0o700);
  assert.equal(await mode(join(home, 'modules', 'redisearch.so')), 0o700);
  assert.equal(await mode(join(home, 'LICENSE.txt')), 0o600);
  assert.equal(await readFile(githubEnv, 'utf8'), `POSTBOX_REDIS_HOME=${home}\n`);
  // The kept archive is what a cache saves: the next run hashes it again and skips the download, without the archive.
  const again = await prepareRedis({ dir, githubEnv, ...mac, build: build(), fetch: refuse });
  assert.equal(again.downloaded, false);
  assert.equal(again.home, home);
});

test('an archive whose SHA-256 doesn’t match the pin is refused with both hashes, and nothing is kept, unpacked or exported', async () => {
  const dir = join(tmp, 'bad', 'redis-home');
  const archive = join(tmp, 'bad', 'redis-8.10.3-darwin-arm64.tar.gz');
  const githubEnv = join(tmp, 'bad', 'github.env');
  const tampered = Buffer.concat([GOOD, Buffer.from('tampered')]);
  await mkdir(join(tmp, 'bad'), { recursive: true });
  await writeFile(archive, tampered);
  await assert.rejects(prepareRedis({ dir, archive, githubEnv, ...mac, build: build(), fetch: refuse }), (e) => {
    assert.equal(e.code, 'ECHECKSUM');
    assert.ok(e.message.includes(sha256(GOOD)), e.message);
    assert.ok(e.message.includes(sha256(tampered)), e.message);
    return true;
  });
  assert.deepEqual(await readdir(join(dir, 'redis', '8.10.3')), []);
  assert.equal(existsSync(githubEnv), false);
});

test('a damaged kept archive is replaced from the local archive, not trusted', async () => {
  const dir = join(tmp, 'damaged', 'redis-home');
  const archive = join(tmp, 'damaged', 'redis-8.10.3-darwin-arm64.tar.gz');
  await mkdir(join(dir, 'redis', '8.10.3'), { recursive: true });
  await writeFile(join(dir, 'redis', '8.10.3', 'redis-8.10.3-darwin-arm64.tar.gz'), 'a cache gone wrong');
  await writeFile(archive, GOOD);
  const got = await prepareRedis({ dir, archive, ...mac, build: build(), fetch: refuse });
  assert.equal(got.downloaded, true);
  assert.deepEqual(await readFile(got.path), GOOD);
});

test('an archive that isn’t there, a platform with no pin, and an unsupported platform are refused before anything is written', async () => {
  const dir = join(tmp, 'none');
  await assert.rejects(prepareRedis({ dir, archive: join(tmp, 'none', 'missing.tar.gz'), ...mac, build: build(), fetch: refuse }), (e) => {
    assert.equal(e.code, 'EDOWNLOAD');
    assert.match(e.message, /missing\.tar\.gz isn’t there/);
    return true;
  });
  await assert.rejects(prepareRedis({ dir, platform: 'linux', arch: 'x64', build: build(), fetch: refuse }), { code: 'ENOPIN' });
  await assert.rejects(prepareRedis({ dir, platform: 'darwin', arch: 'x64', build: build(), fetch: refuse }), { code: 'EPLATFORM' });
  assert.equal(existsSync(dir), false);
});

test('the pin it prints for the cache key is the one server/redis-build.mjs holds for that platform', () => {
  const linux = pinFor({ platform: 'linux', arch: 'x64' });
  assert.deepEqual(linux, { target: 'linux-x64', version: REDIS.version, asset: REDIS.targets['linux-x64'].asset, sha256: REDIS.targets['linux-x64'].sha256 });
  assert.match(linux.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => pinFor({ platform: 'win32', arch: 'x64' }), { code: 'EPLATFORM' });
  assert.throws(() => pinFor({ ...mac, build: build(null) }), { code: 'ENOPIN' });
});

test('the tool spawns nothing: verifying and unpacking happen in Node, and the build runs only through POSTBOX_REDIS_HOME', () => {
  const source = readFileSync(new URL('../tools/redis-ci.mjs', import.meta.url), 'utf8');
  const imports = source.match(/^import .* from '([^']+)';$/gm).map((l) => l.replace(/^.* from '([^']+)';$/, '$1'));
  assert.deepEqual(
    imports.filter((m) => m.startsWith('node:')),
    ['node:fs', 'node:fs/promises', 'node:stream', 'node:url'],
  );
  assert.doesNotMatch(source, /child_process/);
});
