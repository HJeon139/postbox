// The Redis 8 build Postbox downloads at first start (designs/508/design.md, “Storage: a Redis 8 server that Postbox
// bundles and runs”, decision 2). Redis publishes only a source tarball, so Postbox’s CI builds it for each supported
// platform (.github/workflows/redis.yml) and hosts the builds, with the source, under the AGPLv3, as the assets of one
// GitHub release. The downloader (server/redis-download.mjs) keeps a build only if its SHA-256 matches the one here.

const VERSION = '8.10.3';

export const REDIS = Object.freeze({
  version: VERSION,
  // The official tarball. Its SHA-256 is the one Redis publishes in github.com/redis/redis-hashes, README, line
  // “hash redis-8.10.3.tar.gz sha256 …” (as of its commit 3d96a387), and the one computed from a copy downloaded
  // from download.redis.io on 28 October 2026: they matched. The build workflow checks it again before building.
  source: Object.freeze({
    name: `redis-${VERSION}.tar.gz`,
    url: `https://download.redis.io/releases/redis-${VERSION}.tar.gz`,
    sha256: 'edde778f6bdee7581e42fc139ca9e07e2822212092f7501f99989656e3629d02',
  }),
  // The release the build workflow makes from the tag redis-v8.10.3, beside the same source tarball.
  release: Object.freeze({ url: `https://github.com/HJeon139/postbox/releases/download/redis-v${VERSION}` }),
  // One build per supported platform (server/redis-platform.mjs), named `<platform>-<arch>` as Node names them. Each
  // sha256 is copied from that release’s `.sha256` asset (published by workflow run 40812333929, 29 October 2026, and
  // checked against the downloaded assets); a build whose sha256 is null is never downloaded.
  targets: Object.freeze({
    'darwin-arm64': Object.freeze({
      asset: `redis-${VERSION}-darwin-arm64.tar.gz`,
      sha256: '69e888cbf14d1c2875998daee8661837b2cef2af2411fcd1dd77df8c8809d121',
    }),
    'linux-arm64': Object.freeze({ asset: `redis-${VERSION}-linux-arm64.tar.gz`, sha256: '3da2cdce73c7a6f4201564fcce118f9d3b20c3009feaf3dac016ab48e2708205' }),
    'linux-x64': Object.freeze({ asset: `redis-${VERSION}-linux-x64.tar.gz`, sha256: '1d757a056efa79cc3b47f58389b5875bde080c1cbc0d4a447ab230fcd208d80a' }),
  }),
});
