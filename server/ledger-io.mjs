// How the work ledger (server/ledger.mjs) reads and writes the person’s files, and the blobs it keeps in memory when
// the runtime has no data folder. Moved from server/ledger.mjs, which exports nodeIo again.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
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
  /** Where a path leads, through links. */
  realPath: (path) => realpath(path),
  /**
   * Where a backend may keep its own folder, such as Claude Code’s claude-<uid>: Node’s temp folder, and off Windows the
   * real /tmp, where Claude Code writes even on a Mac, whose Node temp folder is under /var/folders.
   */
  tempRoots: () => (process.platform === 'win32' ? [tmpdir()] : [tmpdir(), '/tmp']),
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

/** Whether two snapshots of a file are the same: both absent, or the same content. */
export const sameSnap = (a, b) => Boolean(a?.exists) === Boolean(b?.exists) && (!a?.exists || (a.sha256 && a.sha256 === b?.sha256));
/** Whether a snapshot is known: absent, or its content kept. */
export const known = (s) => !s?.exists || Boolean(s.sha256);
/** An error with the HTTP status the page gets. */
export const fail = (status, message) => Object.assign(new Error(message), { status });

// The folder a backend keeps under the temp folder: Claude Code's claude or claude-<uid>.
const BACKEND_TEMP = /^claude(?:-[^/\\]*)?$/;

/** Each folder through its links, or null where it has none or can’t be resolved. @param {any} io @param {any[]} folders */
const realFolders = (io, folders) => Promise.all(folders.map((f) => (f ? io.realPath(f).catch(() => null) : null)));

/**
 * Whether `real` is inside a backend’s own folder directly under `temp`. Both have no links left, so that folder isn’t a
 * link, and a file with a backend’s name isn’t a folder.
 * @param {string} real @param {string | null} temp
 */
function inBackendFolder(real, temp) {
  if (!temp || !real.startsWith(temp + sep)) return false;
  const [folder, ...inside] = real.slice(temp.length + 1).split(sep);
  return inside.length > 0 && BACKEND_TEMP.test(folder);
}

/**
 * Where a background command's output file may be read from (#362): the backend's stream names the path, and Work shows
 * what's there to the person, so it's read only when it leads, through links, into the agent's folder, the project's,
 * or the backend's own folder under the temp folder. Anything else is null, and the command ends without its output.
 * @param {any} io @param {any} w  the turn's work @param {string} path  absolute
 * @returns {Promise<string | null>} the real path to read
 */
export async function outputFileAt(io, w, path) {
  const real = await io.realPath(path).catch(() => null);
  if (!real) return null;
  const roots = await realFolders(io, [w.folder, w.projectFolder]);
  if (roots.some((root) => root && real.startsWith(root + sep))) return real;
  const temps = await realFolders(io, io.tempRoots());
  return temps.some((temp) => inBackendFolder(real, temp)) ? real : null;
}
