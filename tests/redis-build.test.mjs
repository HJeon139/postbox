// The pinned Redis 8 build (server/redis-build.mjs; designs/508/design.md, “Storage: a Redis 8 server that Postbox
// bundles and runs”, decision 2): Redis 8.10.3’s official source tarball and its SHA-256, and one build per supported
// platform. With POSTBOX_REDIS_TARBALL set to a downloaded copy of the tarball, the last test hashes it too: the build
// workflow (.github/workflows/redis.yml) runs it that way before it builds anything.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { test } from 'node:test';
import { REDIS } from '../server/redis-build.mjs';

test('every supported platform has a build in the pinned manifest, and nothing else does', () => {
  assert.deepEqual(Object.keys(REDIS.targets).sort(), ['darwin-arm64', 'linux-arm64', 'linux-x64']);
  for (const [target, entry] of Object.entries(REDIS.targets)) {
    assert.equal(entry.asset, `redis-${REDIS.version}-${target}.tar.gz`);
    // Filled in from the release the build workflow makes; until then the downloader refuses (ENOPIN).
    assert.ok(entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256), target);
  }
});

test('the manifest pins Redis 8.10.3’s official source tarball and its published SHA-256', () => {
  assert.equal(REDIS.version, '8.10.3');
  assert.equal(REDIS.source.url, 'https://download.redis.io/releases/redis-8.10.3.tar.gz');
  // Published in github.com/redis/redis-hashes, README, line “hash redis-8.10.3.tar.gz sha256 …” (commit 3d96a387),
  // and the SHA-256 of the tarball downloaded from download.redis.io on 28 October 2026, computed and compared here.
  assert.equal(REDIS.source.sha256, 'edde778f6bdee7581e42fc139ca9e07e2822212092f7501f99989656e3629d02');
});

test('the source tarball named by POSTBOX_REDIS_TARBALL has the pinned SHA-256', {
  skip: !process.env.POSTBOX_REDIS_TARBALL && 'POSTBOX_REDIS_TARBALL is unset',
}, async () => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(String(process.env.POSTBOX_REDIS_TARBALL))) hash.update(chunk);
  assert.equal(hash.digest('hex'), REDIS.source.sha256);
});
