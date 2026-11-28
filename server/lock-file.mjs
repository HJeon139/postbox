// How Postbox’s lock files are written and read, in one place (#2027): server/home.mjs (lockData, postbox.lock, for
// the command line) and server/store-lock.mjs (lockStore, store.lock, for the store) both publish a lock whole and
// read a bare pid by the same rule. store-lock’s publish is async over an injected fs/promises, so it keeps its own
// copy of publishWhole’s steps: a fix to one is a fix to the other.

import { randomBytes } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Publishes `text` as a file that never exists half-written: the bytes go to a draft of their own first, which is
 * then linked under `path` (atomic, and EEXIST when something is there), so a reader finds the whole text or no file.
 * A file made first and filled after reads as an empty, “dead” holder meanwhile (#2027).
 * @param {{ writeFileSync: typeof import('node:fs').writeFileSync, linkSync: typeof import('node:fs').linkSync, rmSync: typeof import('node:fs').rmSync }} io
 * @param {string} path @param {string} text
 */
export function publishWhole(io, path, text) {
  const draft = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.new`;
  try {
    io.writeFileSync(draft, text, { flag: 'wx', mode: 0o600 }); // inside: a write that fails after the open leaves the file
    try {
      io.linkSync(draft, path);
    } catch (e) {
      throw linkError(e, path);
    }
  } finally {
    io.rmSync(draft, { force: true });
  }
}

/** What link(2) says on a disk with no hard links: a FAT or exFAT volume, some network and FUSE filesystems. */
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS']);

/**
 * The error to raise for a failed link: a refusal for want of hard links becomes one that says what to do, and any
 * other error is raised as is. Without hard links no lock can be published whole, so the start refuses rather than
 * risk two servers on one folder.
 * @param {any} e @param {string} path  the lock being published, in the data folder @returns {Error}
 */
export function linkError(e, path) {
  if (!NO_HARD_LINKS.has(e?.code)) return e;
  return new Error(
    `${dirname(path)} is on a disk that doesn’t support hard links (link failed with ${e.code}), which Postbox needs to lock its data folder. Start it with --data <a folder on another disk>.`,
    { cause: e },
  );
}

/**
 * The pid a lock written as a bare number holds, or null when it holds anything else: empty, cut short, `0`, a
 * leading zero, or a number past the safe integers. Unreadable contents prove nothing about the holder.
 * @param {string} text @returns {number | null}
 */
export function readPid(text) {
  const trimmed = text.trim();
  const pid = Number(trimmed);
  return /^[1-9]\d*$/.test(trimmed) && Number.isSafeInteger(pid) ? pid : null;
}

/** A `*.new` draft older than this was left by a start that died between its write and its link. */
export const DRAFT_STALE_MS = 10_000;

/**
 * Removes stale drafts of a lock (and of its takeover file) from `dir`, once the lock is held; a fresh one may belong
 * to a starter mid-publish and is left. A leftover breaks nothing, but --move-data refuses a home folder with files.
 * @param {string} dir @param {string} lockName  the lock file’s name, which every draft of it starts with
 */
export function sweepDrafts(dir, lockName) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return; // the folder is gone or unreadable: nothing to sweep, and the lock is already held
  }
  for (const name of names) {
    if (!name.startsWith(lockName) || !name.endsWith('.new')) continue;
    try {
      if (Date.now() - statSync(join(dir, name)).mtimeMs > DRAFT_STALE_MS) rmSync(join(dir, name), { force: true });
    } catch {
      // removed by its own starter meanwhile
    }
  }
}
