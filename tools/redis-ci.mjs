// Gets Postbox’s pinned Redis build for the CI runner (.github/workflows/check.yml), through the same code Postbox’s
// first start runs (designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and runs”, decision 2):
// server/redis-download.mjs keeps the archive only once its SHA-256 matches the pin in server/redis-build.mjs, and
// server/redis-unpack.mjs unpacks only a verified archive, in Node, with the execute bits Redis needs on bin/redis-server
// and modules/*.so. Nothing is spawned here. Tests never touch the network (tests/guard.mjs), so the suite takes the
// build through POSTBOX_REDIS_HOME (tests/AGENTS.md, “The store’s Redis”), which this writes to $GITHUB_ENV for the
// steps after it.
//
//   node tools/redis-ci.mjs pin                         this platform’s target, version, asset and pinned sha256, one
//                                                       name=value a line: the cache key, and the archive’s path
//   node tools/redis-ci.mjs prepare <folder> [archive]  verifies and unpacks under <folder>/redis/<version>/, prints the
//                                                       home, and appends POSTBOX_REDIS_HOME=<home> to $GITHUB_ENV
//
// With an archive, that file stands in for the download, so a copy already on disk is verified and unpacked without the
// network; without one, the release asset is downloaded. An archive already under <folder> is hashed again and kept, so
// a cache of it (actions/cache, keyed on the pinned sha256) saves the download, and a damaged one is replaced.

import { createReadStream } from 'node:fs';
import { appendFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { REDIS } from '../server/redis-build.mjs';
import { fetchRedisBuild } from '../server/redis-download.mjs';
import { checkPlatform } from '../server/redis-platform.mjs';
import { unpackRedisBuild } from '../server/redis-unpack.mjs';

/** @param {string} code @param {string} message */
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * The pin for this platform: what the download will be checked against. Throws EPLATFORM or ENOPIN like the download.
 * @param {{ platform?: string, arch?: string, build?: typeof REDIS }} [o]
 * @returns {{ target: string, version: string, asset: string, sha256: string }}
 */
export function pinFor({ platform = process.platform, arch = process.arch, build = REDIS } = {}) {
  const where = checkPlatform({ platform, arch });
  if (!where.ok) throw fail('EPLATFORM', where.message);
  const entry = Object.hasOwn(build.targets, where.target) ? build.targets[where.target] : null;
  if (!entry?.sha256) throw fail('ENOPIN', `server/redis-build.mjs has no SHA-256 for ${entry?.asset ?? where.target}, so there’s no build to verify.`);
  return { target: where.target, version: build.version, asset: entry.asset, sha256: entry.sha256 };
}

/**
 * A fetch that answers every request with one local file, so the downloader hashes and keeps it as it would a download.
 * @param {string} archive
 * @returns {(url: string) => Promise<Response>}
 */
export const fileFetch = (archive) => async () => {
  const s = await stat(archive).catch(() => null);
  if (!s?.isFile()) throw new Error(`the archive ${archive} isn’t there`);
  return new Response(/** @type {any} */ (Readable.toWeb(createReadStream(archive))), { status: 200 });
};

/**
 * Verifies this platform’s build and unpacks it under dir/redis/<version>/<target>: the folder with bin/redis-server.
 * @param {object} o
 * @param {string} o.dir  where the archive is kept and the build unpacked
 * @param {string} [o.archive]  a local copy of the release asset, instead of downloading it
 * @param {string} [o.githubEnv]  the file to append POSTBOX_REDIS_HOME to ($GITHUB_ENV)
 * @param {string} [o.platform]  @param {string} [o.arch]  @param {typeof REDIS} [o.build]
 * @param {(url: string) => Promise<Response>} [o.fetch]  the download, when there’s no archive
 * @returns {Promise<{ home: string, path: string, sha256: string, downloaded: boolean }>}
 */
export async function prepareRedis({ dir, archive, githubEnv, platform = process.platform, arch = process.arch, build = REDIS, fetch = globalThis.fetch }) {
  const pin = pinFor({ platform, arch, build });
  const got = await fetchRedisBuild({ dataDir: dir, platform, arch, build, fetch: archive ? fileFetch(archive) : fetch });
  const home = await unpackRedisBuild({ path: got.path, sha256: got.sha256, dataDir: dir, version: pin.version, target: pin.target });
  if (githubEnv) await appendFile(githubEnv, `POSTBOX_REDIS_HOME=${home}\n`);
  return { home, ...got };
}

async function main(argv) {
  const [cmd, dir, archive] = argv;
  if (cmd === 'pin' && !dir) {
    for (const [k, v] of Object.entries(pinFor())) console.log(`${k}=${v}`);
    return;
  }
  if (cmd === 'prepare' && dir && argv.length <= 3) {
    const got = await prepareRedis({ dir, archive, githubEnv: process.env.GITHUB_ENV });
    console.log(`${got.downloaded ? 'Downloaded' : 'Kept'} ${got.path} (SHA-256 ${got.sha256}); POSTBOX_REDIS_HOME=${got.home}`);
    return;
  }
  throw fail('EUSAGE', 'Usage: node tools/redis-ci.mjs pin | prepare <folder> [archive]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
