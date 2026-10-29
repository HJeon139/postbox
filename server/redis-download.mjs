// Downloads Postbox’s Redis 8 build for this platform (designs/508/design.md, “Storage: a Redis 8 server that Postbox
// bundles and runs”, decision 2, and “Failure modes”). The build streams to a temporary file beside where it’s kept,
// hashed as it arrives, and is renamed into place only once its SHA-256 matches the pin in server/redis-build.mjs.
// Nothing here makes it executable or unpacks it: an unverified file is never run, and a file that fails is removed.
// A build already kept is hashed again before it’s trusted.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { REDIS } from './redis-build.mjs';
import { checkPlatform } from './redis-platform.mjs';

/** A build is a few tens of MB; past this, the download is refused rather than left to fill the disk. */
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * An error with a code to branch on, and its cause kept.
 * @param {string} code
 * @param {string} message
 * @param {unknown} [cause]
 */
const fail = (code, message, cause) => Object.assign(new Error(message, cause === undefined ? {} : { cause }), { code });

/**
 * The SHA-256 of a kept file, or null when there’s none.
 * @param {string} path
 */
async function hashOf(path) {
  const s = await stat(path).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!s) return null;
  if (!s.isFile()) throw fail('EISDIR', `${path} is in the way of Postbox’s Redis build, and isn’t a file. Move or remove it, then start Postbox again.`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Streams a response body to a new file, hashing it and refusing it past maxBytes. Returns its SHA-256.
 * @param {Response} res
 * @param {string} part  the temporary file, which must not exist yet
 * @param {string} url  for the messages
 * @param {number} maxBytes
 */
async function save(res, part, url, maxBytes) {
  const hash = createHash('sha256');
  let size = 0;
  const count = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) return done(fail('EDOWNLOAD', `The Redis build at ${url} is larger than ${maxBytes} bytes, so Postbox stopped downloading it.`));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), count, createWriteStream(part, { mode: 0o600, flags: 'wx' }));
  } catch (e) {
    if (e.code === 'EDOWNLOAD') throw e;
    throw fail('EDOWNLOAD', `Couldn’t download Redis from ${url}: ${e.message}. Check the network, then start Postbox again.`, e);
  }
  return hash.digest('hex');
}

/**
 * Makes sure this platform’s Redis build is under the data folder, verified, and says where.
 * @param {object} o
 * @param {string} o.dataDir  Postbox’s data folder; the build goes in redis/<version>/
 * @param {string} [o.platform]  `process.platform`, passed in by tests
 * @param {string} [o.arch]  `process.arch`, passed in by tests
 * @param {{ version: string, release: { url: string }, targets: Record<string, { asset: string, sha256: string | null }> }} [o.build]
 * @param {(url: string) => Promise<Response>} [o.fetch]
 * @param {number} [o.maxBytes]
 * @returns {Promise<{ path: string, sha256: string, downloaded: boolean }>}
 */
export async function fetchRedisBuild({
  dataDir,
  platform = process.platform,
  arch = process.arch,
  build = REDIS,
  fetch = globalThis.fetch,
  maxBytes = MAX_BYTES,
}) {
  const where = checkPlatform({ platform, arch });
  if (!where.ok) throw fail('EPLATFORM', where.message);
  const entry = Object.hasOwn(build.targets, where.target) ? build.targets[where.target] : null;
  if (!entry?.sha256)
    throw fail(
      'ENOPIN',
      `This Postbox release has no checksum for ${entry?.asset ?? where.target}, so it can’t download Redis. Update Postbox, then start it again.`,
    );
  const dir = join(dataDir, 'redis', build.version);
  const path = join(dir, entry.asset);
  if ((await hashOf(path)) === entry.sha256) return { path, sha256: entry.sha256, downloaded: false };

  const url = `${build.release.url}/${entry.asset}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw fail('EDOWNLOAD', `Couldn’t download Redis from ${url}: ${e.cause?.message ?? e.message}. Check the network, then start Postbox again.`, e);
  }
  if (!res.ok || !res.body) throw fail('EDOWNLOAD', `Couldn’t download Redis from ${url}: the server answered ${res.status}. Start Postbox again later.`);
  await mkdir(dir, { recursive: true });
  const part = join(dir, `.${entry.asset}.${randomBytes(6).toString('hex')}.part`);
  try {
    const got = await save(res, part, url, maxBytes);
    if (got !== entry.sha256)
      throw fail(
        'ECHECKSUM',
        `The Redis build from ${url} isn’t the one this Postbox release pins: its SHA-256 is ${got}, not ${entry.sha256}. Postbox removed it and won’t run it. Start Postbox again to retry; if it happens again, report it.`,
      );
    await rename(part, path);
    return { path, sha256: got, downloaded: true };
  } finally {
    await rm(part, { force: true });
  }
}
