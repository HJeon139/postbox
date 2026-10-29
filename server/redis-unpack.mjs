// Unpacks Postbox’s verified Redis build (designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and
// runs”, decision 2). The archive is a gzipped ustar file the build workflow makes (.github/workflows/redis.yml); it’s
// read in Node, so nothing is spawned. Its SHA-256 is checked again first. Every entry is checked before anything is
// written: only plain files and folders inside the build’s own top folder, never an absolute path, a “..”, a link or a
// device. The build goes to a temporary folder and is renamed into place, with its SHA-256 beside it, so a build half
// unpacked is never run, and the same archive isn’t unpacked twice.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { REDIS } from './redis-build.mjs';
import { fetchRedisBuild } from './redis-download.mjs';

/** @param {string} code @param {string} message @param {unknown} [cause] */
const fail = (code, message, cause) => Object.assign(new Error(message, cause === undefined ? {} : { cause }), { code });

/** @param {Buffer} h @param {number} at @param {number} len */
const field = (h, at, len) => h.toString('utf8', at, at + len).replace(/\0.*$/s, '');
/** @param {Buffer} h @param {number} at @param {number} len */
const octal = (h, at, len) => Number.parseInt(field(h, at, len).trim() || '0', 8);

/**
 * The entries of a ustar archive, checked. Throws EUNPACK naming the first refused entry.
 * @param {Buffer} tar  @param {string} top  the one top folder every entry must be in
 * @returns {{ path: string, dir: boolean, mode: number, body: Buffer }[]}
 */
export function readTar(tar, top) {
  const out = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) return out;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw fail('EUNPACK', `The Redis build’s archive is damaged at byte ${at}.`);
    const prefix = field(h, 345, 155);
    const name = (prefix ? `${prefix}/` : '') + field(h, 0, 100);
    const type = String.fromCharCode(h[156] || 48);
    const size = octal(h, 124, 12);
    const refuse = (why) => fail('EUNPACK', `Postbox refused the Redis build’s archive: “${name}” ${why}. It unpacked nothing.`);
    if (type !== '0' && type !== '5') throw refuse('isn’t a plain file or folder');
    if (name.startsWith('/') || name.split('/').includes('..')) throw refuse('points outside the build’s folder');
    const path = posix.normalize(name).replace(/\/$/, '');
    if (path !== top && !path.startsWith(`${top}/`)) throw refuse(`isn’t inside ${top}/`);
    if (at + 512 + size > tar.length) throw fail('EUNPACK', `The Redis build’s archive is cut off inside “${name}”.`);
    out.push({ path: path.slice(top.length + 1), dir: type === '5', mode: octal(h, 100, 8), body: tar.subarray(at + 512, at + 512 + size) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw fail('EUNPACK', 'The Redis build’s archive is cut off: it has no end.');
}

/**
 * Unpacks the build for this platform under the data folder and says where: the folder with bin/redis-server.
 * @param {{ path: string, sha256: string, dataDir: string, version: string, target: string }} o
 *   path and sha256 as server/redis-download.mjs verified them
 * @returns {Promise<string>}
 */
export async function unpackRedisBuild({ path, sha256, dataDir, version, target }) {
  const parent = join(dataDir, 'redis', version);
  const home = join(parent, target);
  const kept = await readFile(join(home, '.sha256'), 'utf8').catch(() => null);
  if (kept?.trim() === sha256) return home;
  const bytes = await readFile(path);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw fail('ECHECKSUM', `The Redis build at ${path} changed since it was verified (its SHA-256 is ${got}), so Postbox won’t unpack it.`);
  let tar;
  try {
    tar = gunzipSync(bytes);
  } catch (e) {
    throw fail('EUNPACK', `The Redis build’s archive is damaged: ${e.message}.`, e);
  }
  const entries = readTar(tar, `redis-${version}-${target}`);
  const part = join(parent, `.${target}.${randomBytes(6).toString('hex')}.part`);
  try {
    await mkdir(part, { recursive: true, mode: 0o700 });
    for (const e of entries) {
      const to = join(part, e.path);
      if (e.dir) await mkdir(to, { recursive: true, mode: 0o700 });
      else {
        await mkdir(join(to, '..'), { recursive: true, mode: 0o700 });
        await writeFile(to, e.body, { flag: 'wx' });
        // Private to the person (SR-5): executables and modules (Redis loads none without its execute bit) 0700, the rest 0600.
        await chmod(to, e.mode & 0o111 && (e.path.startsWith('bin/') || e.path.endsWith('.so')) ? 0o700 : 0o600);
      }
    }
    await writeFile(join(part, '.sha256'), `${sha256}\n`, { mode: 0o600 });
    await rm(home, { recursive: true, force: true });
    await rename(part, home);
    return home;
  } finally {
    await rm(part, { recursive: true, force: true });
  }
}

/**
 * The Redis home the store runs: POSTBOX_REDIS_HOME when it’s set (a build for development and tests, as
 * tests/AGENTS.md describes), else this platform’s pinned build, downloaded, verified and unpacked under the data folder.
 * @param {{ dataDir: string, env?: Record<string, string | undefined>, fetch?: (url: string) => Promise<Response>,
 *   build?: Parameters<typeof fetchRedisBuild>[0]['build'], platform?: string, arch?: string }} o
 */
export async function redisHome({ dataDir, env = process.env, fetch, build = REDIS, platform = process.platform, arch = process.arch }) {
  if (env.POSTBOX_REDIS_HOME) return env.POSTBOX_REDIS_HOME;
  const got = await fetchRedisBuild({ dataDir, build, platform, arch, ...(fetch ? { fetch } : {}) });
  return unpackRedisBuild({ path: got.path, sha256: got.sha256, dataDir, version: build.version, target: `${platform}-${arch}` });
}
