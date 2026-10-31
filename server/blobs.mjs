// Content-addressed file storage for attachments. A file is stored once, under the SHA-256 of its bytes,
// and the event log keeps only its metadata. See designs/architecture.md, “Attachments”.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export class Blobs {
  /** @param {string} dir @param {{ open?: typeof open }} [io]  for tests: a seam where a file or folder handle is opened */
  constructor(dir, { open: openFile = open } = {}) {
    this.dir = dir;
    this.open = openFile;
  }

  pathOf(sha256) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Not a SHA-256 hash.');
    return join(this.dir, sha256.slice(0, 2), sha256.slice(2));
  }

  /**
   * Stores bytes and returns { sha256, size, path }. Storing the same bytes twice keeps one copy. A blob is published
   * whole or not at all: written to a draft beside it, synced, then renamed over its name, and the folder synced, so a
   * crash or a reader mid-write never finds a short file under the hash (a truncated one left by an older build is
   * replaced). Blobs can hold command lines and output, so they are the owner's alone: files 0600, folders 0700 (#305).
   */
  async put(buffer) {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const path = this.pathOf(sha256);
    const have = await stat(path).catch(() => null);
    if (have?.size === buffer.length) return { sha256, size: buffer.length, path };
    const folder = join(this.dir, sha256.slice(0, 2));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const draft = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.draft`;
    const fh = await this.open(draft, 'wx', 0o600);
    try {
      await fh.writeFile(buffer);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(draft, path).catch(async (e) => {
      await unlink(draft).catch(() => {});
      throw e;
    });
    // A platform that can't sync a folder says so with one of these; any other error (EIO) is a failed sync, and the
    // blob isn't durable, so it rejects.
    const dh = await this.open(folder, 'r');
    try {
      await dh.sync().catch((e) => {
        if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(e?.code)) throw e;
      });
    } finally {
      await dh.close();
    }
    return { sha256, size: buffer.length, path };
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
