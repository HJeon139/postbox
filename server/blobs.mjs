// Content-addressed file storage for attachments. A file is stored once, under the SHA-256 of its bytes,
// and the event log keeps only its metadata. See designs/architecture/assets.md, “Attachments”.

import { createHash, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export class Blobs {
  /** @param {string} dir @param {{ open?: typeof open }} [io]  for tests: a seam where a file or folder handle is opened */
  constructor(dir, { open: openFile = open } = {}) {
    this.dir = dir;
    this.open = openFile;
    // Bytes a call stores before it knows it keeps them (#780, a review’s images), by SHA-256: how many staged puts
    // hold each, which of those a call or any other put kept, and the ones being removed, which a put waits out.
    /** @type {Map<string, number>} */ this.held = new Map();
    /** @type {Set<string>} */ this.kept = new Set();
    /** @type {Map<string, Promise<void>>} */ this.dropping = new Map();
    // Ordinary puts in flight, by SHA-256: a refused staged call never removes bytes one of them is writing or wrote.
    /** @type {Map<string, number>} */ this.writing = new Map();
  }

  pathOf(sha256) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Not a SHA-256 hash.');
    return join(this.dir, sha256.slice(0, 2), sha256.slice(2));
  }

  /**
   * The blob at a path ending in `ext`, for an agent whose backend reads a file by its extension (#1307): a hard link
   * in the store’s typed folder, made once, so it’s the same bytes and takes no more space. With no extension, or when
   * the link can’t be made, its own path. Sync, as attachmentPath is (server/message-attachments.mjs).
   * @param {string} sha256 @param {string} ext  such as .png
   */
  typedPathOf(sha256, ext) {
    const blob = this.pathOf(sha256);
    if (!/^\.[A-Za-z0-9]{1,12}$/.test(ext)) return blob;
    const typed = join(this.dir, 'typed', sha256 + ext);
    try {
      mkdirSync(join(this.dir, 'typed'), { recursive: true, mode: 0o700 });
      linkSync(blob, typed);
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') return blob;
    }
    return typed;
  }

  /**
   * Stores bytes and returns { sha256, size, path }. Storing the same bytes twice keeps one copy. A blob is published
   * whole or not at all: written to a draft beside it, synced, then renamed over its name, and the folder synced, so a
   * crash or a reader mid-write never finds a short file under the hash (a truncated one left by an older build is
   * replaced). Blobs can hold command lines and output, so they are the owner’s alone: files 0600, folders 0700 (#305).
   * A staged put (#780) is settled once its call is known to keep it or not (settle); fresh says this put wrote it.
   * @param {Buffer} buffer @param {{ staged?: boolean }} [opts]
   */
  async put(buffer, { staged = false } = {}) {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    // Before any await, so a staged put of the same bytes that’s refused meanwhile can’t remove what this one keeps.
    if (staged) this.held.set(sha256, (this.held.get(sha256) ?? 0) + 1);
    else this.writing.set(sha256, (this.writing.get(sha256) ?? 0) + 1);
    try {
      return await this.write(sha256, buffer);
    } catch (e) {
      if (staged) await this.settle([{ sha256, fresh: false }], false);
      throw e;
    } finally {
      if (!staged) this.wrote(sha256);
    }
  }

  /** An ordinary put is done: a staged call holding the same bytes now keeps them whatever it settles. @param {string} sha256 */
  wrote(sha256) {
    const left = (this.writing.get(sha256) ?? 1) - 1;
    if (left > 0) this.writing.set(sha256, left);
    else this.writing.delete(sha256);
    if (this.held.has(sha256)) this.kept.add(sha256);
  }

  /** put’s write, once the bytes are hashed. @param {string} sha256 @param {Buffer} buffer */
  async write(sha256, buffer) {
    await this.dropping.get(sha256);
    const path = this.pathOf(sha256);
    const folder = join(this.dir, sha256.slice(0, 2));
    const have = await stat(path).catch(() => null);
    // The file is already whole, but an earlier put of it may have failed at the folder sync after the rename, so its
    // name may not be durable yet: sync the folder before saying it is here.
    if (have?.size === buffer.length) {
      await this.syncFolder(folder);
      return { sha256, size: buffer.length, path, fresh: false };
    }
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const draft = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.draft`;
    try {
      const fh = await this.open(draft, 'wx', 0o600);
      try {
        await fh.writeFile(buffer);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(draft, path);
    } catch (e) {
      // Any failure before the rename leaves no draft: a full disk retries on every turn’s end, and each try would
      // otherwise leave one more.
      await unlink(draft).catch(() => {});
      throw e;
    }
    await this.syncFolder(folder);
    return { sha256, size: buffer.length, path, fresh: true };
  }

  /**
   * Settles a call’s staged puts (#780): kept, they stay; refused, each blob one of them wrote is removed, unless
   * another put still holds it or kept it. O(the call’s puts).
   * @param {{ sha256: string, fresh: boolean }[]} puts @param {boolean} keep
   */
  async settle(puts, keep) {
    /** @type {Map<string, { n: number, fresh: boolean }>} */
    const bySha = new Map();
    for (const { sha256, fresh } of puts) {
      const seen = bySha.get(sha256) ?? { n: 0, fresh: false };
      bySha.set(sha256, { n: seen.n + 1, fresh: seen.fresh || fresh });
    }
    for (const [sha256, { n, fresh }] of bySha) {
      if (keep) this.kept.add(sha256);
      const left = (this.held.get(sha256) ?? n) - n;
      if (left > 0) {
        this.held.set(sha256, left);
        continue;
      }
      this.held.delete(sha256);
      const keptBySomeone = this.kept.delete(sha256);
      if (keptBySomeone || !fresh || this.writing.has(sha256)) continue;
      const gone = unlink(this.pathOf(sha256)).catch(() => {});
      this.dropping.set(sha256, gone);
      await gone;
      this.dropping.delete(sha256);
    }
  }

  /** Syncs a folder so a rename in it is durable. A platform that can’t says so with one of these codes; any other is a failed sync. @param {string} folder */
  async syncFolder(folder) {
    const dh = await this.open(folder, 'r');
    try {
      await dh.sync().catch((e) => {
        if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(e?.code)) throw e;
      });
    } finally {
      await dh.close();
    }
  }

  /** Reads bytes back and checks they still match their hash. */
  async get(sha256) {
    const buf = await readFile(this.pathOf(sha256));
    if (createHash('sha256').update(buf).digest('hex') !== sha256) throw new Error('This file is damaged: its contents no longer match its hash.');
    return buf;
  }
}

// Only these are shown inline; everything else downloads. The app reads the same list to show thumbnails.
export { INLINE_TYPES } from '../shared/files.mjs';
