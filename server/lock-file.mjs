// How Postbox’s lock files are written and read, in one place (#2027): server/home.mjs (lockData, postbox.lock, for
// the command line) and server/store-lock.mjs (lockStore, store.lock, for the store) both publish a lock whole and
// read a bare pid by the same rule. store-lock’s publish is async over an injected fs/promises, so it keeps its own
// copy of publishWhole’s steps: a fix to one is a fix to the other.

import { randomBytes } from 'node:crypto';

/**
 * Publishes `text` as a file that never exists half-written: the bytes go to a draft of their own first, which is
 * then linked under `path` (atomic, and EEXIST when something is there), so a reader finds the whole text or no file.
 * A file made first and filled after reads as an empty, “dead” holder meanwhile (#2027).
 * @param {{ writeFileSync: typeof import('node:fs').writeFileSync, linkSync: typeof import('node:fs').linkSync, rmSync: typeof import('node:fs').rmSync }} io
 * @param {string} path @param {string} text
 */
export function publishWhole(io, path, text) {
  const draft = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.new`;
  io.writeFileSync(draft, text, { flag: 'wx', mode: 0o600 });
  try {
    io.linkSync(draft, path);
  } finally {
    io.rmSync(draft, { force: true });
  }
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
