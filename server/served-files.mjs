// Files Postbox serves from its folders by a request’s path, which can’t leave them, through links either: its own
// folders’ static files, and the data folder’s media. safeJoin, mediaFile, TYPES and file moved from server/index.mjs.

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { httpError } from './helpers.mjs';

const MEDIA_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

/**
 * A file in one of Postbox’s folders, by a request’s path, followed through links, which can’t lead out of it (#351).
 * Postbox’s own folders hold its code, but an agent at work in a clone of Postbox can write there, and /kit/ and /media/
 * answer any site’s script (access-control-allow-origin: *), so a link there to a file elsewhere would hand it out.
 * @param {string} dir @param {string} rel  the path after the route’s prefix, as the request sent it
 */
export async function servedFile(dir, rel) {
  const asked = safeJoin(dir, rel);
  // A folder that isn’t there (an installed package ships no mockups/) has nothing in it, and the folder itself is no file.
  const [root, real] = await Promise.all([dir, asked].map((p) => realpath(p).catch(() => null)));
  if (!root || !real || real === root) throw httpError(404, 'Not found.');
  if (!real.startsWith(root + sep)) throw httpError(403, 'That path isn’t allowed.');
  return real;
}

/** An image in the data folder’s media, followed through links, which can’t lead out of it. */
export async function mediaFile(dir, rel) {
  const isImage = (p) => MEDIA_TYPES.has(extname(p).toLowerCase());
  const real = await servedFile(dir, rel);
  if (!isImage(decodePath(rel)) || !isImage(real)) throw httpError(404, 'Not found.');
  return real;
}

/** /media/<rel>: the media that comes with Postbox, else the data folder’s media agents added (#90). */
export async function mediaPath(bundled, data, rel) {
  try {
    return { real: await servedFile(bundled, rel), bundled: true };
  } catch (e) {
    if (e.status !== 404) throw e;
    return { real: await mediaFile(data, rel), bundled: false };
  }
}

export function safeJoin(dir, rel) {
  const p = normalize(join(dir, decodePath(rel)));
  if (p !== dir && !p.startsWith(dir + sep)) throw httpError(403, 'That path isn’t allowed.');
  return p;
}

/** A path part as the request sent it, decoded; a malformed % escape is the request’s fault (400), not the server’s. */
export function decodePath(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    throw httpError(400, 'That address has a malformed % escape, so Postbox can’t read it. Check the link.');
  }
}

export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * How a served file is opened (#362): read-only, without following a link that replaced it after servedFile's check,
 * which fails with ELOOP (EMLINK on some BSDs), and never waiting on a FIFO swapped in for it. Where a platform has no
 * O_NOFOLLOW, the check after the open (stillThere) still refuses the swap.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Whether the file open is still the one servedFile checked at path (#362): path still resolves to itself, so no
 * folder on it became a link, and names the very file open (device and inode), as agent-files.mjs checks (#780).
 * @param {import('node:fs').BigIntStats} opened @param {string} path
 */
async function stillThere(opened, path) {
  if ((await realpath(path).catch(() => null)) !== path) return false;
  const at = await lstat(path, { bigint: true }).catch(() => null);
  return !!at && at.dev === opened.dev && at.ino === opened.ino;
}

/**
 * A served file's open handle and modification time: the file servedFile checked, for the caller to read and close, or a 404:
 * missing, not a file, or swapped meanwhile for a link, here or on a folder above it (#362).
 * @param {string} path  servedFile's result
 */
async function openedFile(path) {
  const fh = await open(path, OPEN_FLAGS).catch(() => {
    throw httpError(404, 'Not found.');
  });
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || !(await stillThere(st, path))) throw httpError(404, 'Not found.');
    return { fh, mtime: Number(st.mtimeMs) };
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/** A served file's cache entry, made from the bytes just read and kept by path and modification time. */
async function cachedEntry(path, mtime, data) {
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const compressible = /^(text\/|application\/json|image\/svg)/.test(type) && data.length > 1024;
  const entry = { mtime, data, type, etag: `"${createHash('sha1').update(data).digest('base64url')}"`, gz: compressible ? gzipSync(data) : null };
  staticCache.set(path, entry);
  return entry;
}

// Static files carry an ETag, so a reload revalidates cheaply (304) instead of downloading everything,
// and text is gzipped when the browser accepts it. Both are cached in memory by path and modification time.
const staticCache = new Map();
/** @param {import('node:http').ServerResponse} res @param {string} path @param {Record<string, string>} [headers] @param {import('node:http').IncomingMessage|null} [req] */
export async function file(res, path, headers = {}, req = null) {
  const { fh, mtime } = await openedFile(path);
  let entry = staticCache.get(path);
  try {
    if (!entry || entry.mtime !== mtime) entry = await cachedEntry(path, mtime, await fh.readFile());
  } finally {
    await fh.close();
  }
  const base = {
    'content-type': entry.type,
    'cache-control': 'no-cache',
    etag: entry.etag,
    'x-content-type-options': 'nosniff',
    vary: 'accept-encoding',
    ...headers,
  };
  if (req?.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, base);
    res.end();
    return;
  }
  const gzip = entry.gz && /\bgzip\b/.test(req?.headers['accept-encoding'] ?? '');
  res.writeHead(200, { ...base, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
  res.end(gzip ? entry.gz : entry.data);
}
