// How the work ledger (server/ledger.mjs) reads and writes the person’s files, and the blobs it keeps in memory when
// the runtime has no data folder. Moved from server/ledger.mjs, which exports nodeIo again.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { MAX_FILE_BYTES } from '../shared/work.mjs';

/**
 * How the ledger reads and writes the person’s files. Tests pass the same shape over a temp folder.
 * A read is { exists: false }, or { exists: true, size, bytes } (bytes left out past MAX_FILE_BYTES: big), or
 * { exists: true, unreadable } when it couldn’t be read.
 */
export const nodeIo = {
  /** Synchronous, so it runs before the tool that’s about to change the file. */
  readNow(path) {
    try {
      const st = statSync(path);
      if (!st.isFile()) return { exists: false };
      if (st.size > MAX_FILE_BYTES) return { exists: true, size: st.size, big: true };
      return { exists: true, size: st.size, bytes: readFileSync(path) };
    } catch (e) {
      return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? { exists: false } : { exists: true, unreadable: e.message };
    }
  },
  async read(path) {
    try {
      const st = await stat(path);
      if (!st.isFile()) return { exists: false };
      if (st.size > MAX_FILE_BYTES) return { exists: true, size: st.size, big: true };
      return { exists: true, size: st.size, bytes: await readFile(path) };
    } catch (e) {
      return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? { exists: false } : { exists: true, unreadable: e.message };
    }
  },
  /** The last `max` bytes of a file, and whether earlier ones were cut. */
  async readTail(path, max) {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const n = Math.min(size, max);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, size - n);
      return { bytes: buf, cut: size > n };
    } finally {
      await fh.close();
    }
  },
  /** Writes beside the file, then renames over it, keeping its mode. */
  async writeAtomic(path, bytes) {
    const mode = (await stat(path).catch(() => null))?.mode;
    const tmp = join(dirname(path), `.${basename(path)}.postbox-${randomBytes(4).toString('hex')}`);
    await writeFile(tmp, bytes, mode ? { mode } : {});
    try {
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  },
  async remove(path) {
    await rm(path, { force: true });
  },
};

/** Blobs kept in memory, for a runtime without a data folder (tests). */
export function memoryBlobs() {
  const m = new Map();
  return {
    async put(buf) {
      const sha256 = createHash('sha256').update(buf).digest('hex');
      m.set(sha256, Buffer.from(buf));
      return { sha256, size: buf.length };
    },
    async get(sha256) {
      if (!m.has(sha256)) throw new Error('That copy isn’t kept any more.');
      return m.get(sha256);
    },
  };
}
